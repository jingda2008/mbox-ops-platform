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
sanitized_input=$(mktemp)
trap 'rm -f "${sanitized_input}"' EXIT
: > "${sanitized_input}"
while IFS= read -r event; do
  [ -n "${event}" ] || continue
  logstore=$(jq -er '.logstore' <<<"${event}")
  case "${logstore}" in runtime-errors|payment-audit|release-audit) ;; *) echo 'unapproved SLS logstore' >&2; exit 1 ;; esac
  jq -e 'type == "object"' <<<"${event}" >/dev/null
  jq -cer '
    def scalar: type == "string" or type == "number" or type == "boolean";
    def retain($keys): with_entries(select((.key | IN($keys[])) and (.value | scalar)));
    def contains_sensitive:
      test("LTAI[A-Za-z0-9]{12,}")
      or test("sk-[A-Za-z0-9._-]{20,}")
      or test("Bearer[[:space:]]+[A-Za-z0-9._~-]{20,}"; "i")
      or test("(token|access_token|authorization)[=:][A-Za-z0-9._~-]{12,}"; "i")
      or test("postgres(ql)?://[^[:space:]@/]+:[^[:space:]@/]+@"; "i")
      or test("(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)")
      or test("(^|[^0-9])[0-9]{17}[0-9Xx]([^0-9]|$)");
    def safe_string($name; $maximum):
      if type != "string" or length < 1 or length > $maximum then error($name + " is invalid")
      elif contains_sensitive then error("sensitive SLS value rejected for " + $name)
      else . end;
    def validate_value:
      if .key == "timestamp" then
        .value |= (safe_string("timestamp"; 40)
          | if test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$") then . else error("timestamp is invalid") end)
      elif .key == "eventType" then
        .value |= (safe_string("eventType"; 64)
          | if test("^[a-z][a-z0-9_]{2,63}$") then . else error("eventType is invalid") end)
      elif .key == "severity" then
        .value |= (if type == "string" and IN("info", "warning", "error") then . else error("severity is invalid") end)
      elif .key == "statusCode" then
        .value |= (if type == "number" and floor == . and . >= 100 and . <= 599 then . else error("statusCode is invalid") end)
      elif .key == "durationMs" then
        .value |= (if type == "number" and . >= 0 and . <= 86400000 then . else error("durationMs is invalid") end)
      elif .key == "route" then
        .value |= (if type == "string" and length >= 1 and length <= 1024 then split("?")[0] else error("route is invalid") end
          | safe_string("route"; 256)
          | if startswith("/") then . else error("route is invalid") end)
      elif .key == "releaseSha" then
        .value |= (safe_string("releaseSha"; 64)
          | if test("^[0-9a-f]{7,64}$") then . else error("releaseSha is invalid") end)
      elif .key == "imageDigest" then
        .value |= (safe_string("imageDigest"; 80)
          | if test("^sha256:[0-9a-f]{64}$") then . else error("imageDigest is invalid") end)
      elif .key == "fingerprint" then
        .value |= (safe_string("fingerprint"; 64)
          | if test("^[0-9a-f]{64}$") then . else error("fingerprint is invalid") end)
      elif .key == "requestId" then .value |= safe_string("requestId"; 96)
      elif .key == "container" then .value |= safe_string("container"; 96)
      elif .key == "code" then .value |= safe_string("code"; 96)
      elif .key == "outcome" then .value |= safe_string("outcome"; 96)
      elif .key == "actorId" then .value |= safe_string("actorId"; 96)
      elif .key == "operation" then .value |= safe_string("operation"; 128)
      else . end;
    def sanitize($keys):
      retain($keys) | with_entries(validate_value)
      | if has("logstore") and has("timestamp") and has("eventType") and has("severity") then .
        else error("required SLS event field is missing") end;
    if .logstore == "runtime-errors" then
      sanitize(["logstore","timestamp","eventType","severity","statusCode","route","code","container","outcome","durationMs","releaseSha","requestId","fingerprint"])
    elif .logstore == "payment-audit" then
      sanitize(["logstore","timestamp","eventType","severity","statusCode","route","code","outcome","requestId","releaseSha","fingerprint"])
    elif .logstore == "release-audit" then
      sanitize(["logstore","timestamp","eventType","severity","code","outcome","releaseSha","imageDigest","actorId","operation","fingerprint"])
    else error("unapproved SLS logstore") end
  ' <<<"${event}" >> "${sanitized_input}"
  sent=$((sent + 1))
done < "${input}"

for logstore in runtime-errors payment-audit release-audit; do
  mapfile -t payloads < <(
    jq -c \
      --arg logstore "${logstore}" \
      'select(.logstore == $logstore) | del(.logstore) + {__time__: ((try (.timestamp | fromdateiso8601) catch now) | floor | tostring)}' \
      "${sanitized_input}"
  )
  [ "${#payloads[@]}" -gt 0 ] || continue
  if [ "${dry_run}" != 1 ]; then
    # aliyun-cli-sls 0.7.4 declares --logs as a list. Its parser expects one
    # JSON array whose members are JSON-encoded log strings, even though the
    # generated help shows repeated object arguments.
    payload_list=$(printf '%s\n' "${payloads[@]}" | jq -cs 'map(tojson)')
    aliyun --profile "${profile}" sls put-json-logs \
      --endpoint "${endpoint}" \
      --project "${project}" \
      --logstore "${logstore}" \
      --topic mbox-selective-audit \
      --source ecs-validation \
      --logs "${payload_list}" >/dev/null
  fi
done
printf 'sls_send=%s\nevents=%s\nproject=%s\nendpoint=%s\n' "$([ "${dry_run}" = 1 ] && echo dry-run || echo complete)" "${sent}" "${project}" "${endpoint}"
