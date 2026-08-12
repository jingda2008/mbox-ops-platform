#!/usr/bin/env bash
set -Eeuo pipefail

release_dir=${1:?release directory is required}
evidence_dir=${2:?evidence directory is required}
release_tag=${3:?release tag is required}
uploader=${release_dir}/upload-oss-verified.sh
manifest=${release_dir}/release-manifest.json

case "${release_dir}" in /opt/mbox/releases/*) ;; *) exit 1 ;; esac
case "${evidence_dir}" in "${release_dir}"/*) ;; *) exit 1 ;; esac
test -x "${uploader}"
test -f "${manifest}"
test -f "${evidence_dir}/SHA256SUMS"

release_sha=$(jq -er '.releaseSha' "${manifest}")
release_version=$(jq -er '.releaseVersion' "${manifest}")
archive_name=$(jq -er '.archive' "${manifest}")
archive_sha=$(jq -er '.archiveSha256' "${manifest}")
test "${release_tag}" = "v${release_version}"
test "$(sha256sum "${release_dir}/${archive_name}" | awk '{print $1}')" = "${archive_sha}"

evidence_prefix="mbox/evidence/rc/${release_tag}/${release_sha}"
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-evidence-verification.json" \
  "${uploader}" "${evidence_dir}" "${evidence_prefix}"

image_stage=${release_dir}/oss-image
rm -rf "${image_stage}"
install -d -m 0700 "${image_stage}"
ln "${release_dir}/${archive_name}" "${image_stage}/${archive_name}" 2>/dev/null \
  || cp "${release_dir}/${archive_name}" "${image_stage}/${archive_name}"
cp "${manifest}" "${image_stage}/release-manifest.json"
cp "${release_dir}/migration-manifest.json" "${image_stage}/migration-manifest.json"
(
  cd "${image_stage}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
image_key="$(date -u +%Y%m%dT%H%M%SZ)-${release_version}-${release_sha:0:7}"
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-image-verification.json" \
  "${uploader}" "${image_stage}" "mbox/images/${image_key}"

jq -n \
  --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg releaseSha "${release_sha}" \
  --arg releaseVersion "${release_version}" \
  --arg evidencePrefix "${evidence_prefix}" \
  --arg imagePrefix "mbox/images/${image_key}" \
  --slurpfile evidence "${release_dir}/oss-evidence-verification.json" \
  --slurpfile image "${release_dir}/oss-image-verification.json" \
  '{schemaVersion:1,verifiedAt:$verifiedAt,releaseSha:$releaseSha,releaseVersion:$releaseVersion,evidencePrefix:$evidencePrefix,imagePrefix:$imagePrefix,evidence:$evidence[0],image:$image[0],verified:true}' \
  > "${release_dir}/predeployment-oss-verification.json"
chmod 0600 "${release_dir}/predeployment-oss-verification.json"
printf 'predeployment_oss=verified\nevidence_prefix=%s\nimage_prefix=%s\n' "${evidence_prefix}" "mbox/images/${image_key}"
