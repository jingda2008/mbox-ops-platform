#!/usr/bin/env bash
set -Eeuo pipefail

release_dir=${1:?release directory is required}
deployment_tier=${2:?deployment tier is required}
public_url=${3:?public URL is required}
backup_max_age_minutes=${4:?backup age is required}

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
public_verifier=${release_dir}/verify-public-app.sh
audit_queue=${install_root}/observability/pending-release-events.jsonl
audit_queue_lock=${install_root}/observability/pending-events.lock
state_helper=${release_dir}/release-state.sh
env_normalizer=${release_dir}/normalize-runtime-env.sh
database_backupper=${release_dir}/backup-postgres.sh
database_restorer=${release_dir}/restore-postgres.sh
state_file=${release_dir}/release-state.json
database_maintenance_env=${install_root}/secrets/database-maintenance.env

case "${release_dir}" in
  /opt/mbox/releases/*) ;;
  *) echo "release directory is outside /opt/mbox/releases" >&2; exit 1 ;;
esac
case "${deployment_tier}" in
  validation|production) ;;
  *) echo "unsupported deployment tier" >&2; exit 1 ;;
esac
[[ "${backup_max_age_minutes}" =~ ^[0-9]+$ ]]
test -f "${manifest}"
test -f "${secrets_env}"
test -x "${uploader}"
test -x "${audit_sender}"
test -x "${public_verifier}"
test -x "${state_helper}"
test -x "${env_normalizer}"
test -x "${database_backupper}"
test -x "${database_restorer}"
jq -e '
  .deploymentScope == {
    kind: "normalized-staff-service-database",
    includes: ["normalized-web", "normalized-server", "normalized-database"],
    excludes: ["wechat-miniprogram"]
  }
' "${manifest}" >/dev/null
# shellcheck source=release-state.sh
source "${state_helper}"
release_lock_acquire "${install_root}" 0

verify_deployment_scripts() {
  local count=0
  local script_name
  local expected_sha
  while IFS=$'\t' read -r script_name expected_sha; do
    [[ "${script_name}" =~ ^[a-z0-9-]+\.sh$ ]]
    [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ ]]
    test -f "${release_dir}/${script_name}"
    test "$(sha256sum "${release_dir}/${script_name}" | awk '{print $1}')" = "${expected_sha}"
    count=$((count + 1))
  done < <(jq -er '.deploymentScripts | to_entries[] | [.value.file,.value.sha256] | @tsv' "${manifest}")
  test "${count}" = 12
}
verify_deployment_scripts
command -v flock >/dev/null
docker network inspect "${network}" >/dev/null
docker inspect "${caddy_container}" >/dev/null
docker inspect "${active_container}" >/dev/null

release_sha=$(jq -er '.releaseSha' "${manifest}")
release_version=$(jq -er '.releaseVersion' "${manifest}")
source_branch=$(jq -er '.sourceBranch' "${manifest}")
runtime_config_version=$(jq -er '.runtimeConfigVersion' "${manifest}")
image_tag=$(jq -er '.imageTag' "${manifest}")
expected_digest=$(jq -er '.imageDigest' "${manifest}")
archive_name=$(jq -er '.archive' "${manifest}")
expected_archive_sha=$(jq -er '.archiveSha256' "${manifest}")
migration_digest=$(jq -er '.migration.digest' "${manifest}")
expected_schema_version=$(jq -er '.migration.count' "${manifest}")
store_config_name=$(jq -er '.configuration.store.file' "${manifest}")
store_config_sha=$(jq -er '.configuration.store.sha256' "${manifest}")
catalog_config_name=$(jq -er '.configuration.catalog.file' "${manifest}")
catalog_config_sha=$(jq -er '.configuration.catalog.sha256' "${manifest}")
short_sha=${release_sha:0:7}
archive=${release_dir}/${archive_name}
store_config=${release_dir}/${store_config_name}
catalog_config=${release_dir}/${catalog_config_name}

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
[[ "${expected_schema_version}" =~ ^[0-9]+$ ]]
[[ "${archive_name}" != */* ]]
[[ "${store_config_name}" != */* ]]
[[ "${catalog_config_name}" != */* ]]
test -f "${archive}"
test -f "${store_config}"
test -f "${catalog_config}"
test "$(sha256sum "${archive}" | awk '{print $1}')" = "${expected_archive_sha}"
test "$(sha256sum "${store_config}" | awk '{print $1}')" = "${store_config_sha}"
test "$(sha256sum "${catalog_config}" | awk '{print $1}')" = "${catalog_config_sha}"

archive_reference_digest=$(tar -xOf "${archive}" index.json \
  | jq -er '.manifests[] | select(.annotations["org.opencontainers.image.ref.name"] != null) | .digest' \
  | head -n 1)
archive_reference_hash=${archive_reference_digest#sha256:}
archive_reference_blob="blobs/sha256/${archive_reference_hash}"
test "$(tar -xOf "${archive}" "${archive_reference_blob}" | sha256sum | awk '{print $1}')" = "${archive_reference_hash}"
archive_reference_media_type=$(tar -xOf "${archive}" "${archive_reference_blob}" | jq -er '.mediaType')

case "${archive_reference_media_type}" in
  application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
    # Buildx may preserve the image ID as the tagged OCI index digest.
    test "${archive_reference_digest}" = "${expected_digest}"
    platform_manifest_digest=$(tar -xOf "${archive}" "${archive_reference_blob}" \
      | jq -er '.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' \
      | head -n 1)
    ;;
  application/vnd.oci.image.manifest.v1+json|application/vnd.docker.distribution.manifest.v2+json)
    # Docker save may flatten a single-platform index into a directly tagged manifest.
    platform_manifest_digest=${archive_reference_digest}
    ;;
  *)
    echo "unsupported OCI reference media type: ${archive_reference_media_type}" >&2
    exit 1
    ;;
