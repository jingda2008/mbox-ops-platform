#!/usr/bin/env bash
set -Eeuo pipefail

require_image_id() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

archive_config_path() {
  local archive=$1
  local image_tag=$2
  tar -xOf "${archive}" manifest.json | jq -er --arg imageTag "${image_tag}" '
    map(select((.RepoTags // []) | index($imageTag))) as $matches
    | if ($matches | length) == 1 then $matches[0].Config
      else error("archive must contain exactly one matching image tag") end
  '
}

verify_archive_image_identity() {
  local archive=$1
  local image_tag=$2
  local expected_image_id=$3
  local config_path
  local config_digest
  require_image_id "${expected_image_id}"
  config_path=$(archive_config_path "${archive}" "${image_tag}")
  case "${config_path}" in
    blobs/sha256/[0-9a-f][0-9a-f]*) config_digest=${config_path#blobs/sha256/} ;;
    [0-9a-f][0-9a-f]*.json) config_digest=${config_path%.json} ;;
    *) echo "unsupported or unsafe image config path: ${config_path}" >&2; return 1 ;;
  esac
  [[ "${config_digest}" =~ ^[0-9a-f]{64}$ ]]
  test "sha256:${config_digest}" = "${expected_image_id}"
  test "$(tar -xOf "${archive}" "${config_path}" | sha256sum | awk '{print $1}')" = "${config_digest}"
}

verify_loaded_image_identity() {
  local image_tag=$1
  local expected_image_id=$2
  local actual_image_id
  actual_image_id=$(docker image inspect "${image_tag}" --format '{{.Id}}')
  require_image_id "${actual_image_id}"
  test "${actual_image_id}" = "${expected_image_id}"
}

verify_container_image_identity() {
  local container=$1
  local expected_image_id=$2
  local actual_image_id
  actual_image_id=$(docker inspect "${container}" --format '{{.Image}}')
  require_image_id "${actual_image_id}"
  test "${actual_image_id}" = "${expected_image_id}"
}

verify_container_release_identity() {
  local container=$1
  local expected_image_id=$2
  local expected_release_sha=$3
  local actual_release_sha
  verify_container_image_identity "${container}" "${expected_image_id}"
  actual_release_sha=$(docker inspect "${container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  test "${actual_release_sha}" = "${expected_release_sha}"
}

verify_ready_identity() {
  local response=$1
  local expected_release_sha=$2
  local expected_image_id=$3
  printf '%s' "${response}" | jq -e \
    --arg sha "${expected_release_sha}" \
    --arg imageId "${expected_image_id}" \
    '.status == "ready" and .releaseSha == $sha and .releaseImageDigest == $imageId' >/dev/null
}

verify_rollback_identity() {
  local container=$1
  local expected_image_id=$2
  local expected_release_sha=$3
  local ready_response=$4
  verify_container_release_identity "${container}" "${expected_image_id}" "${expected_release_sha}"
  verify_ready_identity "${ready_response}" "${expected_release_sha}" "${expected_image_id}"
}

verify_expand_contract_migrations() {
  local current_manifest=$1
  local candidate_manifest=$2
  node - "${current_manifest}" "${candidate_manifest}" <<'NODE'
const fs = require('node:fs')
const readMigration = (path) => {
  const document = JSON.parse(fs.readFileSync(path, 'utf8'))
  return document.migration ?? document
}
const current = readMigration(process.argv[2])
const candidate = readMigration(process.argv[3])
if (candidate.schemaVersion !== 2 || candidate.compatibilityPolicy !== 'expand-contract-v1') {
  throw new Error('candidate migration manifest lacks expand-contract-v1 evidence')
}
if (!Array.isArray(current.files) || !Array.isArray(candidate.files)) {
  throw new Error('migration manifest files are missing')
}
if (candidate.files.length < current.files.length) {
  throw new Error('candidate migration history is shorter than the active schema')
}
for (let index = 0; index < current.files.length; index += 1) {
  const before = current.files[index]
  const after = candidate.files[index]
  if (before.filename !== after.filename || before.sha256 !== after.sha256) {
    throw new Error(`migration history changed at ${before.filename ?? index}`)
  }
}
const pending = candidate.files.slice(current.files.length)
for (const migration of pending) {
  if (migration.expandContractCompatible !== true || !Array.isArray(migration.blockingOperations) || migration.blockingOperations.length > 0) {
    throw new Error(`unsupported destructive or contract migration: ${migration.filename}`)
  }
}
process.stdout.write(`pending_expand_migrations=${pending.length}\n`)
NODE
}

validate_server_environment_values() {
  local effective_uid=$1
  local deploy_uid=$2
  local owner_uid=$3
  local mode=$4
  local content=$5
  local mode_value

  test "${effective_uid}" = 0 || {
    echo "activation must run through constrained sudo" >&2
    return 1
  }
  [[ "${deploy_uid}" =~ ^[0-9]+$ ]] && [ "${deploy_uid}" -ne 0 ] || {
    echo "direct root deployment is forbidden" >&2
    return 1
  }
  test "${owner_uid}" = 0 || {
    echo "server environment marker must be owned by root" >&2
    return 1
  }
  [[ "${mode}" =~ ^[0-7]{3,4}$ ]] || {
    echo "invalid server environment marker mode" >&2
    return 1
  }
  mode_value=$((8#${mode}))
  (( (mode_value & 8#022) == 0 )) || {
    echo "server environment marker must not be writable by deploy users" >&2
    return 1
  }
  case "${content}" in
    deployment_tier=validation) printf 'validation\n' ;;
    deployment_tier=commercial) printf 'commercial\n' ;;
    *) echo "server environment marker has invalid or additional content" >&2; return 1 ;;
  esac
}

read_server_deployment_tier() {
  local marker=$1
  local owner_uid
  local mode
  local deploy_uid
  local content

  test -f "${marker}" && test ! -L "${marker}" || {
    echo "server environment marker must be a regular non-symlink file" >&2
    return 1
  }
  read -r owner_uid mode < <(stat -Lc '%u %a' "${marker}")
  deploy_uid=${SUDO_UID:-$(id -u)}
  content=$(cat "${marker}")
  validate_server_environment_values "$(id -u)" "${deploy_uid}" "${owner_uid}" "${mode}" "${content}"
}

verify_release_intent_for_tier() {
  local release_intent=$1
  local deployment_tier=$2
  case "${release_intent}:${deployment_tier}" in
    commercial:commercial|validation-only:validation) return 0 ;;
    *) echo "release intent does not match the root-owned server deployment tier" >&2; return 1 ;;
  esac
}

verify_root_owned_release_tree() {
  local release_tree=$1
  test -d "${release_tree}" && test ! -L "${release_tree}"
  test -z "$(find "${release_tree}" -xdev -type l -print -quit)" || {
    echo "release directory must not contain symlinks" >&2
    return 1
  }
  test -z "$(find "${release_tree}" -xdev \( ! -user root -o -perm /022 \) -print -quit)" || {
    echo "release directory must be root-owned, non-symlink and immutable to deploy users" >&2
    return 1
  }
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

release_dir=${1:?release directory is required}
public_url=${2:?public URL is required}
backup_max_age_minutes=${3:?backup age is required}

install_root=/opt/mbox
network=mbox-net
caddy_container=mbox-caddy
active_container=mbox-app
manifest=${release_dir}/release-manifest.json
secrets_env=${install_root}/secrets/app.env
current_link=${install_root}/current
env_link=${install_root}/.env
uploader=${release_dir}/upload-oss-verified.sh
audit_sender=${release_dir}/send-sls-events.sh
audit_queue=${install_root}/observability/pending-release-events.jsonl
audit_queue_lock=${install_root}/observability/pending-events.lock
server_environment_marker=${MBOX_SERVER_ENVIRONMENT_MARKER:-/etc/mbox/environment}

case "${release_dir}" in
  /opt/mbox/releases/*) ;;
  *) echo "release directory is outside /opt/mbox/releases" >&2; exit 1 ;;
esac
[[ "${backup_max_age_minutes}" =~ ^[0-9]+$ ]]
test -f "${manifest}"
test -f "${secrets_env}"
test -x "${uploader}"
test -x "${audit_sender}"
command -v flock >/dev/null
docker network inspect "${network}" >/dev/null
docker inspect "${caddy_container}" >/dev/null
docker inspect "${active_container}" >/dev/null

release_sha=$(jq -er '.releaseSha' "${manifest}")
release_version=$(jq -er '.releaseVersion' "${manifest}")
image_tag=$(jq -er '.imageTag' "${manifest}")
expected_digest=$(jq -er '.imageDigest' "${manifest}")
manifest_intent=$(jq -r '.releaseIntent // "commercial"' "${manifest}")
archive_name=$(jq -er '.archive' "${manifest}")
expected_archive_sha=$(jq -er '.archiveSha256' "${manifest}")
migration_digest=$(jq -er '.migration.digest' "${manifest}")
short_sha=${release_sha:0:7}
archive=${release_dir}/${archive_name}
deployment_tier=$(read_server_deployment_tier "${server_environment_marker}")
verify_root_owned_release_tree "${release_dir}"

verify_release_intent_for_tier "${manifest_intent}" "${deployment_tier}"

emit_release_audit() {
  local event_type=$1
  local severity=$2
  local outcome=$3
  local event_file
  event_file=$(mktemp)
  jq -nc \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg eventType "${event_type}" \
    --arg severity "${severity}" \
    --arg outcome "${outcome}" \
    --arg releaseSha "${release_sha}" \
    --arg imageDigest "${expected_digest}" \
    '{timestamp:$timestamp,eventType:$eventType,severity:$severity,outcome:$outcome,releaseSha:$releaseSha,imageDigest:$imageDigest,logstore:"release-audit"}' \
    > "${event_file}"
  if ! "${audit_sender}" "${event_file}" >/dev/null 2>&1; then
    install -d -m 0700 "$(dirname "${audit_queue}")"
    (
      flock -x 9
      cat "${event_file}" >> "${audit_queue}"
      chmod 0600 "${audit_queue}"
    ) 9>"${audit_queue_lock}"
  fi
  rm -f "${event_file}"
}

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${expected_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${archive_name}" != */* ]]
test -f "${archive}"
test "$(sha256sum "${archive}" | awk '{print $1}')" = "${expected_archive_sha}"

