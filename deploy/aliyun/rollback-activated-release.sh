#!/usr/bin/env bash
set -Eeuo pipefail

release_dir=${1:?release directory is required}
public_url=${2:?public URL is required}
manifest=${release_dir}/deployment-manifest.json
install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
active_container=mbox-app
caddy_container=mbox-caddy
network=mbox-net

case "${release_dir}" in "${install_root}"/releases/*) ;; *) exit 1 ;; esac
test -f "${manifest}"
rollback_container=$(jq -er '.rollbackContainer' "${manifest}")
failed_sha=$(jq -er '.releaseSha' "${manifest}")
previous_release_sha=$(jq -er '.previousReleaseSha' "${manifest}")
previous_release_dir=$(jq -er '.previousReleaseDir' "${manifest}")
case "${rollback_container}" in mbox-app-rollback-*) ;; *) exit 1 ;; esac
case "${previous_release_dir}" in "${install_root}"/releases/*) ;; *) exit 1 ;; esac
[[ "${failed_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${previous_release_sha}" =~ ^[0-9a-f]{40}$ ]]
test "${previous_release_sha}" != "${failed_sha}"
test -d "${previous_release_dir}"
test -f "${previous_release_dir}/release-manifest.json"
test "$(jq -er '.releaseSha' "${previous_release_dir}/release-manifest.json")" = "${previous_release_sha}"
docker network inspect "${network}" >/dev/null
docker inspect "${active_container}" >/dev/null
docker inspect "${rollback_container}" >/dev/null
test "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "${failed_sha}"
test "$(docker inspect "${rollback_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "${previous_release_sha}"

current_caddy=$(mktemp "${release_dir}/.Caddyfile.rollback-current.XXXXXX")
candidate_caddy=$(mktemp "${release_dir}/.Caddyfile.rollback-candidate.XXXXXX")
failed_container="mbox-failed-${failed_sha:0:7}-$(date +%Y%m%d-%H%M%S)"
traffic_switched=0
failed_restart_disabled=0
failed_stopped=0
failed_renamed=0
rollback_promoted=0
complete=0

cleanup() {
  rm -f "${current_caddy}" "${candidate_caddy}"
}
trap cleanup EXIT

verify_public_sha() {
  local expected_sha=$1
  local attempts=${2:-15}
  local response
  for _ in $(seq 1 "${attempts}"); do
    response=$(curl -fsS --max-time 10 "${public_url}/api/ready" 2>/dev/null || true)
    if printf '%s' "${response}" | jq -e --arg expectedSha "${expected_sha}" \
      '.status == "ready" and .commitSha == $expectedSha' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_failed_release_on_error() {
  local exit_code=$?
  [ "${complete}" = 1 ] && return
  set +e
  if [ "${rollback_promoted}" = 1 ]; then
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
    docker rename "${active_container}" "${rollback_container}" >/dev/null 2>&1
    docker rename "${failed_container}" "${active_container}" >/dev/null 2>&1
    docker start "${active_container}" >/dev/null 2>&1
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  elif [ "${failed_renamed}" = 1 ]; then
    docker rename "${failed_container}" "${active_container}" >/dev/null 2>&1
    docker start "${active_container}" >/dev/null 2>&1
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  elif [ "${failed_stopped}" = 1 ]; then
    docker start "${active_container}" >/dev/null 2>&1
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  elif [ "${failed_restart_disabled}" = 1 ]; then
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  fi
  if [ "${traffic_switched}" = 1 ]; then
    docker exec "${caddy_container}" \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  fi
  if docker inspect "${rollback_container}" >/dev/null 2>&1; then
    docker update --restart=no "${rollback_container}" >/dev/null 2>&1
    docker stop -t 10 "${rollback_container}" >/dev/null 2>&1
  fi
  verify_public_sha "${failed_sha}" 5 >/dev/null 2>&1 || true
  exit "${exit_code}"
}
trap restore_failed_release_on_error ERR INT TERM

# Bring the previous release up under its immutable rollback name first. The
# currently active release remains available until the previous SHA is healthy.
docker start "${rollback_container}" >/dev/null
docker update --restart=no "${rollback_container}" >/dev/null
for _ in $(seq 1 60); do
  health=$(docker inspect "${rollback_container}" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "${health}" = healthy ] && break
  [ "${health}" = unhealthy ] && exit 1
  sleep 2
done
test "$(docker inspect "${rollback_container}" --format '{{.State.Health.Status}}')" = healthy
rollback_ready=$(docker exec "${rollback_container}" wget -q -O - http://127.0.0.1:8787/api/ready)
printf '%s' "${rollback_ready}" | jq -e --arg previousReleaseSha "${previous_release_sha}" \
  '.status == "ready" and .commitSha == $previousReleaseSha' >/dev/null

docker exec "${caddy_container}" cat /etc/caddy/Caddyfile > "${current_caddy}"
grep -q 'mbox-app:8787' "${current_caddy}"
rollback_ip=$(docker inspect "${rollback_container}" \
  --format "{{with index .NetworkSettings.Networks \"${network}\"}}{{.IPAddress}}{{end}}")
[[ "${rollback_ip}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
sed "s/mbox-app:8787/${rollback_ip}:8787/g" "${current_caddy}" > "${candidate_caddy}"
docker cp "${candidate_caddy}" "${caddy_container}:/tmp/Caddyfile.rollback-candidate"
docker exec "${caddy_container}" \
  caddy validate --config /tmp/Caddyfile.rollback-candidate --adapter caddyfile >/dev/null
docker exec "${caddy_container}" \
  caddy reload --config /tmp/Caddyfile.rollback-candidate --adapter caddyfile >/dev/null
traffic_switched=1
verify_public_sha "${previous_release_sha}" 15

# Traffic is already reaching the verified previous container by IP, so these
# name changes do not remove the live upstream.
docker update --restart=no "${active_container}" >/dev/null
failed_restart_disabled=1
docker stop -t 20 "${active_container}" >/dev/null
failed_stopped=1
docker rename "${active_container}" "${failed_container}"
failed_renamed=1
docker rename "${rollback_container}" "${active_container}"
rollback_promoted=1
docker update --restart=unless-stopped "${active_container}" >/dev/null
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_sha "${previous_release_sha}" 15

test -f "${previous_release_dir}/app.env"
ln -sfn "${previous_release_dir}" "${install_root}/current"
ln -sfn "${previous_release_dir}/app.env" "${install_root}/.env"
complete=1
trap - ERR INT TERM
printf 'rollback=complete\nrestored_sha=%s\nrestored_container=%s\nfailed_container=%s\n' \
  "${previous_release_sha}" "${active_container}" "${failed_container}"