esac
test "${archive_reference_digest}" = "${expected_digest}"
platform_manifest_hash=${platform_manifest_digest#sha256:}
platform_manifest_blob="blobs/sha256/${platform_manifest_hash}"
test "$(tar -xOf "${archive}" "${platform_manifest_blob}" | sha256sum | awk '{print $1}')" = "${platform_manifest_hash}"

archive_config_digest=$(tar -xOf "${archive}" "${platform_manifest_blob}" | jq -er '.config.digest')
archive_config_hash=${archive_config_digest#sha256:}
archive_config_blob="blobs/sha256/${archive_config_hash}"
test "$(tar -xOf "${archive}" "${archive_config_blob}" | sha256sum | awk '{print $1}')" = "${archive_config_hash}"
tar -xOf "${archive}" "${archive_config_blob}" \
  | jq -e '.os == "linux" and .architecture == "amd64"' >/dev/null

docker load --input "${archive}" >/dev/null
actual_image_digest=$(docker image inspect "${image_tag}" --format '{{.Id}}')
actual_sha=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
actual_version=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
test "${actual_image_digest}" = "${expected_digest}"
test "${actual_sha}" = "${release_sha}"
test "${actual_version}" = "${release_version}"
test "${source_branch}" = main
test "${runtime_config_version}" = normalized-runtime-config/v1
rm -f "${state_file}"
release_state_init "${state_file}" "${release_sha}" "${expected_digest}"
release_state_transition "${state_file}" frozen artifact_verified
emit_release_audit deployment_started info candidate-preparation

# Public traffic may traverse a separate edge address from the deployment
# host. Treat a short edge handshake timeout as transient, but keep a bounded
# fail-closed window before any database write or writer drain begins.
fetch_public_ready_response() {
  local expected_status=$1 output_file=$2 attempts=${3:-12}
  local attempt status temporary
  [[ "${expected_status}" =~ ^[0-9]{3}$ ]]
  [[ "${attempts}" =~ ^[0-9]+$ ]]
  [ "${attempts}" -ge 1 ] && [ "${attempts}" -le 30 ]
  temporary=$(mktemp "${release_dir}/.public-ready.XXXXXX")
  for attempt in $(seq 1 "${attempts}"); do
    status=$(curl -sS --connect-timeout 3 --max-time 8 \
      -H 'Accept: application/json' -H 'User-Agent: mbox-release-preflight/1.0' \
      -o "${temporary}" -w '%{http_code}' "${public_url}/api/ready" 2>/dev/null || true)
    if [ "${status}" = "${expected_status}" ]; then
      mv "${temporary}" "${output_file}"
      return 0
    fi
    sleep 2
  done
  rm -f "${temporary}"
  return 1
}

write_release_failure() {
  local exit_code=$1 recovery=$2
  local stage active_healthy=false database_write_started=false cutover_started=false
  stage=$(jq -r '.current // "unknown"' "${state_file}" 2>/dev/null || printf unknown)
  [ -f "${release_dir}/.database-write-started" ] && database_write_started=true
  [ -f "${release_dir}/.cutover-started" ] && cutover_started=true
  if curl -fsS --max-time 5 -H 'Accept: application/json' "${public_url}/api/ready" \
    | jq -e '.status == "ready"' >/dev/null 2>&1; then
    active_healthy=true
  fi
  jq -n \
    --arg failedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg releaseSha "${release_sha}" \
    --arg imageDigest "${expected_digest}" \
    --arg stage "${stage}" \
    --arg recovery "${recovery}" \
    --argjson exitCode "${exit_code}" \
    --argjson databaseWriteStarted "${database_write_started}" \
    --argjson cutoverStarted "${cutover_started}" \
    --argjson activeHealthy "${active_healthy}" \
    '{schemaVersion:1,failedAt:$failedAt,releaseSha:$releaseSha,imageDigest:$imageDigest,stage:$stage,exitCode:$exitCode,databaseWriteStarted:$databaseWriteStarted,cutoverStarted:$cutoverStarted,recovery:$recovery,activeReleaseHealthy:$activeHealthy}' \
    > "${release_dir}/release-failure.json"
  chmod 0600 "${release_dir}/release-failure.json"
  install -d -m 0700 "${install_root}/release-failures"
  install -m 0600 "${release_dir}/release-failure.json" \
    "${install_root}/release-failures/${release_sha}.json"
}

record_preflight_failure() {
  local exit_code=${1:-$?}
  trap - ERR INT TERM
  set +e
  write_release_failure "${exit_code}" active-release-untouched
  emit_release_audit deployment_failed error preflight-rejected
  exit "${exit_code}"
}
trap 'record_preflight_failure $?' ERR
trap 'record_preflight_failure 130' INT
trap 'record_preflight_failure 143' TERM

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
set_env APP_COMMIT_SHA "${release_sha}"
set_env MBOX_DEPLOYMENT_TIER "${deployment_tier}"
set_env MBOX_PUBLIC_URL "${public_url}"
set_env MBOX_EXPECTED_RELEASE_SHA "${release_sha}"
set_env MBOX_EXPECTED_IMAGE_DIGEST "${expected_digest}"
"${env_normalizer}" "${release_env}" "${deployment_tier}"

docker run --rm \
  --env-file "${release_env}" \
  --network "${network}" \
  --mount "type=bind,src=${store_config},dst=/run/mbox-config/store.json,readonly" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  "${image_tag}" \
  node dist-normalized/server/verify-normalized-runtime-config.js --store=/run/mbox-config/store.json \
  > "${release_dir}/config-preflight.json"
release_state_transition "${state_file}" artifact_verified config_preflight_passed

docker run --rm \
  --env-file "${release_env}" \
  --network "${network}" \
  --mount "type=bind,src=${store_config},dst=/run/mbox-config/store.json,readonly" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  "${image_tag}" \
  node dist-normalized/server/verify-normalized-runtime-config.js --external --store=/run/mbox-config/store.json \
  > "${release_dir}/external-preflight.json"
release_state_transition "${state_file}" config_preflight_passed external_preflight_passed

previous_release_dir=$(readlink -f "${current_link}" 2>/dev/null || true)
test -n "${previous_release_dir}"
test -f "${previous_release_dir}/release-manifest.json"
previous_ready_file=$(mktemp "${release_dir}/.previous-ready.XXXXXX")
fetch_public_ready_response 200 "${previous_ready_file}" 12
previous_ready=$(cat "${previous_ready_file}")
rm -f "${previous_ready_file}"
previous_release_sha=$(jq -er '.releaseSha' "${previous_release_dir}/release-manifest.json")
previous_release_digest=$(jq -er '.imageDigest' "${previous_release_dir}/release-manifest.json")
previous_schema_version=$(jq -er '.migration.count' "${previous_release_dir}/release-manifest.json")
previous_deployment_tier=$(jq -r '.tier // empty' "${previous_release_dir}/deployment-manifest.json" 2>/dev/null || true)
if [ -z "${previous_deployment_tier}" ]; then
  previous_deployment_tier=$(docker inspect "${active_container}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^MBOX_DEPLOYMENT_TIER=//p' | head -n 1)
fi
previous_deployment_tier=${previous_deployment_tier:-validation}
previous_public_extended_identity=0
if printf '%s' "${previous_ready}" | jq -e \
  --arg sha "${previous_release_sha}" \
  --arg digest "${previous_release_digest}" \
  --arg tier "${previous_deployment_tier}" \
  '.commitSha == $sha and .releaseImageDigest == $digest and .deploymentTier == $tier' >/dev/null 2>&1; then
  previous_public_extended_identity=1
fi
printf '%s' "${previous_ready}" | jq -e --arg sha "${previous_release_sha}" \
  '.status == "ready" and .commitSha == $sha' >/dev/null
[[ "${previous_release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${previous_release_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${previous_schema_version}" =~ ^[0-9]+$ ]]
case "${previous_deployment_tier}" in validation|production) ;; *) exit 1 ;; esac

current_migration_digest=
if [ -f "${current_link}/release-manifest.json" ]; then
  current_migration_digest=$(jq -r '.migration.digest // empty' "${current_link}/release-manifest.json")
fi
migration_changed=0
if [ "${current_migration_digest}" != "${migration_digest}" ]; then
  migration_changed=1
fi
contract_migration=0
if [ "${previous_schema_version}" -lt 96 ] && [ "${expected_schema_version}" -ge 96 ]; then
  contract_migration=1
fi
candidate="mbox-candidate-${short_sha}"
candidate_volume="mbox-data-${short_sha}-candidate"
maintenance_container="mbox-maintenance-${short_sha}"
maintenance_current_caddy="${release_dir}/.Caddyfile.contract-current"
maintenance_candidate_caddy="${release_dir}/.Caddyfile.contract-maintenance"
rollback_container=
complete=0
selected_backup=
contract_database_url=
contract_database_identity=
contract_admin_database_url=
backup_database_url=
application_database_service=
backup_database_service=
admin_database_service=
database_pgservice_file=
database_pgpass_file=
runtime_database_identity=
candidate_database_identity=
database_maintenance_loaded=0
contract_restore_evidence=${release_dir}/contract-restore-source.json
contract_restore_report=${release_dir}/contract-restore-report.json

load_database_maintenance_secrets() {
  [ "${database_maintenance_loaded}" = 0 ] || return 0
  test -f "${database_maintenance_env}"
  test "$(stat -c '%u:%a' "${database_maintenance_env}")" = 0:600
  for key in APPLICATION_DATABASE_SERVICE BACKUP_DATABASE_SERVICE ADMIN_DATABASE_SERVICE \
    PGSERVICEFILE PGPASSFILE; do
    test "$(awk -F= -v expected="${key}" '$1 == expected { count += 1 } END { print count + 0 }' \
      "${database_maintenance_env}")" = 1
  done
  test -z "$(awk -F= '
    /^[[:space:]]*($|#)/ { next }
    $1 != "APPLICATION_DATABASE_SERVICE" && $1 != "BACKUP_DATABASE_SERVICE"
      && $1 != "ADMIN_DATABASE_SERVICE" && $1 != "PGSERVICEFILE" && $1 != "PGPASSFILE" { print NR }
  ' "${database_maintenance_env}")"
  application_database_service=$(sed -n 's/^APPLICATION_DATABASE_SERVICE=//p' "${database_maintenance_env}")
  backup_database_service=$(sed -n 's/^BACKUP_DATABASE_SERVICE=//p' "${database_maintenance_env}")
  admin_database_service=$(sed -n 's/^ADMIN_DATABASE_SERVICE=//p' "${database_maintenance_env}")
  database_pgservice_file=$(sed -n 's/^PGSERVICEFILE=//p' "${database_maintenance_env}")
  database_pgpass_file=$(sed -n 's/^PGPASSFILE=//p' "${database_maintenance_env}")
  for service in "${application_database_service}" "${backup_database_service}" \
    "${admin_database_service}"; do
    [[ "${service}" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]]
  done
  for secret_file in "${database_pgservice_file}" "${database_pgpass_file}"; do
    case "${secret_file}" in /opt/mbox/secrets/*) ;; *) exit 1 ;; esac
    test -f "${secret_file}"
    test "$(stat -c '%u:%a' "${secret_file}")" = 0:600
  done
  ! grep -Eiq '^[[:space:]]*(password|passfile)[[:space:]]*=' "${database_pgservice_file}"
  contract_database_url="service=${application_database_service}"
  backup_database_url="service=${backup_database_service}"
  contract_admin_database_url="service=${admin_database_service}"
  database_maintenance_loaded=1
}

assert_backup_targets_application_database() {
  local application_database_identity backup_database_identity running
  running=$(docker inspect "${active_container}" --format '{{.State.Running}}')
  if [ "${running}" = true ]; then
    runtime_database_identity=$(docker exec -i "${active_container}" node <<'NODE'
const {Client}=require('pg')
const client=new Client({connectionString:process.env.DATABASE_URL})
client.connect()
  .then(()=>client.query(`SELECT current_database() || '|' ||
    COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port') AS identity`))
  .then((result)=>{process.stdout.write(result.rows[0].identity);return client.end()})
  .catch((error)=>{console.error(error.message);process.exit(1)})
NODE
    )
  fi
  test -n "${runtime_database_identity}"
  application_database_identity=$(PGSERVICEFILE="${database_pgservice_file}" \
    PGPASSFILE="${database_pgpass_file}" psql -XAt --dbname="${contract_database_url}" \
    --command="SELECT current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port')")
  backup_database_identity=$(PGSERVICEFILE="${database_pgservice_file}" \
    PGPASSFILE="${database_pgpass_file}" PGOPTIONS='-c default_transaction_read_only=on' \
    psql -XAt --dbname="${backup_database_url}" \
    --command="SELECT current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port')")
  test -n "${application_database_identity}"
  test "${application_database_identity}" = "${runtime_database_identity}"
  test -n "${candidate_database_identity}"
  test "${application_database_identity}" = "${candidate_database_identity}"
  test "${backup_database_identity}" = "${application_database_identity}"
}

restore_contract_database_and_previous_app() {
  local exit_code=$1
  local rollback_ok=1
  local current_state
  local failed_container="mbox-failed-${short_sha}-$(date +%Y%m%d-%H%M%S)"
  trap - ERR INT TERM
  set +e

  if [ -f "${release_dir}/.contract-write-resumed" ]; then
    current_state=$(jq -r '.current // "unknown"' "${state_file}" 2>/dev/null)
    if [ -f "${release_dir}/.cutover-started" ] \
      && [ "${current_state}" = cutover_started ]; then
      docker exec "${caddy_container}" caddy reload \
        --config /tmp/Caddyfile.contract-maintenance --adapter caddyfile >/dev/null 2>&1
      if [ "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${release_sha}" ]; then
        docker update --restart=no "${active_container}" >/dev/null 2>&1
        docker stop -t 20 "${active_container}" >/dev/null 2>&1
      fi
    elif docker inspect "${candidate}" >/dev/null 2>&1; then
      docker update --restart=no "${candidate}" >/dev/null 2>&1
      docker stop -t 20 "${candidate}" >/dev/null 2>&1
      docker rm "${candidate}" >/dev/null 2>&1
    fi
    emit_release_audit rollback_failed error contract-cutover-forward-recovery-required
    write_release_failure "${exit_code}" forward-recovery-required
    exit "${exit_code}"
  fi
  if docker inspect "${candidate}" >/dev/null 2>&1; then
    docker update --restart=no "${candidate}" >/dev/null 2>&1
    docker stop -t 10 "${candidate}" >/dev/null 2>&1
  fi
  if [ "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${release_sha}" ]; then
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
    docker rename "${active_container}" "${failed_container}" >/dev/null 2>&1 || rollback_ok=0
  else
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
  fi

  if [ -f "${release_dir}/.database-write-started" ]; then
    test -n "${contract_database_url}" || rollback_ok=0
    test -n "${contract_database_identity}" || rollback_ok=0
    if [ "${rollback_ok}" = 1 ]; then
      DATABASE_SERVICE="${application_database_service}" \
        ADMIN_DATABASE_SERVICE="${admin_database_service}" \
        PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
        MBOX_EXPECTED_RESTORE_DATABASE="${contract_database_identity}" \
        MBOX_EXPECTED_RESTORE_SCHEMA_VERSION="$(printf '%03d' "${previous_schema_version}")" \
        MBOX_EXPECTED_RESTORE_MANIFEST="${previous_release_dir}/release-manifest.json" \
        MBOX_EXPECTED_RESTORE_EVIDENCE="${contract_restore_evidence}" \
        MBOX_RESTORE_REPORT="${contract_restore_report}" \
        MBOX_CONFIRM_RESTORE=RESTORE \
        "${database_restorer}" restore "${selected_backup}" >/dev/null 2>&1 || rollback_ok=0
    fi
    if [ "${rollback_ok}" = 1 ]; then
      test "$(PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
        psql -XAt --dbname="${contract_database_url}" \
        --command='SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true' \
        2>/dev/null)" = "$(printf '%03d' "${previous_schema_version}")" || rollback_ok=0
    fi
    if [ "${rollback_ok}" = 1 ]; then
      current_state=$(jq -r '.current' "${state_file}")
      release_state_transition "${state_file}" "${current_state}" database_restored >/dev/null 2>&1 \
        || rollback_ok=0
    fi
  fi

  if ! docker inspect "${active_container}" >/dev/null 2>&1 \
    && [ -n "${rollback_container}" ] \
    && [ "$(docker inspect "${rollback_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" ]; then
    docker rename "${rollback_container}" "${active_container}" >/dev/null 2>&1 || rollback_ok=0
  fi
  test "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" || rollback_ok=0
  if [ "${rollback_ok}" = 1 ]; then
    docker start "${active_container}" >/dev/null 2>&1 || rollback_ok=0
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1 || rollback_ok=0
  fi
  if [ "${rollback_ok}" = 1 ]; then
    previous_private_ready=$(docker exec "${active_container}" \
      wget -q -O - http://127.0.0.1:8787/api/ready 2>/dev/null) || rollback_ok=0
  fi
  if [ "${rollback_ok}" = 1 ]; then
    printf '%s' "${previous_private_ready}" | jq -e \
      --arg sha "${previous_release_sha}" --argjson schema "${previous_schema_version}" \
      '.status=="ready" and .commitSha==$sha and (.schemaVersion|tonumber)==$schema' \
      >/dev/null 2>&1 || rollback_ok=0
  fi
  if [ "${rollback_ok}" = 1 ]; then
    docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile \
      --adapter caddyfile >/dev/null 2>&1 || rollback_ok=0
  fi
  if [ "${rollback_ok}" = 1 ]; then
    "${public_verifier}" "${public_url}" "${previous_release_sha}" \
      "${previous_release_digest}" "${previous_schema_version}" \
      "${previous_deployment_tier}" 10 "${previous_public_extended_identity}" >/dev/null 2>&1 \
      || rollback_ok=0
  fi
  if [ "${rollback_ok}" = 1 ]; then
    if docker inspect "${maintenance_container}" >/dev/null 2>&1; then
      docker update --restart=no "${maintenance_container}" >/dev/null 2>&1
      docker stop -t 5 "${maintenance_container}" >/dev/null 2>&1
      docker rm "${maintenance_container}" >/dev/null 2>&1
    fi
  else
    docker exec "${caddy_container}" caddy reload \
      --config /tmp/Caddyfile.contract-maintenance --adapter caddyfile >/dev/null 2>&1 || true
    if [ "$(docker inspect "${active_container}" --format '{{.State.Running}}' 2>/dev/null)" = true ]; then
      docker update --restart=no "${active_container}" >/dev/null 2>&1
      docker stop -t 20 "${active_container}" >/dev/null 2>&1
    fi
  fi
  if [ "${rollback_ok}" = 1 ]; then
    current_state=$(jq -r '.current' "${state_file}")
    if [ "${current_state}" != rolled_back ]; then
      release_state_transition "${state_file}" "${current_state}" rolled_back >/dev/null 2>&1 \
        || rollback_ok=0
    fi
  fi
  if [ "${rollback_ok}" = 1 ]; then
    emit_release_audit rollback_succeeded warning contract-database-and-previous-release-restored
    write_release_failure "${exit_code}" contract-database-and-previous-release-restored
  else
    emit_release_audit rollback_failed error contract-database-restore-unverified-writes-remain-drained
    write_release_failure "${exit_code}" contract-database-restore-unverified-writes-remain-drained
  fi
  exit "${exit_code}"
}

rollback_contract_on_error() {
  restore_contract_database_and_previous_app "${1:-$?}"
}

release_state_require "${state_file}" external_preflight_passed
docker run --rm \
  --env-file "${release_env}" \
  --network "${network}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  "${image_tag}" \
  node dist-normalized/server/verify-normalized-migration-compatibility.js \
  > "${release_dir}/migration-preflight.json"
candidate_database_identity=$(jq -er \
  '.databaseIdentity | [.database,.serverAddress,.serverPort] | join("|")' \
  "${release_dir}/migration-preflight.json")
test -n "${candidate_database_identity}"
release_state_transition "${state_file}" external_preflight_passed migration_compatible

backup_path=
release_state_require "${state_file}" migration_compatible
recent_backup=
if [ "${contract_migration}" = 1 ]; then
  command -v pg_restore >/dev/null
  command -v psql >/dev/null
  load_database_maintenance_secrets
  contract_database_identity=$(PGSERVICEFILE="${database_pgservice_file}" \
    PGPASSFILE="${database_pgpass_file}" psql -XAt --dbname="${contract_database_url}" \
    --command='SELECT current_database()')
  test -n "${contract_database_identity}"
  assert_backup_targets_application_database
  trap 'rollback_contract_on_error $?' ERR
  trap 'rollback_contract_on_error 130' INT
  trap 'rollback_contract_on_error 143' TERM
  if docker inspect "${maintenance_container}" >/dev/null 2>&1; then
    docker update --restart=no "${maintenance_container}" >/dev/null
    docker stop -t 5 "${maintenance_container}" >/dev/null 2>&1 || true
    docker rm "${maintenance_container}" >/dev/null
  fi
  docker run -d --name "${maintenance_container}" --restart=no --network "${network}" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=8m --security-opt no-new-privileges \
    --cap-drop ALL "${image_tag}" node -e \
    'require("node:http").createServer((_,response)=>{response.writeHead(503,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify({status:"maintenance",reason:"table_location_contract_cutover"}))}).listen(8787,"0.0.0.0")' \
    >/dev/null
  maintenance_ip=$(docker inspect "${maintenance_container}" \
    --format "{{with index .NetworkSettings.Networks \"${network}\"}}{{.IPAddress}}{{end}}")
  [[ "${maintenance_ip}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
  docker exec "${caddy_container}" cat /etc/caddy/Caddyfile > "${maintenance_current_caddy}"
  grep -q 'mbox-app:8787' "${maintenance_current_caddy}"
  sed "s/mbox-app:8787/${maintenance_ip}:8787/g" "${maintenance_current_caddy}" \
    > "${maintenance_candidate_caddy}"
  docker cp "${maintenance_candidate_caddy}" "${caddy_container}:/tmp/Caddyfile.contract-maintenance"
  docker exec "${caddy_container}" caddy validate \
    --config /tmp/Caddyfile.contract-maintenance --adapter caddyfile >/dev/null
  docker exec "${caddy_container}" caddy reload \
    --config /tmp/Caddyfile.contract-maintenance --adapter caddyfile >/dev/null
  maintenance_response="${release_dir}/maintenance-response.json"
  fetch_public_ready_response 503 "${maintenance_response}" 12
  jq -e '.status=="maintenance" and .reason=="table_location_contract_cutover"' \
    "${maintenance_response}" >/dev/null
  docker update --restart=no "${active_container}" >/dev/null
  docker stop -t 30 "${active_container}" >/dev/null
  test "$(docker inspect "${active_container}" --format '{{.State.Running}}')" = false
  test -z "$(docker ps --filter \
    "label=org.opencontainers.image.revision=${previous_release_sha}" --format '{{.ID}}')"
  test "$(PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
    psql -XAt --dbname="${contract_database_url}" \
    --command="SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")" = 0
  : > "${release_dir}/.writer-drained"
  release_state_transition "${state_file}" migration_compatible writer_drained
  assert_backup_targets_application_database
  DATABASE_SERVICE="${backup_database_service}" \
    PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
    MBOX_EXPECTED_RESTORE_DATABASE="${contract_database_identity}" \
    "${database_restorer}" capture "${contract_restore_evidence}"
  backup_path=$(DATABASE_SERVICE="${backup_database_service}" \
    PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
    BACKUP_DIR="${install_root}/backups" \
    "${database_backupper}")
  test "$(PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
    psql -XAt --dbname="${contract_database_url}" \
    --command="SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")" = 0
else
  recent_backup=$(find "${install_root}/backups" -type f -name 'mbox-*.dump' \
    -mmin "-${backup_max_age_minutes}" -print -quit)
fi
if [ "${contract_migration}" != 1 ] \
  && { [ "${deployment_tier}" = production ] || [ "${migration_changed}" = 1 ] \
    || [ -z "${recent_backup}" ]; }; then
  load_database_maintenance_secrets
  assert_backup_targets_application_database
  backup_path=$(DATABASE_SERVICE="${backup_database_service}" \
    PGSERVICEFILE="${database_pgservice_file}" PGPASSFILE="${database_pgpass_file}" \
    BACKUP_DIR="${install_root}/backups" \
    "${database_backupper}")
fi
selected_backup=${backup_path:-${recent_backup}}
test -n "${selected_backup}"
test -f "${selected_backup}"
test -f "${selected_backup}.sha256"
backup_stage=${release_dir}/oss-backup
rm -rf "${backup_stage}"
install -d -m 0700 "${backup_stage}"
backup_name=$(basename "${selected_backup}")
ln "${selected_backup}" "${backup_stage}/${backup_name}" 2>/dev/null \
  || cp "${selected_backup}" "${backup_stage}/${backup_name}"
if [ "${contract_migration}" = 1 ]; then
  install -m 0600 "${contract_restore_evidence}" \
    "${backup_stage}/contract-restore-source.json"
  install -m 0600 "${previous_release_dir}/release-manifest.json" \
    "${backup_stage}/previous-release-manifest.json"
fi
(
  cd "${backup_stage}"
  if [ "${contract_migration}" = 1 ]; then
    sha256sum "${backup_name}" contract-restore-source.json previous-release-manifest.json \
      > SHA256SUMS
  else
    sha256sum "${backup_name}" > SHA256SUMS
  fi
  sha256sum --check SHA256SUMS >/dev/null
)
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-backup-verification.json" \
  "${uploader}" "${backup_stage}" "mbox/backups/$(date -u +%Y-%m-%d)/${release_sha}"
if [ "${contract_migration}" = 1 ]; then
  release_state_transition "${state_file}" writer_drained post_drain_backup_verified
else
  release_state_transition "${state_file}" migration_compatible backup_verified
fi

if [ "${migration_changed}" = 1 ]; then
  if [ "${contract_migration}" = 1 ]; then
    release_state_require "${state_file}" post_drain_backup_verified
  else
    release_state_require "${state_file}" backup_verified
  fi
  : > "${release_dir}/.database-write-started"
  docker run --rm \
    --env-file "${release_env}" \
    --network "${network}" \
    "${image_tag}" \
    node dist-normalized/server/migrate-normalized.js
fi
if [ "${contract_migration}" = 1 ]; then
  release_state_transition "${state_file}" post_drain_backup_verified migrated
else
  release_state_transition "${state_file}" backup_verified migrated
fi

release_state_require "${state_file}" migrated
: > "${release_dir}/.database-write-started"
docker run --rm \
  --env-file "${release_env}" \
  --env "APP_COMMIT_SHA=${release_sha}" \
  --network "${network}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --mount "type=bind,src=${store_config},dst=/run/mbox-config/store.json,readonly" \
  --mount "type=bind,src=${catalog_config},dst=/run/mbox-config/catalog.json,readonly" \
  "${image_tag}" \
  node dist-normalized/server/provision-normalized-release.js \
    --store=/run/mbox-config/store.json \
    --catalog=/run/mbox-config/catalog.json
release_state_transition "${state_file}" migrated provisioned

rollback_on_error() {
  local exit_code=${1:-$?}
  local rollback_ok=1
  local active_sha=
  local active_digest=
  local failed_container="mbox-failed-${short_sha}-$(date +%Y%m%d-%H%M%S)"
  [ "${complete}" = 1 ] && return
  trap - ERR INT TERM
  set +e
  if [ "${contract_migration}" = 1 ]; then
    restore_contract_database_and_previous_app "${exit_code}"
  fi
  echo "deployment failed; restoring previous application" >&2
  emit_release_audit deployment_failed error automatic-rollback
  emit_release_audit rollback_started warning previous-release-restore-started

  # Recover from the actual Docker state. Signals can arrive between a Docker
  # mutation and a shell flag assignment, so flags alone are not authoritative.
  if docker inspect "${active_container}" >/dev/null 2>&1; then
    active_sha=$(docker inspect "${active_container}" \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
    active_digest=$(docker inspect "${active_container}" --format '{{.Image}}' 2>/dev/null)
  fi
  if [ "${active_sha}" = "${release_sha}" ] && [ "${active_digest}" = "${expected_digest}" ]; then
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
    docker rename "${active_container}" "${failed_container}" >/dev/null 2>&1
  elif [ -n "${active_sha}" ] \
    && { [ "${active_sha}" != "${previous_release_sha}" ] \
      || [ "${active_digest}" != "${previous_release_digest}" ]; }; then
    rollback_ok=0
  fi

  if ! docker inspect "${active_container}" >/dev/null 2>&1; then
    if [ -n "${rollback_container}" ] \
      && [ "$(docker inspect "${rollback_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" ] \
      && [ "$(docker inspect "${rollback_container}" --format '{{.Image}}' 2>/dev/null)" = "${previous_release_digest}" ]; then
      docker rename "${rollback_container}" "${active_container}" >/dev/null 2>&1
    else
      rollback_ok=0
    fi
  fi

  if [ "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" ] \
    && [ "$(docker inspect "${active_container}" --format '{{.Image}}' 2>/dev/null)" = "${previous_release_digest}" ]; then
    docker start "${active_container}" >/dev/null 2>&1
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  else
    rollback_ok=0
  fi

  # Reload the canonical upstream unconditionally. This is harmless before
  # cutover and closes the signal window immediately after candidate-IP reload.
  docker exec "${caddy_container}" \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  if docker inspect "${candidate}" >/dev/null 2>&1; then
    docker update --restart=no "${candidate}" >/dev/null 2>&1
    docker stop -t 10 "${candidate}" >/dev/null 2>&1
  fi
  test "$(docker inspect "${active_container}" --format '{{.State.Running}}' 2>/dev/null)" = true || rollback_ok=0
  test "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" || rollback_ok=0
  test "$(docker inspect "${active_container}" --format '{{.Image}}' 2>/dev/null)" = "${previous_release_digest}" || rollback_ok=0
  "${public_verifier}" "${public_url}" "${previous_release_sha}" \
    "${previous_release_digest}" "${previous_schema_version}" \
    "${previous_deployment_tier}" 5 "${previous_public_extended_identity}" >/dev/null 2>&1 || rollback_ok=0
  if [ "${rollback_ok}" = 1 ]; then
    current_release_state=$(jq -r '.current // empty' "${state_file}" 2>/dev/null || true)
    if [ -n "${current_release_state}" ] && [ "${current_release_state}" != rolled_back ]; then
      release_state_transition "${state_file}" "${current_release_state}" rolled_back >/dev/null 2>&1 || true
    fi
    emit_release_audit rollback_succeeded warning previous-release-restored
    write_release_failure "${exit_code}" previous-release-restored
  else
    emit_release_audit rollback_failed error previous-release-restore-unverified
    write_release_failure "${exit_code}" previous-release-restore-unverified
  fi
  exit "${exit_code}"
}
trap 'rollback_on_error $?' ERR
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

if docker inspect "${candidate}" >/dev/null 2>&1; then
  docker update --restart=no "${candidate}" >/dev/null
  docker stop -t 10 "${candidate}" >/dev/null 2>&1 || true
  docker rm "${candidate}" >/dev/null
fi

release_state_require "${state_file}" provisioned
candidate_runtime_args=()
if [ "${contract_migration}" = 1 ]; then
  candidate_runtime_args+=(
    --env MBOX_RUNTIME_ROLE=contract_candidate
    --env MBOX_START_WORKERS=false
    --env 'PGOPTIONS=-c default_transaction_read_only=on'
  )
fi
docker run -d \
  --name "${candidate}" \
  --restart=no \
  --env-file "${release_env}" \
  "${candidate_runtime_args[@]}" \
  --network "${network}" \
  --volume "${candidate_volume}:/data" \
  "${image_tag}" >/dev/null

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
release_state_transition "${state_file}" provisioned candidate_healthy

candidate_ready=$(docker exec "${candidate}" \
  wget -q -O - http://127.0.0.1:8787/api/ready)
printf '%s' "${candidate_ready}" | jq -e \
  --arg sha "${release_sha}" \
  --arg digest "${expected_digest}" \
  --arg schemaFlavor "normalized-core-v1" \
  --arg deploymentTier "${deployment_tier}" \
  --argjson contractMigration "${contract_migration}" \
  --argjson schemaVersion "${expected_schema_version}" \
  '.status == "ready"
    and .schemaFlavor == $schemaFlavor
    and (.schemaVersion | tonumber) >= $schemaVersion
    and .commitSha == $sha
    and .releaseImageDigest == $digest
    and .deploymentTier == $deploymentTier
    and (if $contractMigration == 1
      then .runtimeRole == "contract_candidate" and .writeEnabled == false
      else .runtimeRole == "normal" and .writeEnabled == true end)' >/dev/null

candidate_ip=$(docker inspect "${candidate}" --format "{{with index .NetworkSettings.Networks \"${network}\"}}{{.IPAddress}}{{end}}")
[[ "${candidate_ip}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
verify_release_at() {
  local target_url=$1
  "${public_verifier}" "${target_url}" "${release_sha}" "${expected_digest}" \
    "${expected_schema_version}" "${deployment_tier}" "${2:-12}"
}

# The host reaches the candidate through the private Docker bridge. No public
# request is routed to it before every deep route and asset has passed.
"${public_verifier}" "http://${candidate_ip}:8787" "${release_sha}" "${expected_digest}" \
  "${expected_schema_version}" "${deployment_tier}" 15
release_state_transition "${state_file}" candidate_healthy candidate_deep_verified

if [ "${contract_migration}" = 1 ]; then
  docker update --restart=no "${candidate}" >/dev/null
  docker stop -t 20 "${candidate}" >/dev/null
  docker rm "${candidate}" >/dev/null
  : > "${release_dir}/.contract-write-resumed"
  docker run -d \
    --name "${candidate}" \
    --restart=no \
    --env-file "${release_env}" \
    --network "${network}" \
    --volume "${candidate_volume}:/data" \
    "${image_tag}" >/dev/null
  for _ in $(seq 1 60); do
    health=$(docker inspect "${candidate}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    [ "${health}" = healthy ] && break
    [ "${health}" = unhealthy ] && exit 1
    sleep 2
  done
  test "$(docker inspect "${candidate}" --format '{{.State.Health.Status}}')" = healthy
  full_candidate_ready=$(docker exec "${candidate}" wget -q -O - http://127.0.0.1:8787/api/ready)
  printf '%s' "${full_candidate_ready}" | jq -e \
    --arg sha "${release_sha}" --arg digest "${expected_digest}" \
    '.status=="ready" and .commitSha==$sha and .releaseImageDigest==$digest
      and .runtimeRole=="normal" and .writeEnabled==true' >/dev/null
fi

release_state_transition "${state_file}" candidate_deep_verified cutover_started
: > "${release_dir}/.cutover-started"
rollback_container="mbox-app-rollback-${short_sha}-$(date +%Y%m%d-%H%M%S)"
docker update --restart=no "${active_container}" >/dev/null
docker stop -t 30 "${active_container}" >/dev/null
docker rename "${active_container}" "${rollback_container}"

docker rename "${candidate}" "${active_container}"
docker update --restart=unless-stopped "${active_container}" >/dev/null
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_release_at "${public_url}" 15
release_state_transition "${state_file}" cutover_started cutover_verified
if [ "${contract_migration}" = 1 ] && docker inspect "${maintenance_container}" >/dev/null 2>&1; then
  docker update --restart=no "${maintenance_container}" >/dev/null
  docker stop -t 5 "${maintenance_container}" >/dev/null
  docker rm "${maintenance_container}" >/dev/null
fi
emit_release_audit cutover_succeeded info public-readiness-verified

deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg deployedAt "${deployed_at}" \
  --arg tier "${deployment_tier}" \
  --arg publicUrl "${public_url}" \
  --arg releaseSha "${release_sha}" \
  --arg releaseVersion "${release_version}" \
  --arg imageTag "${image_tag}" \
  --arg imageDigest "${expected_digest}" \
  --arg migrationDigest "${migration_digest}" \
  --argjson migrationChanged "${migration_changed}" \
  --arg backupPath "${backup_path}" \
  --arg rollbackContainer "${rollback_container}" \
  --arg previousReleaseDir "${previous_release_dir}" \
  --arg previousReleaseSha "${previous_release_sha}" \
  --arg storeConfigSha256 "${store_config_sha}" \
  --arg catalogConfigSha256 "${catalog_config_sha}" \
  --argjson previousIdentityComplete "${previous_public_extended_identity}" \
  --argjson previousSchemaVersion "${previous_schema_version}" \
  --argjson targetSchemaVersion "${expected_schema_version}" \
  --argjson contractMigration "${contract_migration}" \
  '{
    schemaVersion: 1,
    deployedAt: $deployedAt,
    tier: $tier,
    publicUrl: $publicUrl,
    releaseSha: $releaseSha,
    releaseVersion: $releaseVersion,
    imageTag: $imageTag,
    imageDigest: $imageDigest,
    migrationDigest: $migrationDigest,
    migrationChanged: ($migrationChanged == 1),
    backupPath: (if $backupPath == "" then null else $backupPath end),
    rollbackContainer: $rollbackContainer,
    previousReleaseDir: (if $previousReleaseDir == "" then null else $previousReleaseDir end),
    previousReleaseSha: (if $previousReleaseSha == "" then null else $previousReleaseSha end),
    previousSchemaVersion: $previousSchemaVersion,
    targetSchemaVersion: $targetSchemaVersion,
    rollbackMode: (if $contractMigration == 1
      then "forward_only_after_contract_cutover" else "application_image" end),
    previousIdentityComplete: $previousIdentityComplete,
    configuration: {storeSha256:$storeConfigSha256,catalogSha256:$catalogConfigSha256}
  }' \
  > "${release_dir}/deployment-manifest.json"

deployment_evidence=${release_dir}/oss-deployment
rm -rf "${deployment_evidence}"
install -d -m 0700 "${deployment_evidence}"
cp "${release_dir}/deployment-manifest.json" "${deployment_evidence}/"
cp "${release_dir}/predeployment-oss-verification.json" "${deployment_evidence}/"
cp "${release_dir}/oss-backup-verification.json" "${deployment_evidence}/"
cp "${release_dir}/config-preflight.json" "${deployment_evidence}/"
cp "${release_dir}/external-preflight.json" "${deployment_evidence}/"
cp "${release_dir}/migration-preflight.json" "${deployment_evidence}/"
cp "${state_file}" "${deployment_evidence}/release-state-before-evidence.json"
(
  cd "${deployment_evidence}"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-deployment-verification.json" \
  "${uploader}" "${deployment_evidence}" "mbox/evidence/rc/v${release_version}/${release_sha}/deployment"
release_state_transition "${state_file}" cutover_verified evidence_archived
release_state_transition "${state_file}" evidence_archived completed
completion_evidence=${release_dir}/oss-completion
rm -rf "${completion_evidence}"
install -d -m 0700 "${completion_evidence}"
cp "${state_file}" "${completion_evidence}/release-state.json"
cp "${release_dir}/deployment-manifest.json" "${completion_evidence}/"
(
  cd "${completion_evidence}"
  sha256sum release-state.json deployment-manifest.json > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
MBOX_OSS_VERIFICATION_REPORT="${release_dir}/oss-completion-verification.json" \
  "${uploader}" "${completion_evidence}" "mbox/evidence/rc/v${release_version}/${release_sha}/completion"

ln -sfn "${release_dir}" "${current_link}"
ln -sfn "${release_env}" "${env_link}"
# Only a fully verified candidate becomes the canonical source for the next release.
install -m 0600 "${release_env}" "${secrets_env}.next"
mv "${secrets_env}.next" "${secrets_env}"
emit_release_audit deployment_succeeded info immutable-release-active

if ! MBOX_OSS_PRUNE_APPLY=1 "${release_dir}/prune-oss-images.sh" >/dev/null; then
  emit_release_audit critical_audit warning rollback-image-prune-deferred
fi
complete=1
trap - ERR INT TERM
printf 'release=%s\nsha=%s\nimage_digest=%s\nrollback=%s\nbackup=%s\n' \
  "${release_version}" "${release_sha}" "${expected_digest}" \
  "${rollback_container}" "${backup_path:-reused-recent-backup}"
