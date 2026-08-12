#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
desired=${MBOX_SLS_DESIRED_STATE:-${repo_root}/deploy/aliyun/evidence/sls-desired-state.json}
lifecycle=${MBOX_OSS_LIFECYCLE:-${repo_root}/deploy/aliyun/evidence/oss-lifecycle.xml}
bucket=${MBOX_OSS_BUCKET:-m-box}
region=${MBOX_OSS_REGION:-cn-shanghai}
oss_endpoint=${MBOX_OSS_ENDPOINT:-oss-cn-shanghai-internal.aliyuncs.com}
sls_endpoint=${MBOX_SLS_ENDPOINT:-cn-shanghai-internal.log.aliyuncs.com}
profile=${MBOX_ALIYUN_PROFILE:-mbox-ecs-role}
report=${MBOX_CLOUD_BOOTSTRAP_REPORT:-${repo_root}/.runtime/aliyun-evidence-bootstrap.json}

test -f "${desired}"
test -f "${lifecycle}"
test "$(jq -r .region "${desired}")" = "${region}"
test "$(jq -r .endpoint "${desired}")" = "${sls_endpoint}"
case "${oss_endpoint}" in *-internal.aliyuncs.com) ;; *) echo 'OSS endpoint must be internal' >&2; exit 1 ;; esac
case "${sls_endpoint}" in *-internal.log.aliyuncs.com) ;; *) echo 'SLS endpoint must be internal' >&2; exit 1 ;; esac
if env | grep -Eq '^(OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET)='; then
  echo 'long-lived cloud credential environment variables are forbidden' >&2
  exit 1
fi
command -v ossutil >/dev/null
command -v aliyun >/dev/null
command -v jq >/dev/null

role_name=$(curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/ram/security-credentials/)
test -n "${role_name}"
oss_options=(--quiet --mode EcsRamRole --region "${region}" --endpoint "${oss_endpoint}")
aliyun configure set --profile "${profile}" --mode EcsRamRole --ram-role-name "${role_name}" --region "${region}" >/dev/null
aliyun_cli=(aliyun --profile "${profile}")
"${aliyun_cli[@]}" sts get-caller-identity >/dev/null

# The bucket already exists. Bootstrap never creates a similarly named duplicate.
# get-bucket-info proves ownership, location and management access without
# requiring the broader GetBucketStat permission.
bucket_info=$(ossutil api get-bucket-info --bucket "${bucket}" --output-format json "${oss_options[@]}")
bucket_location=$(jq -r '.Bucket.Location // .BucketInfo.Location // .Location // empty' <<<"${bucket_info}")
test "${bucket_location#oss-}" = "${region}"
ossutil api put-bucket-acl --bucket "${bucket}" --acl private "${oss_options[@]}" >/dev/null
ossutil api put-bucket-public-access-block --bucket "${bucket}" \
  --public-access-block-configuration '{"BlockPublicAccess":"true"}' "${oss_options[@]}" >/dev/null
ossutil api put-bucket-encryption --bucket "${bucket}" \
  --server-side-encryption-rule '{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}' \
  "${oss_options[@]}" >/dev/null
ossutil api put-bucket-versioning --bucket "${bucket}" \
  --versioning-configuration '{"Status":"Enabled"}' "${oss_options[@]}" >/dev/null

existing_lifecycle=$(mktemp)
trap 'rm -f "${existing_lifecycle}" "${worm_check:-}"' EXIT
if ossutil api get-bucket-lifecycle --bucket "${bucket}" --output-format json \
  "${oss_options[@]}" >"${existing_lifecycle}" 2>/dev/null; then
  managed_ids=$(jq '[((.LifecycleConfiguration.Rule // .Rule // []) | if type == "array" then .[] else . end) | select(.ID | startswith("mbox-"))] | length' "${existing_lifecycle}")
  all_ids=$(jq '[((.LifecycleConfiguration.Rule // .Rule // []) | if type == "array" then .[] else . end)] | length' "${existing_lifecycle}")
  if [ "${managed_ids}" -ne "${all_ids}" ]; then
    echo 'existing OSS lifecycle rules are not exclusively managed by MBOX; refusing to overwrite them' >&2
    exit 1
  fi
fi
ossutil api put-bucket-lifecycle --bucket "${bucket}" \
  --lifecycle-configuration "file://${lifecycle}" "${oss_options[@]}" >/dev/null

project=$(jq -r .project "${desired}")
if ! "${aliyun_cli[@]}" sls get-project --endpoint "${sls_endpoint}" --project "${project}" >/dev/null 2>&1; then
  "${aliyun_cli[@]}" sls create-project --endpoint "${sls_endpoint}" \
    --project-name "${project}" --description 'MBOX validation selective operational audit logs' \
    --recycle-bin-enabled true >/dev/null
fi

project_ready=0
for _ in $(seq 1 24); do
  if "${aliyun_cli[@]}" sls get-project --endpoint "${sls_endpoint}" --project "${project}" >/dev/null 2>&1; then
    project_ready=1
    break
  fi
  sleep 5
done
if [ "${project_ready}" != 1 ]; then
  echo "SLS project did not become ready within 120 seconds: ${project}" >&2
  exit 1
fi

