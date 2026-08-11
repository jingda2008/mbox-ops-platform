#!/usr/bin/env bash
set -Eeuo pipefail

input=${1:?JSONL input is required}
project=${MBOX_SLS_PROJECT:-mbox-validation-139224254060}
endpoint=${MBOX_SLS_ENDPOINT:-cn-shanghai-internal.log.aliyuncs.com}
profile=${MBOX_ALIYUN_PROFILE:-mbox-ecs-role}
dry_run=${MBOX_SLS_DRY_RUN:-0}

case "${endpoint}" in *-internal.log.aliyuncs.com) ;; *) echo 'SLS requires the Shanghai internal endpoint' >&2; exit 1 ;; esac
if env | grep -Eq '^(ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET)='; then
  echo 'long-lived cloud credential environment variables are forbidden' >&2
  exit 1
fi
test -f "${input}"

sent=0
while IFS= read -r event; do
  [ -n "${event}" ] || continue
  logstore=$(jq -er '.logstore' <<<"${event}")
  case "${logstore}" in runtime-errors|payment-audit|release-audit) ;; *) echo 'unapproved SLS logstore' >&2; exit 1 ;; esac
  jq -e 'type == "object"' <<<"${event}" >/dev/null
  sent=$((sent + 1))
done < "${input}"

for logstore in runtime-errors payment-audit release-audit; do
  mapfile -t payloads < <(
    jq -c \
      --arg logstore "${logstore}" \
      'select(.logstore == $logstore) | del(.logstore) + {__time__: ((try (.timestamp | fromdateiso8601) catch now) | floor | tostring)}' \
      "${input}"
  )
  [ "${#payloads[@]}" -gt 0 ] || continue
  if [ "${dry_run}" != 1 ]; then
    aliyun --profile "${profile}" sls put-json-logs \
      --endpoint "${endpoint}" \
      --project "${project}" \
      --logstore "${logstore}" \
      --topic mbox-selective-audit \
      --source ecs-validation \
      --logs "${payloads[@]}" >/dev/null
  fi
done
printf 'sls_send=%s\nevents=%s\nproject=%s\nendpoint=%s\n' "$([ "${dry_run}" = 1 ] && echo dry-run || echo complete)" "${sent}" "${project}" "${endpoint}"
