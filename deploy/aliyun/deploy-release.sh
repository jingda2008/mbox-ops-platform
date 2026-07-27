#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${repo_root}"

: "${MBOX_RELEASE_TAG:?MBOX_RELEASE_TAG is required, for example v1.0.0-rc.48}"

ssh_host=${MBOX_SSH_HOST:-139.224.254.60}
ssh_port=${MBOX_SSH_PORT:-6122}
ssh_user=${MBOX_SSH_USER:-root}
ssh_key=${MBOX_SSH_KEY_PATH:-${HOME}/.ssh/mbox_aliyun_ed25519}
deployment_tier=${MBOX_DEPLOYMENT_TIER:-validation}
public_url=${MBOX_PUBLIC_URL:-https://139.224.254.60}
backup_max_age_minutes=${MBOX_BACKUP_MAX_AGE_MINUTES:-720}
bundle_dir=${MBOX_RELEASE_BUNDLE_DIR:-${repo_root}/.runtime/deploy/${MBOX_RELEASE_TAG}}
dry_run=${MBOX_DEPLOY_DRY_RUN:-0}

case "${deployment_tier}" in
  validation|production) ;;
  *) echo "MBOX_DEPLOYMENT_TIER must be validation or production" >&2; exit 1 ;;
esac
[[ "${backup_max_age_minutes}" =~ ^[0-9]+$ ]]
test -f "${ssh_key}"

mkdir -p "${bundle_dir}"
if [ ! -f "${bundle_dir}/release-manifest.json" ]; then
  if [ -n "${MBOX_CI_RUN_ID:-}" ]; then
    gh run download "${MBOX_CI_RUN_ID}" \
      --name "mbox-image-${MBOX_RELEASE_SHA:?MBOX_RELEASE_SHA is required with MBOX_CI_RUN_ID}" \
      --dir "${bundle_dir}"
  else
    gh release download "${MBOX_RELEASE_TAG}" \
      --dir "${bundle_dir}" \
      --clobber
  fi
fi

manifest=${bundle_dir}/release-manifest.json
test -f "${manifest}"

read_manifest() {
  node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const value=process.argv[2].split('.').reduce((x,k)=>x?.[k],m); if (value === undefined || value === null) process.exit(2); process.stdout.write(String(value))" \
    "${manifest}" "$1"
}

release_sha=$(read_manifest releaseSha)
release_version=$(read_manifest releaseVersion)
image_tag=$(read_manifest imageTag)
image_digest=$(read_manifest imageDigest)
archive_name=$(read_manifest archive)
archive_sha=$(read_manifest archiveSha256)

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${archive_name}" != */* ]]
test "${MBOX_RELEASE_TAG}" = "v${release_version}"
test -f "${bundle_dir}/${archive_name}"

actual_archive_sha=$(shasum -a 256 "${bundle_dir}/${archive_name}" | awk '{print $1}')
test "${actual_archive_sha}" = "${archive_sha}"

short_sha=${release_sha:0:7}
remote_release_dir="/opt/mbox/releases/${short_sha}"
ssh_target="${ssh_user}@${ssh_host}"
ssh_options=(
  -i "${ssh_key}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -p "${ssh_port}"
)
scp_options=(
  -i "${ssh_key}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -P "${ssh_port}"
)

printf 'release=%s\nsha=%s\nimage=%s\nimage_digest=%s\ntier=%s\nbundle=%s\n' \
  "${release_version}" "${release_sha}" "${image_tag}" "${image_digest}" \
  "${deployment_tier}" "${bundle_dir}"

if [ "${dry_run}" = 1 ]; then
  printf 'dry_run=verified\n'
  exit 0
fi

ssh "${ssh_options[@]}" "${ssh_target}" "install -d -m 0700 '${remote_release_dir}'"
rsync -a --partial --append-verify \
  -e "ssh -i '${ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${ssh_port}'" \
  "${bundle_dir}/" "${ssh_target}:${remote_release_dir}/"

ssh "${ssh_options[@]}" "${ssh_target}" \
  bash -s -- "${remote_release_dir}" "${deployment_tier}" "${public_url}" "${backup_max_age_minutes}" \
  < deploy/aliyun/activate-release.sh

MBOX_RELEASE_SMOKE_URL="${public_url}" \
MBOX_RELEASE_EXPECTED_SHA="${release_sha}" \
MBOX_RELEASE_EXPECTED_DIGEST="${image_digest}" \
  npm run release:verify

mkdir -p "${bundle_dir}/deployment"
scp "${scp_options[@]}" \
  "${ssh_target}:${remote_release_dir}/deployment-manifest.json" \
  "${bundle_dir}/deployment/deployment-manifest.json"

printf 'deployment=complete\nmanifest=%s\n' \
  "${bundle_dir}/deployment/deployment-manifest.json"
