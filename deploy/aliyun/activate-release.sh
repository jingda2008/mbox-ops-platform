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
short_sha=${release_sha:0:7}
archive=${release_dir}/${archive_name}

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${expected_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${archive_name}" != */* ]]
test -f "${archive}"
test "$(sha256sum "${archive}" | awk '{print $1}')" = "${expected_archive_sha}"

docker load --input "${archive}" >/dev/null
actual_digest=$(docker image inspect "${image_tag}" --format '{{.Id}}')
actual_sha=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
actual_version=$(docker image inspect "${image_tag}" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
test "${actual_digest}" = "${expected_digest}"
test "${actual_sha}" = "${release_sha}"
test "${actual_version}" = "${release_version}"

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
if [ "${deployment_tier}" = production ] || [ "${migration_changed}" = 1 ] || [ -z "${recent_backup}" ]; then
  backup_path=$("${install_root}/bin/backup-postgres.sh")
fi

if [ "${migration_changed}" = 1 ]; then
  docker run --rm \
    --env-file "${release_env}" \
    --network "${network}" \
    "${image_tag}" \
    node dist-server/server/migrate.js
fi

candidate="mbox-candidate-${short_sha}"
candidate_volume="mbox-data-${short_sha}-candidate"
rollback_container=
traffic_switched=0
old_renamed=0
promoted=0
complete=0

rollback_on_error() {
  local exit_code=$?
  [ "${complete}" = 1 ] && return
  set +e
  echo "deployment failed; restoring previous application" >&2
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
  --arg digest "${expected_digest}" \
  '.status == "ready"
    and .repository == "postgres"
    and .projectionReady == true
    and .projectionCountsMatch == true
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
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_release 15

ln -sfn "${release_dir}" "${current_link}"
ln -sfn "${release_env}" "${env_link}"

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
    rollbackContainer: $rollbackContainer
  }' > "${release_dir}/deployment-manifest.json"

complete=1
trap - ERR INT TERM
printf 'release=%s\nsha=%s\nimage_digest=%s\nrollback=%s\nbackup=%s\n' \
  "${release_version}" "${release_sha}" "${expected_digest}" \
  "${rollback_container}" "${backup_path:-reused-recent-backup}"