while IFS= read -r store; do
  name=$(jq -r .name <<<"${store}")
  ttl=$(jq -r .ttlDays <<<"${store}")
  shards=$(jq -r .shards <<<"${store}")
  logstore_state=$(mktemp)
  if ! "${aliyun_cli[@]}" sls get-log-store --endpoint "${sls_endpoint}" \
    --project "${project}" --logstore "${name}" >"${logstore_state}" 2>/dev/null; then
    "${aliyun_cli[@]}" sls create-log-store --endpoint "${sls_endpoint}" \
      --project "${project}" --logstore-name "${name}" --ttl "${ttl}" \
      --shard-count "${shards}" --auto-split false --biz-mode standard \
      --append-meta false --enable-tracking false >/dev/null
  fi

  logstore_ready=0
  for _ in $(seq 1 12); do
    if "${aliyun_cli[@]}" sls get-log-store --endpoint "${sls_endpoint}" \
      --project "${project}" --logstore "${name}" >"${logstore_state}" 2>/dev/null; then
      logstore_ready=1
      break
    fi
    sleep 5
  done
  if [ "${logstore_ready}" != 1 ]; then
    echo "SLS Logstore did not become ready within 60 seconds: ${name}" >&2
    rm -f "${logstore_state}"
    exit 1
  fi
  actual_ttl=$(jq -er '.ttl // .TTL // .data.ttl' "${logstore_state}")
  actual_shards=$(jq -er '.shardCount // .ShardCount // .data.shardCount' "${logstore_state}")
  actual_auto_split=$(jq -r 'if has("autoSplit") then .autoSplit elif has("AutoSplit") then .AutoSplit else .data.autoSplit end' "${logstore_state}")
  rm -f "${logstore_state}"
  if [ "${actual_ttl}" != "${ttl}" ] || [ "${actual_shards}" != "${shards}" ] || [ "${actual_auto_split}" != false ]; then
    printf 'SLS Logstore configuration mismatch: %s (ttl=%s/%s shards=%s/%s autoSplit=%s/false)\n' \
      "${name}" "${actual_ttl}" "${ttl}" "${actual_shards}" "${shards}" "${actual_auto_split}" >&2
    exit 1
  fi
  keys=$(jq -c '.indexedFields | with_entries(.value = if .value == "text" then {type:"text",doc_value:true,alias:"",caseSensitive:false,chn:false,token:[","," ",";","=","(",")","[","]","{","}",":","\n","\t","\r"]} else {type:.value,doc_value:true,alias:""} end)' <<<"${store}")
  if "${aliyun_cli[@]}" sls get-index --endpoint "${sls_endpoint}" --project "${project}" --logstore "${name}" >/dev/null 2>&1; then
    "${aliyun_cli[@]}" sls update-index --endpoint "${sls_endpoint}" --project "${project}" --logstore "${name}" --keys "${keys}" >/dev/null
  else
    "${aliyun_cli[@]}" sls create-index --endpoint "${sls_endpoint}" --project "${project}" --logstore "${name}" --keys "${keys}" >/dev/null
  fi
done < <(jq -c '.logstores[]' "${desired}")

acl=$(ossutil api get-bucket-acl --bucket "${bucket}" --output-format json "${oss_options[@]}")
versioning=$(ossutil api get-bucket-versioning --bucket "${bucket}" --output-format json "${oss_options[@]}")
encryption=$(ossutil api get-bucket-encryption --bucket "${bucket}" --output-format json "${oss_options[@]}")
public_block=$(ossutil api get-bucket-public-access-block --bucket "${bucket}" --output-format json "${oss_options[@]}")
lifecycle_result=$(ossutil api get-bucket-lifecycle --bucket "${bucket}" --output-format json "${oss_options[@]}")
worm_check=$(mktemp)
if ossutil api get-bucket-worm --bucket "${bucket}" --output-format json "${oss_options[@]}" >"${worm_check}" 2>&1; then
  echo 'bucket WORM is enabled; refusing to claim the validation bucket is unlocked' >&2
  exit 1
fi
grep -Eqi '404|NoSuch.*Worm|not exist' "${worm_check}"
test "$(jq -r '.AccessControlList.Grant // .Bucket.AccessControlList.Grant // empty' <<<"${acl}")" = private
test "$(jq -r '.VersioningConfiguration.Status // .Status' <<<"${versioning}")" = Enabled
test "$(jq -r '.ServerSideEncryptionRule.ApplyServerSideEncryptionByDefault.SSEAlgorithm // .ServerSideEncryptionRule.SSEAlgorithm // .ApplyServerSideEncryptionByDefault.SSEAlgorithm // .SSEAlgorithm // empty' <<<"${encryption}")" = AES256
test "$(jq -r '.PublicAccessBlockConfiguration.BlockPublicAccess // .BlockPublicAccess // empty' <<<"${public_block}")" = true

install -d -m 0700 "$(dirname "${report}")"
jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg region "${region}" --arg bucket "${bucket}" --arg bucketLocation "${bucket_location}" --arg ossEndpoint "${oss_endpoint}" \
  --arg slsEndpoint "${sls_endpoint}" --arg project "${project}" --arg roleName "${role_name}" \
  --argjson costControls "$(jq '.costControls' "${desired}")" \
  --argjson lifecycleRuleCount "$(jq '[((.LifecycleConfiguration.Rule // .Rule // []) | if type == "array" then .[] else . end)] | length' <<<"${lifecycle_result}")" \
  --argjson logstores "$(jq '[.logstores[] | {name,ttlDays,shards,indexedFields:(.indexedFields|keys)}]' "${desired}")" \
  '{schemaVersion:1,generatedAt:$generatedAt,region:$region,roleName:$roleName,oss:{bucket:$bucket,location:$bucketLocation,endpoint:$ossEndpoint,acl:"private",blockPublicAccess:true,encryption:"SSE-OSS/AES256",versioning:"Enabled",lifecycleRuleCount:$lifecycleRuleCount,worm:false},sls:{project:$project,endpoint:$slsEndpoint,logstores:$logstores,costControls:$costControls},verified:true}' \
  > "${report}"
chmod 0600 "${report}"
printf 'aliyun_evidence_services=verified\nreport=%s\n' "${report}"