verify_archive_image_identity "${archive}" "${image_tag}" "${expected_digest}"

docker load --input "${archive}" >/dev/null
verify_loaded_image_identity "${image_tag}" "${expected_digest}"
actual_sha=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
actual_version=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
test "${actual_sha}" = "${release_sha}"
test "${actual_version}" = "${release_version}"
emit_release_audit deployment_started info candidate-preparation

old_image_id=$(docker inspect "${active_container}" --format '{{.Image}}')
old_release_sha=$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
require_image_id "${old_image_id}"
[[ "${old_release_sha}" =~ ^[0-9a-f]{40}$ ]]

test -f "${current_link}/release-manifest.json" || {
  echo "active release manifest is required to prove schema compatibility" >&2
  exit 1
}
current_release_sha=$(jq -er '.releaseSha' "${current_link}/release-manifest.json")
test "${current_release_sha}" = "${old_release_sha}" || {
  echo "active container SHA does not match active schema manifest" >&2
  exit 1
}
verify_expand_contract_migrations "${current_link}/release-manifest.json" "${manifest}"

candidate="mbox-candidate-${short_sha}"
candidate_volume="mbox-data-${short_sha}-candidate"
rollback_container=
traffic_switched=0
old_renamed=0
promoted=0
complete=0
migration_attempted=0

