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
audit_queue=${install_root}/observability/pending-release-events.jsonl
audit_queue_lock=${install_root}/observability/pending-events.lock

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
command -v flock >/dev/null
docker network inspect "${network}" >/dev/null
docker inspect "${caddy_container}" >/dev/null
docker inspect "${active_container}" >/dev/null

release_sha=$(jq -er '.releaseSha' "${manifest}")
release_version=$(jq -er '.releaseVersion' "${manifest}")
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

expected_index_digest=${expected_digest#sha256:}
archive_index_digest=$(tar -xOf "${archive}" index.json \
  | jq -er '.manifests[] | select(.annotations["org.opencontainers.image.ref.name"] != null) | .digest' \
  | head -n 1)
test "${archive_index_digest}" = "${expected_digest}"
archive_index_blob="blobs/sha256/${expected_index_digest}"
test "$(tar -xOf "${archive}" "${archive_index_blob}" | sha256sum | awk '{print $1}')" = "${expected_index_digest}"

platform_manifest_digest=$(tar -xOf "${archive}" "${archive_index_blob}" \
  | jq -er '.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' \
  | head -n 1)
platform_manifest_hash=${platform_manifest_digest#sha256:}
platform_manifest_blob="blobs/sha256/${platform_manifest_hash}"
test "$(tar -xOf "${archive}" "${platform_manifest_blob}" | sha256sum | awk '{print $1}')" = "${platform_manifest_hash}"

archive_config_digest=$(tar -xOf "${archive}" "${platform_manifest_blob}" | jq -er '.config.digest')
archive_config_hash=${archive_config_digest#sha256:}
archive_config_blob="blobs/sha256/${archive_config_hash}"
test "$(tar -xOf "${archive}" "${archive_config_blob}" | sha256sum | awk '{print $1}')" = "${archive_config_hash}"

docker load --input "${archive}" >/dev/null
actual_sha=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
actual_version=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
test "${actual_sha}" = "${release_sha}"
test "${actual_version}" = "${release_version}"
emit_release_audit deployment_started info candidate-preparation

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
if [ "${deployment_tier}" = production ] || [ "${migration_changed}" = 1 ] || [ -z "${recent_backup}" ]; then
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
  docker run --rm \
    --env-file "${release_env}" \
    --network "${network}" \
    "${image_tag}" \
    node dist-normalized/server/migrate-normalized.js
fi

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

candidate="mbox-candidate-${short_sha}"
candidate_volume="mbox-data-${short_sha}-candidate"
rollback_container=
traffic_switched=0
old_renamed=0
promoted=0
complete=0

rollback_on_error() {
  local exit_code=$?
  local rollback_ok=1
  local rollback_response
  [ "${complete}" = 1 ] && return
  set +e
  echo "deployment failed; restoring previous application" >&2
  emit_release_audit deployment_failed error automatic-rollback
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
  printf '%s' "${rollback_response}" | jq -e '.status == "ready"' >/dev/null 2>&1 || rollback_ok=0
  if [ "${rollback_ok}" = 1 ]; then
    emit_release_audit rollback_succeeded warning previous-release-restored
  else
    emit_release_audit rollback_failed error previous-release-restore-unverified
  fi
  exit "${exit_code}"
}
trap rollback_on_error ERR INT TERM

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
  --arg schemaFlavor "normalized-core-v1" \
  --arg deploymentTier "${deployment_tier}" \
  --argjson schemaVersion "${expected_schema_version}" \
  '.status == "ready"
    and .schemaFlavor == $schemaFlavor
    and (.schemaVersion | tonumber) >= $schemaVersion
    and .commitSha == $sha
    and .deploymentTier == $deploymentTier' >/dev/null

current_caddy=${release_dir}/Caddyfile.previous
candidate_caddy=${release_dir}/Caddyfile.candidate
docker exec "${caddy_container}" cat /etc/caddy/Caddyfile > "${current_caddy}"
grep -q 'mbox-app:8787' "${current_caddy}"
candidate_ip=$(docker inspect "${candidate}" --format "{{with index .NetworkSettings.Networks \"${network}\"}}{{.IPAddress}}{{end}}")
[[ "${candidate_ip}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
sed "s/mbox-app:8787/${candidate_ip}:8787/g" "${current_caddy}" > "${candidate_caddy}"
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
      --arg schemaFlavor "normalized-core-v1" \
      --arg deploymentTier "${deployment_tier}" \
      --argjson schemaVersion "${expected_schema_version}" \
      '.status == "ready"
        and .schemaFlavor == $schemaFlavor
        and (.schemaVersion | tonumber) >= $schemaVersion
        and .commitSha == $sha
        and .deploymentTier == $deploymentTier' >/dev/null 2>&1; then
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
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_release 15
emit_release_audit cutover_succeeded info public-readiness-verified

deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
previous_release_dir=$(readlink -f "${current_link}" 2>/dev/null || true)
previous_release_sha=
if [ -n "${previous_release_dir}" ] && [ -f "${previous_release_dir}/deployment-manifest.json" ]; then
  previous_release_sha=$(jq -r '.releaseSha // empty' "${previous_release_dir}/deployment-manifest.json")
fi
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
    configuration: {storeSha256:$storeConfigSha256,catalogSha256:$catalogConfigSha256}
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
