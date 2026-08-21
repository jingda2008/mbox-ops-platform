#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${repo_root}"

: "${MBOX_RELEASE_TAG:?MBOX_RELEASE_TAG is required, for example v1.0.0-rc.48}"

deployment_tier=${MBOX_DEPLOYMENT_TIER:-validation}
if [ "${deployment_tier}" = production ]; then
  : "${MBOX_SSH_HOST:?MBOX_SSH_HOST is required for a production deployment}"
  : "${MBOX_PUBLIC_URL:?MBOX_PUBLIC_URL is required for a production deployment}"
fi

ssh_host=${MBOX_SSH_HOST:-139.224.254.60}
ssh_port=${MBOX_SSH_PORT:-6122}
ssh_user=${MBOX_SSH_USER:-root}
ssh_key=${MBOX_SSH_KEY_PATH:-${HOME}/.ssh/mbox_aliyun_ed25519}
evidence_ssh_host=${MBOX_EVIDENCE_SSH_HOST:-${ssh_host}}
evidence_ssh_port=${MBOX_EVIDENCE_SSH_PORT:-${ssh_port}}
evidence_ssh_user=${MBOX_EVIDENCE_SSH_USER:-${ssh_user}}
evidence_ssh_key=${MBOX_EVIDENCE_SSH_KEY_PATH:-${ssh_key}}
public_url=${MBOX_PUBLIC_URL:-https://139.224.254.60}
backup_max_age_minutes=${MBOX_BACKUP_MAX_AGE_MINUTES:-720}
bundle_dir=${MBOX_RELEASE_BUNDLE_DIR:-${repo_root}/.runtime/deploy/${MBOX_RELEASE_TAG}}
dry_run=${MBOX_DEPLOY_DRY_RUN:-0}

case "${deployment_tier}" in
  validation|production) ;;
  *) echo "MBOX_DEPLOYMENT_TIER must be validation or production" >&2; exit 1 ;;
esac
[[ "${backup_max_age_minutes}" =~ ^[0-9]+$ ]]
[[ "${ssh_host}" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "${evidence_ssh_host}" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "${evidence_ssh_port}" =~ ^[0-9]{1,5}$ ]]
test -f "${ssh_key}"
test -f "${evidence_ssh_key}"

public_host=$(node -e "
  const url = new URL(process.argv[1]);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MBOX_PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(url.hostname)) throw new Error('MBOX_PUBLIC_URL host is invalid');
  process.stdout.write(url.hostname);