rollback_on_error() {
  local exit_code=$?
  local rollback_ok=1
  local rollback_response
  [ "${complete}" = 1 ] && return
  set +e
  echo "deployment failed; restoring previous application without restoring the database" >&2
  emit_release_audit deployment_failed error automatic-application-rollback
  if [ "${migration_attempted}" = 1 ]; then
    emit_release_audit schema_retained warning expand-contract-database-not-restored
  fi
  emit_release_audit rollback_started warning previous-release-restore-started
  if [ "${promoted}" = 1 ]; then
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
    docker rename "${active_container}" "mbox-failed-${short_sha}-$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1
    docker rename "${rollback_container}" "${active_container}" >/dev/null 2>&1
    docker start "${active_container}" >/dev/null 2>&1
  elif [ "${old_renamed}" = 1 ]; then
    docker rename "${rollback_container}" "${active_container}" >/dev/null 2>&1
    docker start "${active_container}" >/dev/null 2>&1
  fi
  if [ "${traffic_switched}" = 1 ]; then
    docker exec "${caddy_container}" \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  fi
  docker update --restart=no "${candidate}" >/dev/null 2>&1
  docker stop -t 10 "${candidate}" >/dev/null 2>&1
  test "$(docker inspect "${active_container}" --format '{{.State.Running}}' 2>/dev/null)" = true || rollback_ok=0
  rollback_response=$(curl -fsS --max-time 10 "${public_url}/api/ready" 2>/dev/null || true)
  verify_rollback_identity "${active_container}" "${old_image_id}" "${old_release_sha}" "${rollback_response}" >/dev/null 2>&1 || rollback_ok=0
  if [ "${rollback_ok}" = 1 ]; then
    emit_release_audit rollback_succeeded warning previous-release-restored
  else
    emit_release_audit rollback_failed error previous-release-restore-unverified
  fi
  exit "${exit_code}"
}
trap rollback_on_error ERR INT TERM

