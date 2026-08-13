#!/usr/bin/env bash
set -Eeuo pipefail

bucket=${MBOX_OSS_BUCKET:-m-box}
region=${MBOX_OSS_REGION:-cn-shanghai}
endpoint=${MBOX_OSS_ENDPOINT:-oss-cn-shanghai-internal.aliyuncs.com}
auth_mode=${MBOX_OSS_AUTH_MODE:-EcsRamRole}
prefix=${MBOX_OSS_IMAGE_PREFIX:-mbox/images/}
keep=${MBOX_OSS_IMAGE_KEEP:-3}
apply=${MBOX_OSS_PRUNE_APPLY:-0}

[[ "${keep}" =~ ^[1-9][0-9]*$ ]]
test "${auth_mode}" = EcsRamRole
case "${endpoint}" in *-internal.aliyuncs.com) ;; *) exit 1 ;; esac
if env | grep -Eq '^(OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET)='; then
  echo 'long-lived cloud credential environment variables are forbidden' >&2
  exit 1
fi
command -v ossutil >/dev/null
oss_options=(--mode "${auth_mode}" --region "${region}" --endpoint "${endpoint}")

mapfile -t discovered_releases < <(
  ossutil ls "oss://${bucket}/${prefix}" --short-format "${oss_options[@]}" \
    | sed -n "s#^oss://${bucket}/${prefix}\([^/][^/]*/\).*#\1#p" \
    | sort -u
)
releases=()
marker_dir=$(mktemp -d)
trap 'rm -rf "${marker_dir}"' EXIT
for release in "${discovered_releases[@]}"; do
  marker="oss://${bucket}/${prefix}${release}_COMPLETE.json"
  safe_release=$(printf '%s' "${release}" | tr -cd 'A-Za-z0-9._-')
  marker_file="${marker_dir}/${safe_release}.complete.json"
  objects_file="${marker_dir}/${safe_release}.objects.json"
  expected_prefix="${prefix%/}/${release%/}"
  if ossutil cp "${marker}" "${marker_file}" --force "${oss_options[@]}" >/dev/null 2>&1 \
    && jq -e --arg prefix "${expected_prefix}" \
      '.schemaVersion == 1 and .verified == true and .prefix == $prefix
        and (.objectCount | numbers) > 0
        and .objectsManifest == ($prefix + "/_OBJECTS.json")
        and (.objectsManifestSha256 | test("^[0-9a-f]{64}$"))' \
      "${marker_file}" >/dev/null 2>&1 \
    && objects_manifest=$(jq -er '.objectsManifest' "${marker_file}") \
    && ossutil cp "oss://${bucket}/${objects_manifest}" "${objects_file}" --force "${oss_options[@]}" >/dev/null 2>&1 \
    && test "$(sha256sum "${objects_file}" | awk '{print $1}')" = "$(jq -er '.objectsManifestSha256' "${marker_file}")" \
    && jq -e --arg prefix "${expected_prefix}" --argjson count "$(jq -er '.objectCount' "${marker_file}")" '
      .schemaVersion == 1 and .prefix == $prefix and (.objects | type) == "array"
      and (.objects | length) == $count
      and ([.objects[].key] | unique | length) == $count
      and all(.objects[];
        .verified == true
        and (.key | startswith($prefix + "/"))
        and ((.bytes | numbers) >= 0)
        and (.sha256 | test("^[0-9a-f]{64}$")))
      and any(.objects[]; .key == ($prefix + "/SHA256SUMS"))
      and any(.objects[]; .key == ($prefix + "/release-manifest.json"))
      and any(.objects[]; .key == ($prefix + "/migration-manifest.json"))
      and ([.objects[] | select(.key | test("\\.tar\\.gz$"))] | length) == 1
    ' "${objects_file}" >/dev/null 2>&1; then
    critical_ok=1
    critical_index=0
    while IFS=$'\t' read -r key bytes sha256; do
      critical_index=$((critical_index + 1))
      critical_file="${marker_dir}/${safe_release}.critical-${critical_index}"
      if ! ossutil cp "oss://${bucket}/${key}" "${critical_file}" --force "${oss_options[@]}" >/dev/null 2>&1 \
        || [ "$(wc -c < "${critical_file}" | tr -d ' ')" != "${bytes}" ] \
        || [ "$(sha256sum "${critical_file}" | awk '{print $1}')" != "${sha256}" ]; then
        critical_ok=0
        break
      fi
    done < <(jq -r --arg prefix "${expected_prefix}" '
      .objects[]
      | select(.key == ($prefix + "/SHA256SUMS")
        or .key == ($prefix + "/release-manifest.json")
        or .key == ($prefix + "/migration-manifest.json")
        or (.key | test("\\.tar\\.gz$")))
      | [.key, (.bytes | tostring), .sha256] | @tsv
    ' "${objects_file}")
    if [ "${critical_ok}" = 1 ] && [ "${critical_index}" -eq 4 ]; then
      releases+=("${release}")
      continue
    fi
  fi
  {
    printf 'image_prune_skipped_incomplete=%s\n' "oss://${bucket}/${prefix}${release}"
  }
done
if [ "${#releases[@]}" -le "${keep}" ]; then
  printf 'image_prune=not-needed\nfound=%s\nkeep=%s\n' "${#releases[@]}" "${keep}"
  exit 0
fi

delete_count=$((${#releases[@]} - keep))
for release in "${releases[@]:0:${delete_count}}"; do
  target="oss://${bucket}/${prefix}${release}"
  printf 'image_prune_candidate=%s\n' "${target}"
  if [ "${apply}" = 1 ]; then
    ossutil rm "${target}" --recursive --force "${oss_options[@]}" >/dev/null
  fi
done
printf 'image_prune=%s\ndeleted=%s\nkept=%s\n' "$([ "${apply}" = 1 ] && echo applied || echo dry-run)" "${delete_count}" "${keep}"