" "${public_url%/}/")

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
platform_image_digest=$(read_manifest platformImageDigest)
archive_name=$(read_manifest archive)
archive_sha=$(read_manifest archiveSha256)
store_config_name=$(read_manifest configuration.store.file)
store_config_sha=$(read_manifest configuration.store.sha256)
catalog_config_name=$(read_manifest configuration.catalog.file)
catalog_config_sha=$(read_manifest configuration.catalog.sha256)

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${platform_image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
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
evidence_ssh_target="${evidence_ssh_user}@${evidence_ssh_host}"
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
evidence_ssh_options=(
  -i "${evidence_ssh_key}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -p "${evidence_ssh_port}"
)
evidence_scp_options=(
  -i "${evidence_ssh_key}"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -P "${evidence_ssh_port}"
)

# This deployment script only owns a direct public origin. Refuse to touch a
# database when the public hostname resolves to another server: an unmanaged
# external edge cannot be switched atomically by this release transaction.
public_origin_addresses=$(ssh "${ssh_options[@]}" "${ssh_target}" \
  "getent ahostsv4 '${public_host}' | awk '{print \$1}' | sort -u")
deployment_target_addresses=$(ssh "${ssh_options[@]}" "${ssh_target}" \
  "getent ahostsv4 '${ssh_host}' | awk '{print \$1}' | sort -u")
test -n "${public_origin_addresses}"
test -n "${deployment_target_addresses}"
if ! comm -12 \
  <(printf '%s\n' "${public_origin_addresses}" | sort -u) \
  <(printf '%s\n' "${deployment_target_addresses}" | sort -u) \
  | grep -q .; then
  printf 'deployment target mismatch: public host %s resolves to [%s], but SSH target %s resolves to [%s]\n' \
    "${public_host}" "$(printf '%s' "${public_origin_addresses}" | tr '\n' ',')" \
    "${ssh_host}" "$(printf '%s' "${deployment_target_addresses}" | tr '\n' ',')" >&2
  exit 1
fi

printf 'release=%s\nsha=%s\nimage=%s\nimage_digest=%s\nplatform_image_digest=%s\ntier=%s\nbundle=%s\n' \
  "${release_version}" "${release_sha}" "${image_tag}" "${image_digest}" "${platform_image_digest}" \
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
  "cd '${remote_release_dir}' && test \"\$(jq -r '.deploymentScripts | length' release-manifest.json)\" = 12 && jq -er '.deploymentScripts | to_entries[] | [.value.file,.value.sha256] | @tsv' release-manifest.json | while IFS=\$'\\t' read -r file sha; do test \"\$(sha256sum \"\$file\" | awk '{print \$1}')\" = \"\$sha\" || exit 1; done && chmod 0700 ./*.sh"

uses_evidence_relay=0
if [ "${evidence_ssh_host}:${evidence_ssh_port}:${evidence_ssh_user}:${evidence_ssh_key}" \
  = "${ssh_host}:${ssh_port}:${ssh_user}:${ssh_key}" ]; then
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "'${remote_release_dir}/stage-release-evidence.sh' '${remote_release_dir}' '${remote_release_dir}/oss-ready-evidence' '${MBOX_RELEASE_TAG}'"
else
  uses_evidence_relay=1
  evidence_release_dir="/opt/mbox/releases/${short_sha}-evidence-relay"
  ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
    "install -d -m 0700 '${evidence_release_dir}'"
  rsync -a --partial "${rsync_resume_option}" \
    -e "ssh -i '${evidence_ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${evidence_ssh_port}'" \
    "${bundle_dir}/" "${evidence_ssh_target}:${evidence_release_dir}/"
  ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
    "cd '${evidence_release_dir}' && test \"\$(jq -r '.releaseSha' release-manifest.json)\" = '${release_sha}' && chmod 0700 ./*.sh && './stage-release-evidence.sh' '${evidence_release_dir}' '${evidence_release_dir}/oss-ready-evidence' '${MBOX_RELEASE_TAG}'"
  relay_reports=$(mktemp -d "${bundle_dir}/.evidence-relay.XXXXXX")
  for report in predeployment-oss-verification.json oss-evidence-verification.json oss-image-verification.json; do
    scp "${evidence_scp_options[@]}" \
      "${evidence_ssh_target}:${evidence_release_dir}/${report}" "${relay_reports}/${report}"
  done
  jq -e --arg sha "${release_sha}" --arg version "${release_version}" \
    '.verified == true and .releaseSha == $sha and .releaseVersion == $version' \
    "${relay_reports}/predeployment-oss-verification.json" >/dev/null
  scp "${scp_options[@]}" "${relay_reports}"/*.json \
    "${ssh_target}:${remote_release_dir}/"
  rm -f "${relay_reports}"/*.json
  rmdir "${relay_reports}"
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "cd '${remote_release_dir}' && test \"\$(jq -r '.releaseSha' predeployment-oss-verification.json)\" = '${release_sha}' && test \"\$(jq -r '.verified' predeployment-oss-verification.json)\" = true"
fi

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

# The private application host intentionally has no OSS role. It creates the
# read-only database snapshot, while the separately authenticated evidence host
# uploads and reads it back from OSS. Activation accepts only the resulting
# release-bound verification report and rechecks the database identity itself.
if [ "${uses_evidence_relay}" = 1 ]; then
  relay_backup_local=$(mktemp -d "${bundle_dir}/.backup-relay.XXXXXX")
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "'${remote_release_dir}/backup-postgres.sh' prepare-relay '${remote_release_dir}' '${release_sha}'"
  rsync -a --partial "${rsync_resume_option}" \
    -e "ssh -i '${ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${ssh_port}'" \
    "${ssh_target}:${remote_release_dir}/relay-backup-ready/" "${relay_backup_local}/"
  relay_backup_preparation=${relay_backup_local}/backup-preparation.json
  test -f "${relay_backup_preparation}"
  relay_backup_prefix=$(jq -er --arg sha "${release_sha}" '
    select(.schemaVersion == 1 and .releaseSha == $sha)
    | .objectPrefix
    | select(startswith("mbox/backups/") and endswith("/" + $sha))
  ' "${relay_backup_preparation}")
  (cd "${relay_backup_local}" && shasum -a 256 -c SHA256SUMS >/dev/null)
  ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
    "rm -rf '${evidence_release_dir}/relay-backup-ready' && install -d -m 0700 '${evidence_release_dir}/relay-backup-ready'"
  rsync -a --partial "${rsync_resume_option}" \
    -e "ssh -i '${evidence_ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${evidence_ssh_port}'" \
    "${relay_backup_local}/" "${evidence_ssh_target}:${evidence_release_dir}/relay-backup-ready/"
  ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
    "MBOX_OSS_VERIFICATION_REPORT='${evidence_release_dir}/preverified-backup-upload.json' '${evidence_release_dir}/upload-oss-verified.sh' '${evidence_release_dir}/relay-backup-ready' '${relay_backup_prefix}'"
  scp "${evidence_scp_options[@]}" \
    "${evidence_ssh_target}:${evidence_release_dir}/preverified-backup-upload.json" \
    "${relay_backup_local}/preverified-backup-upload.json"
  jq -e --arg prefix "${relay_backup_prefix}" \
    '.verified == true and .authMode == "EcsRamRole" and .prefix == $prefix and (.objects | length) == 4' \
    "${relay_backup_local}/preverified-backup-upload.json" >/dev/null
  scp "${scp_options[@]}" "${relay_backup_local}/preverified-backup-upload.json" \
    "${ssh_target}:${remote_release_dir}/preverified-backup-upload.json"
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "chmod 0600 '${remote_release_dir}/preverified-backup-upload.json' && jq -e --arg prefix '${relay_backup_prefix}' '.verified == true and .prefix == \$prefix' '${remote_release_dir}/preverified-backup-upload.json' >/dev/null"
  rm -rf "${relay_backup_local}"
fi

if [ "${uses_evidence_relay}" = 1 ]; then
  activation_log=$(mktemp "${bundle_dir}/.activation-log.XXXXXX")
  activation_status=$(mktemp "${bundle_dir}/.activation-status.XXXXXX")
  rm -f "${activation_status}"
  (
    set +e
    ssh "${ssh_options[@]}" "${ssh_target}" \
      "'${remote_release_dir}/activate-release.sh' '${remote_release_dir}' '${deployment_tier}' '${public_url}' '${backup_max_age_minutes}'" \
      > "${activation_log}" 2>&1
    printf '%s\n' "$?" > "${activation_status}"
  ) &
  activation_pid=$!
  relay_activation_cleanup() {
    if kill -0 "${activation_pid}" >/dev/null 2>&1; then
      wait "${activation_pid}" || true
    fi
    if [ -f "${activation_status}" ] && [ "$(cat "${activation_status}")" != 0 ]; then
      cat "${activation_log}" >&2
    fi
    rm -f "${activation_log}" "${activation_status}"
  }
  trap relay_activation_cleanup EXIT INT TERM

  relay_post_cutover_evidence() {
    local evidence_kind=$1
    local marker_name=$2
    local source_directory=$3
    local object_prefix=$4
    local report_name=$5
    local relay_local relay_remote report_sha staged_report

    for _ in $(seq 1 120); do
      if ssh "${ssh_options[@]}" "${ssh_target}" \
        "test -f '${remote_release_dir}/${marker_name}'"; then
        break
      fi
      if [ -f "${activation_status}" ]; then
        cat "${activation_log}" >&2
        return 1
      fi
      sleep 2
    done
    ssh "${ssh_options[@]}" "${ssh_target}" \
      "test -f '${remote_release_dir}/${marker_name}' && jq -e --arg sha '${release_sha}' --arg prefix '${object_prefix}' --arg directory '${source_directory}' --arg report '${remote_release_dir}/${report_name}' '.releaseSha == \$sha and .prefix == \$prefix and .evidenceDirectory == \$directory and .report == \$report' '${remote_release_dir}/${marker_name}' >/dev/null"

    relay_local=$(mktemp -d "${bundle_dir}/.${evidence_kind}-relay.XXXXXX")
    rsync -a --partial "${rsync_resume_option}" \
      -e "ssh -i '${ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${ssh_port}'" \
      "${ssh_target}:${source_directory}/" "${relay_local}/"
    (cd "${relay_local}" && shasum -a 256 -c SHA256SUMS >/dev/null)

    relay_remote="${evidence_release_dir}/post-cutover-${evidence_kind}"
    ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
      "rm -rf '${relay_remote}' && install -d -m 0700 '${relay_remote}'"
    rsync -a --partial "${rsync_resume_option}" \
      -e "ssh -i '${evidence_ssh_key}' -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p '${evidence_ssh_port}'" \
      "${relay_local}/" "${evidence_ssh_target}:${relay_remote}/"
    ssh "${evidence_ssh_options[@]}" "${evidence_ssh_target}" \
      "MBOX_OSS_VERIFICATION_REPORT='${evidence_release_dir}/${report_name}' '${evidence_release_dir}/upload-oss-verified.sh' '${relay_remote}' '${object_prefix}'"
    scp "${evidence_scp_options[@]}" \
      "${evidence_ssh_target}:${evidence_release_dir}/${report_name}" \
      "${relay_local}/${report_name}"
    jq -e --arg prefix "${object_prefix}" \
      '.verified == true and .authMode == "EcsRamRole" and .prefix == $prefix' \
      "${relay_local}/${report_name}" >/dev/null
    report_sha=$(shasum -a 256 "${relay_local}/${report_name}" | awk '{print $1}')
    [[ "${report_sha}" =~ ^[0-9a-f]{64}$ ]]
    staged_report="${remote_release_dir}/.${report_name}.next"
    ssh "${ssh_options[@]}" "${ssh_target}" \
      "rm -f '${staged_report}'"
    scp "${scp_options[@]}" "${relay_local}/${report_name}" \
      "${ssh_target}:${staged_report}"
    ssh "${ssh_options[@]}" "${ssh_target}" \
      "chmod 0600 '${staged_report}' && test \"\$(sha256sum '${staged_report}' | awk '{print \$1}')\" = '${report_sha}' && mv -f '${staged_report}' '${remote_release_dir}/${report_name}'"
    rm -rf "${relay_local}"
  }

  relay_post_cutover_evidence \
    deployment .deployment-evidence-relay-ready.json \
    "${remote_release_dir}/oss-deployment" \
    "mbox/evidence/rc/v${release_version}/${release_sha}/deployment" \
    oss-deployment-verification.json
  relay_post_cutover_evidence \
    completion .completion-evidence-relay-ready.json \
    "${remote_release_dir}/oss-completion" \
    "mbox/evidence/rc/v${release_version}/${release_sha}/completion" \
    oss-completion-verification.json

  wait "${activation_pid}"
  activation_exit=$(cat "${activation_status}")
  cat "${activation_log}"
  rm -f "${activation_log}" "${activation_status}"
  test "${activation_exit}" = 0
  trap - EXIT INT TERM
else
  ssh "${ssh_options[@]}" "${ssh_target}" \
    "'${remote_release_dir}/activate-release.sh' '${remote_release_dir}' '${deployment_tier}' '${public_url}' '${backup_max_age_minutes}'"
fi

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
