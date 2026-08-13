#!/usr/bin/env bash
set -Eeuo pipefail

source_dir=${1:?source directory is required}
object_prefix=${2:?OSS object prefix is required}
bucket=${MBOX_OSS_BUCKET:-m-box}
region=${MBOX_OSS_REGION:-cn-shanghai}
endpoint=${MBOX_OSS_ENDPOINT:-oss-cn-shanghai-internal.aliyuncs.com}
auth_mode=${MBOX_OSS_AUTH_MODE:-EcsRamRole}
report=${MBOX_OSS_VERIFICATION_REPORT:-${source_dir%/}/oss-verification.json}
dry_run=${MBOX_OSS_DRY_RUN:-0}

case "${endpoint}" in
  *-internal.aliyuncs.com) ;;
  *) echo 'OSS upload requires a same-region internal endpoint' >&2; exit 1 ;;
esac
test "${auth_mode}" = EcsRamRole
if env | grep -Eq '^(OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET)='; then
  echo 'long-lived cloud credential environment variables are forbidden' >&2
  exit 1
fi
case "${object_prefix}" in
  mbox/*) ;;
  *) echo 'OSS object prefix must stay below mbox/' >&2; exit 1 ;;
esac
case "${object_prefix}" in *..*) echo 'OSS object prefix must not contain ..' >&2; exit 1 ;; esac
test -d "${source_dir}"
test -f "${source_dir}/SHA256SUMS"
test ! -e "${source_dir}/_OBJECTS.json"
test ! -e "${source_dir}/_COMPLETE.json"
(
  cd "${source_dir}"
  sha256sum --check SHA256SUMS >/dev/null
)

if [ "${dry_run}" = 1 ]; then
  printf 'oss_upload=dry-run\nbucket=%s\nprefix=%s\nendpoint=%s\n' "${bucket}" "${object_prefix}" "${endpoint}"
  exit 0
fi

command -v ossutil >/dev/null
role_name=$(curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/ram/security-credentials/)
test -n "${role_name}"

oss_options=(--mode "${auth_mode}" --region "${region}" --endpoint "${endpoint}")
verification_dir=$(mktemp -d)
objects_json=$(mktemp)
objects_manifest=$(mktemp)
trap 'rm -rf "${verification_dir}"; rm -f "${objects_json}" "${objects_json}.next" "${objects_manifest}" "${completion_marker:-}"' EXIT
printf '[]\n' > "${objects_json}"

while IFS= read -r -d '' file; do
  relative=${file#"${source_dir%/}/"}
  key="${object_prefix%/}/${relative}"
  target="oss://${bucket}/${key}"
  expected_size=$(wc -c < "${file}" | tr -d ' ')
  expected_sha=$(sha256sum "${file}" | awk '{print $1}')
  ossutil cp "${file}" "${target}" --force "${oss_options[@]}" >/dev/null
  downloaded="${verification_dir}/${relative}"
  install -d -m 0700 "$(dirname "${downloaded}")"
  ossutil cp "${target}" "${downloaded}" --force "${oss_options[@]}" >/dev/null
  actual_size=$(wc -c < "${downloaded}" | tr -d ' ')
  actual_sha=$(sha256sum "${downloaded}" | awk '{print $1}')
  test "${actual_size}" = "${expected_size}"
  test "${actual_sha}" = "${expected_sha}"
  jq --arg key "${key}" --arg sha256 "${actual_sha}" --argjson bytes "${actual_size}" \
    '. + [{key:$key,bytes:$bytes,sha256:$sha256,verified:true}]' "${objects_json}" > "${objects_json}.next"
  mv "${objects_json}.next" "${objects_json}"
done < <(find "${source_dir}" -type f ! -path "${report}" -print0 | sort -z)

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg generatedAt "${generated_at}" \
  --arg prefix "${object_prefix%/}" \
  --slurpfile objects "${objects_json}" \
  '{schemaVersion:1,generatedAt:$generatedAt,prefix:$prefix,objects:$objects[0]}' \
  > "${objects_manifest}"
objects_manifest_sha=$(sha256sum "${objects_manifest}" | awk '{print $1}')
objects_manifest_key="${object_prefix%/}/_OBJECTS.json"
objects_manifest_target="oss://${bucket}/${objects_manifest_key}"
ossutil cp "${objects_manifest}" "${objects_manifest_target}" --force "${oss_options[@]}" >/dev/null
objects_manifest_download="${verification_dir}/_OBJECTS.json"
ossutil cp "${objects_manifest_target}" "${objects_manifest_download}" --force "${oss_options[@]}" >/dev/null
test "$(sha256sum "${objects_manifest_download}" | awk '{print $1}')" = "${objects_manifest_sha}"
jq -e --arg prefix "${object_prefix%/}" --argjson count "$(jq 'length' "${objects_json}")" \
  '.schemaVersion == 1 and .prefix == $prefix and (.objects | length) == $count' \
  "${objects_manifest_download}" >/dev/null
completion_marker=$(mktemp)
jq -n \
  --arg completedAt "${generated_at}" \
  --arg prefix "${object_prefix%/}" \
  --arg objectsManifest "${objects_manifest_key}" \
  --arg objectsManifestSha256 "${objects_manifest_sha}" \
  --argjson objectCount "$(jq 'length' "${objects_json}")" \
  '{schemaVersion:1,completedAt:$completedAt,prefix:$prefix,objectCount:$objectCount,objectsManifest:$objectsManifest,objectsManifestSha256:$objectsManifestSha256,verified:true}' \
  > "${completion_marker}"
marker_target="oss://${bucket}/${object_prefix%/}/_COMPLETE.json"
ossutil cp "${completion_marker}" "${marker_target}" --force "${oss_options[@]}" >/dev/null
marker_download="${verification_dir}/_COMPLETE.json"
ossutil cp "${marker_target}" "${marker_download}" --force "${oss_options[@]}" >/dev/null
test "$(sha256sum "${marker_download}" | awk '{print $1}')" = "$(sha256sum "${completion_marker}" | awk '{print $1}')"
jq -n \
  --arg generatedAt "${generated_at}" \
  --arg bucket "${bucket}" \
  --arg prefix "${object_prefix}" \
  --arg endpoint "${endpoint}" \
  --arg roleName "${role_name}" \
  --arg completionMarker "${object_prefix%/}/_COMPLETE.json" \
  --arg objectsManifest "${objects_manifest_key}" \
  --arg objectsManifestSha256 "${objects_manifest_sha}" \
  --slurpfile objects "${objects_json}" \
  '{schemaVersion:1,generatedAt:$generatedAt,bucket:$bucket,prefix:$prefix,endpoint:$endpoint,authMode:"EcsRamRole",roleName:$roleName,completionMarker:$completionMarker,objectsManifest:$objectsManifest,objectsManifestSha256:$objectsManifestSha256,objects:$objects[0],verified:true}' \
  > "${report}"
chmod 0600 "${report}"
printf 'oss_upload=verified\nreport=%s\nobjects=%s\n' "${report}" "$(jq '.objects | length' "${report}")"
