#!/usr/bin/env bash
set -euo pipefail

enforce_release_intent() {
  local manifest=$1
  local validation_only=$2
  local manifest_intent
  manifest_intent=$(node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(m.releaseIntent ?? 'commercial'));" "${manifest}")

  if [ "${validation_only}" = 1 ]; then
    test "${manifest_intent}" = validation-only || {
      echo "validation-only bundle verification requires releaseIntent=validation-only in release-manifest.json" >&2
      return 1
    }
    printf 'release_intent=validation-only\ncommercial_release=false\n'
    return 0
  fi

  test "${manifest_intent}" = commercial || {
    echo "commercial deployment requires releaseIntent=commercial" >&2
    return 1
  }
  npm run release:quality-gate
  printf 'release_intent=commercial\ncommercial_release=true\n'
}

resolve_tag_target_sha() {
  local tag=$1
  git fetch --force --no-tags origin "refs/tags/${tag}:refs/tags/${tag}" >/dev/null
  git rev-list -n 1 "refs/tags/${tag}"
}

verify_ci_run_identity() {
  local run_id=$1
  local release_sha=$2
  local expected_event=$3
  local expected_ref=${4:-}
  local run_json
  run_json=$(gh run view "${run_id}" --json status,conclusion,headSha,event,headBranch)
  node -e "
    const run=JSON.parse(process.argv[1]);
    if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('CI run is not successful');
    if (run.headSha !== process.argv[2]) throw new Error('CI run head SHA mismatch');
    if (run.event !== process.argv[3]) throw new Error('CI run event mismatch');
    if (process.argv[4] && run.headBranch !== process.argv[4]) throw new Error('CI run ref mismatch');
  " "${run_json}" "${release_sha}" "${expected_event}" "${expected_ref}"
}

