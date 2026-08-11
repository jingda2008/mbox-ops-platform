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

mapfile -t releases < <(
  ossutil ls "oss://${bucket}/${prefix}" --short-format "${oss_options[@]}" \
    | sed -n "s#^oss://${bucket}/${prefix}\([^/][^/]*/\).*#\1#p" \
    | sort -u
)
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
