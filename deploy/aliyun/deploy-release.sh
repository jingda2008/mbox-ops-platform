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
  gh release download "${MBOX_RELEASE_TAG}" \
    --dir "${bundle_dir}" \
    --clobber
fi

manifest=${bundle_dir}/release-manifest.json
test -f "${manifest}"

node -e "
  const fs=require('node:fs');
  const manifest=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  const expected={
    kind:'normalized-staff-service-database',
    includes:['normalized-web','normalized-server','normalized-database'],
    excludes:['wechat-miniprogram'],
  };
  if (JSON.stringify(manifest.deploymentScope) !== JSON.stringify(expected)) {
    throw new Error('release deployment scope mismatch');
  }
" "${manifest}"

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
store_config_name=$(read_manifest configuration.store.file)
store_config_sha=$(read_manifest configuration.store.sha256)
catalog_config_name=$(read_manifest configuration.catalog.file)
catalog_config_sha=$(read_manifest configuration.catalog.sha256)

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${archive_name}" != */* ]]
test "${MBOX_RELEASE_TAG}" = "v${release_version}"
test -f "${bundle_dir}/${archive_name}"
for config_name in "${store_config_name}" "${catalog_config_name}"; do
  [[ "${config_name}" != */* ]]
  test -f "${bundle_dir}/${config_name}"
done
test "$(shasum -a 256 "${bundle_dir}/${store_config_name}" | awk '{print $1}')" = "${store_config_sha}"
test "$(shasum -a 256 "${bundle_dir}/${catalog_config_name}" | awk '{print $1}')" = "${catalog_config_sha}"

deployment_script_rows=$(node -e "
  const fs=require('node:fs');
  const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const scripts=manifest.deploymentScripts;
  if (!scripts || Object.keys(scripts).length !== 12) throw new Error('deployment script manifest is incomplete');
  for (const entry of Object.values(scripts)) {
    if (!entry || !/^[a-z0-9-]+\\.sh$/.test(entry.file) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('deployment script identity is invalid');
    }
    process.stdout.write(entry.file + '\\t' + entry.sha256 + '\\n');
  }
" "${manifest}")
while IFS=$'\t' read -r script_name script_sha; do
  test -f "${bundle_dir}/${script_name}"
  test "$(shasum -a 256 "${bundle_dir}/${script_name}" | awk '{print $1}')" = "${script_sha}"
done <<< "${deployment_script_rows}"
expected_deploy_sha=$(node -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(m.deploymentScripts.deploy_release.sha256)" "${manifest}")
test "$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')" = "${expected_deploy_sha}"

actual_archive_sha=$(shasum -a 256 "${bundle_dir}/${archive_name}" | awk '{print $1}')
test "${actual_archive_sha}" = "${archive_sha}"

if [ -z "${MBOX_CI_RUN_ID:-}" ]; then
  MBOX_CI_RUN_ID=$(gh run list \
    --workflow ci.yml \
    --branch "${MBOX_RELEASE_TAG}" \
    --commit "${release_sha}" \
    --event push \
    --json databaseId,status,conclusion,headSha \
    --jq 'map(select(.status == "completed" and .conclusion == "success" and .headSha == "'"${release_sha}"'")) | .[0].databaseId // empty')
fi
test -n "${MBOX_CI_RUN_ID}"

quality_dir=${bundle_dir}/verified-ci-evidence/quality
runtime_dir=${bundle_dir}/verified-ci-evidence/runtime
if [ ! -f "${quality_dir}/SHA256SUMS" ]; then
  mkdir -p "${quality_dir}"
  quality_archive="quality-evidence-${release_sha}.tar.gz"
  if [ -f "${bundle_dir}/${quality_archive}" ] && [ -f "${bundle_dir}/${quality_archive}.sha256" ]; then
    (cd "${bundle_dir}" && shasum -a 256 -c "${quality_archive}.sha256" >/dev/null)
    tar -xzf "${bundle_dir}/${quality_archive}" -C "${quality_dir}"
  else
    gh run download "${MBOX_CI_RUN_ID}" --name "quality-evidence-${release_sha}" --dir "${quality_dir}"
  fi
fi
if [ ! -f "${runtime_dir}/SHA256SUMS" ]; then
  mkdir -p "${runtime_dir}"
  runtime_archive="runtime-quality-${release_sha}.tar.gz"
  if [ -f "${bundle_dir}/${runtime_archive}" ] && [ -f "${bundle_dir}/${runtime_archive}.sha256" ]; then
    (cd "${bundle_dir}" && shasum -a 256 -c "${runtime_archive}.sha256" >/dev/null)
    tar -xzf "${bundle_dir}/${runtime_archive}" -C "${runtime_dir}"
  else
    gh run download "${MBOX_CI_RUN_ID}" --name "runtime-quality-${release_sha}" --dir "${runtime_dir}"
  fi
fi
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
cp "${bundle_dir}/${store_config_name}" "${release_metadata}/"
cp "${bundle_dir}/${catalog_config_name}" "${release_metadata}/"
while IFS=$'\t' read -r script_name _; do
  cp "${bundle_dir}/${script_name}" "${release_metadata}/"
done <<< "${deployment_script_rows}"
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

printf 'release=%s\nsha=%s\nimage=%s\nimage_digest=%s\ntier=%s\nbundle=%s\n' \
  "${release_version}" "${release_sha}" "${image_tag}" "${image_digest}" \
  "${deployment_tier}" "${bundle_dir}"

if [ "${dry_run}" = 1 ]; then
  printf 'dry_run=verified\n'
  exit 0
fi

ssh "${ssh_options[@]}" "${ssh_target}" "install -d -m 0700 '${remote_release_dir}'"
rsync_resume_option=--append
if rsync --help 2>&1 | grep -q -- '--append-verify'; then
  rsync_resume_option=--append-verify
fi
rsync -a --partial "${rsync_resume_option}" \
  -e "ssh -i '${ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${ssh_port}'" \
  "${bundle_dir}/" "${ssh_target}:${remote_release_dir}/"

ssh "${ssh_options[@]}" "${ssh_target}" \
  "cd '${remote_release_dir}' && test \"\$(jq -r '.deploymentScripts | length' release-manifest.json)\" = 12 && jq -er '.deploymentScripts | to_entries[] | [.value.file,.value.sha256] | @tsv' release-manifest.json | while IFS=\$'\\t' read -r file sha; do test \"\$(sha256sum \"\$file\" | awk '{print \$1}')\" = \"\$sha\" || exit 1; done && chmod 0700 ./*.sh && './stage-release-evidence.sh' '${remote_release_dir}' '${remote_release_dir}/oss-ready-evidence' '${MBOX_RELEASE_TAG}'"

# This check runs from the release operator, outside the production host, so it
# proves that the current public edge is serving a healthy release without
# relying on origin-server hairpin routing. Exact previous-release identity is
# checked separately inside activate-release.sh before any database write.
pre_activation_ready=${bundle_dir}/pre-activation-public-ready.json
pre_activation_temporary=$(mktemp "${bundle_dir}/.pre-activation-ready.XXXXXX")
pre_activation_verified=0
for _ in $(seq 1 12); do
  pre_activation_status=$(curl -sS --connect-timeout 3 --max-time 8 \
    -H 'Accept: application/json' -H 'User-Agent: mbox-release-operator/1.0' \
    -o "${pre_activation_temporary}" -w '%{http_code}' \
    "${public_url}/api/ready" 2>/dev/null || true)
  if [ "${pre_activation_status}" = 200 ] \
    && jq -e --arg tier "${deployment_tier}" \
      '.status == "ready" and .deploymentTier == $tier' \
      "${pre_activation_temporary}" >/dev/null 2>&1; then
    mv "${pre_activation_temporary}" "${pre_activation_ready}"
    pre_activation_verified=1
    break
  fi
  sleep 2
done
rm -f "${pre_activation_temporary}"
test "${pre_activation_verified}" = 1

ssh "${ssh_options[@]}" "${ssh_target}" \
  "'${remote_release_dir}/activate-release.sh' '${remote_release_dir}' '${deployment_tier}' '${public_url}' '${backup_max_age_minutes}'"

if ! MBOX_RELEASE_SMOKE_URL="${public_url}" \
  MBOX_RELEASE_EXPECTED_SHA="${release_sha}" \
  MBOX_RELEASE_EXPECTED_DIGEST="${image_digest}" \
  MBOX_RELEASE_EXPECTED_TIER="${deployment_tier}" \
  MBOX_RELEASE_EXPECTED_SCHEMA_VERSION="$(read_manifest migration.count)" \
    npm run release:verify; then
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "'${remote_release_dir}/rollback-activated-release.sh' '${remote_release_dir}' '${public_url}'"
  exit 1
fi

mkdir -p "${bundle_dir}/deployment"
scp "${scp_options[@]}" \
  "${ssh_target}:${remote_release_dir}/deployment-manifest.json" \
  "${bundle_dir}/deployment/deployment-manifest.json"
scp "${scp_options[@]}" \
  "${ssh_target}:${remote_release_dir}/predeployment-oss-verification.json" \
  "${bundle_dir}/deployment/predeployment-oss-verification.json"

printf 'deployment=complete\nmanifest=%s\n' \
  "${bundle_dir}/deployment/deployment-manifest.json"