download_required_artifact() {
  local run_id=$1
  local name=$2
  local directory=$3
  rm -rf "${directory}"
  mkdir -p "${directory}"
  if ! gh run download "${run_id}" --name "${name}" --dir "${directory}"; then
    echo "required GitHub artifact is unavailable: ${name}; quota exhaustion is a release failure" >&2
    return 1
  fi
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

validation_only=0
if [ "${1:-}" = --validation-only ]; then
  validation_only=1
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "usage: $0 [--validation-only]" >&2
  exit 1
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${repo_root}"

release_tag=${MBOX_RELEASE_TAG:-}

ssh_host=${MBOX_SSH_HOST:-139.224.254.60}
ssh_port=${MBOX_SSH_PORT:-6122}
ssh_user=${MBOX_SSH_USER:-root}
ssh_key=${MBOX_SSH_KEY_PATH:-${HOME}/.ssh/mbox_aliyun_ed25519}
public_url=${MBOX_PUBLIC_URL:-https://139.224.254.60}
backup_max_age_minutes=${MBOX_BACKUP_MAX_AGE_MINUTES:-720}
if [ "${validation_only}" = 1 ]; then
  bundle_dir=${MBOX_RELEASE_BUNDLE_DIR:-${repo_root}/.runtime/validation-bundle}
else
  : "${release_tag:?MBOX_RELEASE_TAG is required for commercial deployment}"
  bundle_dir=${MBOX_RELEASE_BUNDLE_DIR:-${repo_root}/.runtime/deploy/${release_tag}}
fi
dry_run=${MBOX_DEPLOY_DRY_RUN:-0}

[[ "${backup_max_age_minutes}" =~ ^[0-9]+$ ]]

mkdir -p "${bundle_dir}"
if [ ! -f "${bundle_dir}/release-manifest.json" ]; then
  if [ "${validation_only}" = 1 ]; then
    echo "validation-only requires a pre-generated CI bundle in MBOX_RELEASE_BUNDLE_DIR" >&2
    exit 1
  fi
  gh release download "${release_tag}" --dir "${bundle_dir}" --clobber
fi

manifest=${bundle_dir}/release-manifest.json
test -f "${manifest}"

enforce_release_intent "${manifest}" "${validation_only}"
if [ "${validation_only}" = 1 ]; then
  release_intent=validation-only
else
  release_intent=commercial
fi

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
test -f "${bundle_dir}/${archive_name}"

bundle_verify_args=(
  --directory "${bundle_dir}"
  --expected-sha "${release_sha}"
  --expected-intent "${release_intent}"
)
if [ "${validation_only}" = 0 ]; then
  test "${release_tag}" = "v${release_version}"
  tag_target_sha=$(resolve_tag_target_sha "${release_tag}")
  test "${tag_target_sha}" = "${release_sha}" || {
    echo "release tag target SHA does not match release manifest" >&2
    exit 1
  }
  bundle_verify_args+=(--expected-tag "${release_tag}")
fi
node scripts/verify-release-bundle.mjs "${bundle_verify_args[@]}" >/dev/null

if [ -z "${MBOX_CI_RUN_ID:-}" ]; then
  if [ "${validation_only}" = 1 ]; then
    MBOX_CI_RUN_ID=$(gh run list --workflow ci.yml --commit "${release_sha}" --event workflow_dispatch \
      --json databaseId,status,conclusion,headSha \
      --jq 'map(select(.status == "completed" and .conclusion == "success" and .headSha == "'"${release_sha}"'")) | .[0].databaseId // empty')
  else
    MBOX_CI_RUN_ID=$(gh run list --workflow ci.yml --branch "${release_tag}" --commit "${release_sha}" --event push \
      --json databaseId,status,conclusion,headSha \
      --jq 'map(select(.status == "completed" and .conclusion == "success" and .headSha == "'"${release_sha}"'")) | .[0].databaseId // empty')
  fi
fi
test -n "${MBOX_CI_RUN_ID}"
if [ "${validation_only}" = 1 ]; then
  verify_ci_run_identity "${MBOX_CI_RUN_ID}" "${release_sha}" workflow_dispatch
else
  verify_ci_run_identity "${MBOX_CI_RUN_ID}" "${release_sha}" push "${release_tag}"
fi

quality_dir=${bundle_dir}/verified-ci-evidence/quality
runtime_dir=${bundle_dir}/verified-ci-evidence/runtime
download_required_artifact "${MBOX_CI_RUN_ID}" "quality-evidence-${release_sha}" "${quality_dir}"
download_required_artifact "${MBOX_CI_RUN_ID}" "runtime-quality-${release_sha}" "${runtime_dir}"
for directory in "${quality_dir}" "${runtime_dir}"; do
  (cd "${directory}" && shasum -a 256 -c SHA256SUMS >/dev/null)
done
node -e "
  const fs=require('node:fs');
  const ledger=JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  if (ledger.source?.commitSha !== process.argv[2]) throw new Error('quality ledger commit mismatch');
  if (String(ledger.ci?.runId) !== process.argv[3]) throw new Error('quality ledger CI run mismatch');
" "${quality_dir}/ci-quality-evidence.json" "${release_sha}" "${MBOX_CI_RUN_ID}"

release_metadata=${bundle_dir}/release-metadata
rm -rf "${release_metadata}"
mkdir -p "${release_metadata}"
cp "${bundle_dir}/release-manifest.json" "${release_metadata}/"
cp "${bundle_dir}/migration-manifest.json" "${release_metadata}/"
evidence_dir=${bundle_dir}/oss-ready-evidence
node scripts/build-aliyun-evidence-bundle.mjs \
  --output "${evidence_dir}" \
  --channel rc \
  --version "${release_version}" \
  --sha "${release_sha}" \
  --ci-run-id "${MBOX_CI_RUN_ID}" \
  --input "quality=${quality_dir}" \
  --input "runtime=${runtime_dir}" \
  --input "release=${release_metadata}" >/dev/null
node scripts/verify-sensitive-artifacts.mjs "${evidence_dir}"
(cd "${evidence_dir}" && shasum -a 256 -c SHA256SUMS >/dev/null)

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

printf 'release=%s\nsha=%s\nimage=%s\nimage_digest=%s\nbundle=%s\n' \
  "${release_version}" "${release_sha}" "${image_tag}" "${image_digest}" \
  "${bundle_dir}"

if [ "${validation_only}" = 1 ]; then
  printf 'validation_only=bundle-verified\ndeployment=skipped\n'
  exit 0
fi

if [ "${dry_run}" = 1 ]; then
  printf 'dry_run=verified\n'
  exit 0
fi

: "${MBOX_SSH_USER:?MBOX_SSH_USER must name a non-root constrained deploy account}"
test "${ssh_user}" != root || {
  echo "direct root SSH deployment is forbidden; use a constrained deploy account with limited sudo" >&2
  exit 1
}
test -f "${ssh_key}"

ssh "${ssh_options[@]}" "${ssh_target}" \
  "uid=\$(id -u); gid=\$(id -g); sudo -n install -d -m 0700 -o \"\${uid}\" -g \"\${gid}\" '${remote_release_dir}'"
rsync_resume_option=--append
if rsync --help 2>&1 | grep -q -- '--append-verify'; then
  rsync_resume_option=--append-verify
fi
rsync -a --partial "${rsync_resume_option}" \
  -e "ssh -i '${ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${ssh_port}'" \
  "${bundle_dir}/" "${ssh_target}:${remote_release_dir}/"

for helper in upload-oss-verified.sh stage-release-evidence.sh send-sls-events.sh prune-oss-images.sh; do
  scp "${scp_options[@]}" "deploy/aliyun/${helper}" "${ssh_target}:${remote_release_dir}/${helper}"
done
ssh "${ssh_options[@]}" "${ssh_target}" \
  "chmod 0700 '${remote_release_dir}'/*.sh && '${remote_release_dir}/stage-release-evidence.sh' '${remote_release_dir}' '${remote_release_dir}/oss-ready-evidence' '${MBOX_RELEASE_TAG}'"
ssh "${ssh_options[@]}" "${ssh_target}" \
  "sudo -n chown -R root:root '${remote_release_dir}' && sudo -n chmod -R go-w '${remote_release_dir}'"

ssh "${ssh_options[@]}" "${ssh_target}" \
  sudo -n bash -s -- "${remote_release_dir}" "${public_url}" "${backup_max_age_minutes}" \
  < deploy/aliyun/activate-release.sh

MBOX_RELEASE_SMOKE_URL="${public_url}" \
MBOX_RELEASE_EXPECTED_SHA="${release_sha}" \
MBOX_RELEASE_EXPECTED_DIGEST="${image_digest}" \
  npm run release:verify

mkdir -p "${bundle_dir}/deployment"
scp "${scp_options[@]}" \
  "${ssh_target}:${remote_release_dir}/deployment-manifest.json" \
  "${bundle_dir}/deployment/deployment-manifest.json"
scp "${scp_options[@]}" \
  "${ssh_target}:${remote_release_dir}/predeployment-oss-verification.json" \
  "${bundle_dir}/deployment/predeployment-oss-verification.json"

printf 'deployment=complete\nmanifest=%s\n' \
  "${bundle_dir}/deployment/deployment-manifest.json"
