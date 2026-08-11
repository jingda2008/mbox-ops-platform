#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
project=${MBOX_SLS_PROJECT:-mbox-validation-139224254060}
endpoint=${MBOX_SLS_ENDPOINT:-cn-shanghai-internal.log.aliyuncs.com}
profile=${MBOX_ALIYUN_PROFILE:-mbox-ecs-role}
report=${MBOX_CLOUD_VERIFY_REPORT:-${repo_root}/.runtime/aliyun-evidence-services-verification.json}
marker="oss-sls-test-$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary=$(mktemp -d)
trap 'rm -rf "${temporary}"' EXIT

case "${endpoint}" in *-internal.log.aliyuncs.com) ;; *) exit 1 ;; esac
test -n "$(curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/ram/security-credentials/)"

printf 'validation\n' > "${temporary}/probe.txt"
(
  cd "${temporary}"
  sha256sum probe.txt > SHA256SUMS
)
MBOX_OSS_VERIFICATION_REPORT="${temporary}/../oss-probe-verification.json" \
  "${repo_root}/deploy/aliyun/upload-oss-verified.sh" "${temporary}" "mbox/evidence/temp/cloud-probe/${marker}"

jq -nc \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg requestId "${marker}" \
  '{timestamp:$timestamp,eventType:"payment_exception",severity:"warning",outcome:"synthetic-verification",requestId:$requestId,logstore:"payment-audit"}' \
  > "${temporary}/sls-probe.jsonl"
"${repo_root}/deploy/aliyun/send-sls-events.sh" "${temporary}/sls-probe.jsonl" >/dev/null

found=0
query_result=${temporary}/query.json
for _ in $(seq 1 12); do
  from=$(( $(date +%s) - 300 ))
  to=$(( $(date +%s) + 60 ))
  aliyun --profile "${profile}" sls get-logs-v2 \
    --endpoint "${endpoint}" --project "${project}" --logstore payment-audit \
    --from "${from}" --to "${to}" --query "requestId:${marker}" --line 10 --reverse true \
    > "${query_result}"
  if grep -Fq "${marker}" "${query_result}"; then found=1; break; fi
  sleep 5
done
test "${found}" = 1

install -d -m 0700 "$(dirname "${report}")"
jq -n \
  --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg project "${project}" --arg endpoint "${endpoint}" \
  --arg markerHash "$(printf %s "${marker}" | sha256sum | awk '{print $1}')" \
  --slurpfile oss "${temporary}/../oss-probe-verification.json" \
  '{schemaVersion:1,verifiedAt:$verifiedAt,ossUploadDownloadSha256Verified:$oss[0].verified,slsProject:$project,slsEndpoint:$endpoint,slsSyntheticEventFound:true,markerSha256:$markerHash,containsRealPayment:false,verified:true}' \
  > "${report}"
chmod 0600 "${report}"
printf 'cloud_evidence_services=verified\nreport=%s\n' "${report}"