release_env=${release_dir}/app.env
cp "${secrets_env}" "${release_env}"
chmod 0600 "${release_env}"

set_env() {
  local key=$1
  local value=$2
  local temporary
  temporary=$(mktemp "${release_dir}/.app.env.XXXXXX")
  awk -F= -v key="${key}" '$1 != key { print }' "${release_env}" > "${temporary}"
  printf '%s=%s\n' "${key}" "${value}" >> "${temporary}"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${release_env}"
}

set_env MBOX_RELEASE_SHA "${release_sha}"
set_env MBOX_RELEASE_IMAGE_DIGEST "${expected_digest}"

current_migration_digest=
if [ -f "${current_link}/release-manifest.json" ]; then
  current_migration_digest=$(jq -r '.migration.digest // empty' "${current_link}/release-manifest.json")
fi
migration_changed=0
if [ "${current_migration_digest}" != "${migration_digest}" ]; then
  migration_changed=1
fi

backup_path=
recent_backup=$(find "${install_root}/backups" -type f -name 'mbox-*.dump' \
  -mmin "-${backup_max_age_minutes}" -print -quit)
if [ "${deployment_tier}" = commercial ] || [ "${migration_changed}" = 1 ] || [ -z "${recent_backup}" ]; then
  backup_path=$("${install_root}/bin/backup-postgres.sh")
fi
selected_backup=${backup_path:-${recent_backup}}
test -n "${selected_backup}"
test -f "${selected_backup}"
backup_stage=${release_dir}/oss-backup
rm -rf "${backup_stage}"
install -d -m 0700 "${backup_stage}"
backup_name=$(basename "${selected_backup}")
ln "${selected_backup}" "${backup_stage}/${backup_name}" 2>/dev/null \
  || cp "${selected_backup}" "${backup_stage}/${backup_name}"
(
  cd "${backup_stage}"
  sha256sum "${backup_name}" > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-backup-verification.json" \
  "${uploader}" "${backup_stage}" "mbox/backups/$(date -u +%Y-%m-%d)/${release_sha}"

if [ "${migration_changed}" = 1 ]; then
  migration_attempted=1
  docker run --rm \
    --env-file "${release_env}" \
    --network "${network}" \
    "${image_tag}" \
    node dist-server/server/migrate.js
fi

if docker inspect "${candidate}" >/dev/null 2>&1; then
  docker update --restart=no "${candidate}" >/dev/null
  docker stop -t 10 "${candidate}" >/dev/null 2>&1 || true
  docker rm "${candidate}" >/dev/null
fi

docker run -d \
  --name "${candidate}" \
  --restart=no \
  --env-file "${release_env}" \
  --network "${network}" \
  --volume "${candidate_volume}:/data" \
  "${image_tag}" >/dev/null

verify_container_image_identity "${candidate}" "${expected_digest}"

for _ in $(seq 1 60); do
  health=$(docker inspect "${candidate}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "${health}" = healthy ] && break
  [ "${health}" = unhealthy ] && {
    docker logs --tail 100 "${candidate}" >&2
    exit 1
  }
  sleep 2
done
test "$(docker inspect "${candidate}" --format '{{.State.Health.Status}}')" = healthy

candidate_ready=$(docker exec "${candidate}" \
  wget -q -O - http://127.0.0.1:8787/api/ready)
printf '%s' "${candidate_ready}" | jq -e \
  --arg sha "${release_sha}" \
  --arg digest "${expected_digest}" \
  '.status == "ready"
    and .repository == "postgres"
    and .projectionReady == true
    and .projectionCountsMatch == true
    and .kdsAuthorityConsistent == true
    and .releaseSha == $sha
    and .releaseImageDigest == $digest' >/dev/null

current_caddy=${release_dir}/Caddyfile.previous
candidate_caddy=${release_dir}/Caddyfile.candidate
docker exec "${caddy_container}" cat /etc/caddy/Caddyfile > "${current_caddy}"
grep -q 'mbox-app:8787' "${current_caddy}"
sed "s/mbox-app:8787/${candidate}:8787/g" "${current_caddy}" > "${candidate_caddy}"
docker cp "${candidate_caddy}" "${caddy_container}:/tmp/Caddyfile.candidate"
docker exec "${caddy_container}" \
  caddy validate --config /tmp/Caddyfile.candidate --adapter caddyfile >/dev/null
docker exec "${caddy_container}" \
  caddy reload --config /tmp/Caddyfile.candidate --adapter caddyfile >/dev/null
traffic_switched=1

verify_public_release() {
  local attempts=${1:-12}
  local response
  for _ in $(seq 1 "${attempts}"); do
    response=$(curl -fsS --max-time 10 "${public_url}/api/ready" 2>/dev/null || true)
    if printf '%s' "${response}" | jq -e \
      --arg sha "${release_sha}" \
      --arg digest "${expected_digest}" \
      '.status == "ready"
        and .projectionReady == true
        and .projectionCountsMatch == true
        and .kdsAuthorityConsistent == true
        and .releaseSha == $sha
        and .releaseImageDigest == $digest' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_public_release 15

rollback_container="mbox-app-rollback-${short_sha}-$(date +%Y%m%d-%H%M%S)"
docker update --restart=no "${active_container}" >/dev/null
docker stop -t 30 "${active_container}" >/dev/null
docker rename "${active_container}" "${rollback_container}"
old_renamed=1

docker rename "${candidate}" "${active_container}"
promoted=1
docker update --restart=unless-stopped "${active_container}" >/dev/null
verify_container_release_identity "${active_container}" "${expected_digest}" "${release_sha}"
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_release 15
emit_release_audit cutover_succeeded info public-readiness-verified

deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg deployedAt "${deployed_at}" \
  --arg tier "${deployment_tier}" \
  --arg releaseIntent "${manifest_intent}" \
  --arg publicUrl "${public_url}" \
  --arg releaseSha "${release_sha}" \
  --arg releaseVersion "${release_version}" \
  --arg imageTag "${image_tag}" \
  --arg imageDigest "${expected_digest}" \
  --arg previousImageId "${old_image_id}" \
  --arg previousReleaseSha "${old_release_sha}" \
  --arg migrationDigest "${migration_digest}" \
  --argjson migrationChanged "${migration_changed}" \
  --arg backupPath "${backup_path}" \
  --arg rollbackContainer "${rollback_container}" \
  '{
    schemaVersion: 1,
    deployedAt: $deployedAt,
    tier: $tier,
    releaseIntent: $releaseIntent,
    commercialRelease: ($releaseIntent == "commercial"),
    publicUrl: $publicUrl,
    releaseSha: $releaseSha,
    releaseVersion: $releaseVersion,
    imageTag: $imageTag,
    imageDigest: $imageDigest,
    imageIdentity: {
      kind: "docker-config-sha256",
      imageId: $imageDigest
    },
    previousRelease: {
      imageId: $previousImageId,
      releaseSha: $previousReleaseSha
    },
    migrationDigest: $migrationDigest,
    migrationChanged: ($migrationChanged == 1),
    backupPath: (if $backupPath == "" then null else $backupPath end),
    rollbackContainer: $rollbackContainer
  }' > "${release_dir}/deployment-manifest.json"

deployment_evidence=${release_dir}/oss-deployment
rm -rf "${deployment_evidence}"
install -d -m 0700 "${deployment_evidence}"
cp "${release_dir}/deployment-manifest.json" "${deployment_evidence}/"
cp "${release_dir}/predeployment-oss-verification.json" "${deployment_evidence}/"
cp "${release_dir}/oss-backup-verification.json" "${deployment_evidence}/"
(
  cd "${deployment_evidence}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-deployment-verification.json" \
  "${uploader}" "${deployment_evidence}" "mbox/evidence/rc/v${release_version}/${release_sha}/deployment"

ln -sfn "${release_dir}" "${current_link}"
ln -sfn "${release_env}" "${env_link}"
emit_release_audit deployment_succeeded info immutable-release-active

if ! MBOX_OSS_PRUNE_APPLY=1 "${release_dir}/prune-oss-images.sh" >/dev/null; then
  emit_release_audit critical_audit warning rollback-image-prune-deferred
fi

complete=1
trap - ERR INT TERM
printf 'release=%s\nsha=%s\nimage_digest=%s\nrollback=%s\nbackup=%s\n' \
  "${release_version}" "${release_sha}" "${expected_digest}" \
  "${rollback_container}" "${backup_path:-reused-recent-backup}"
