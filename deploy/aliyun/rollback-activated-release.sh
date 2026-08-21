#!/usr/bin/env bash
set -Eeuo pipefail

release_dir=${1:?release directory is required}
public_url=${2:?public URL is required}
manifest=${release_dir}/deployment-manifest.json
install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
release_lock_dir=${install_root}/locks
release_lock_file=${release_lock_dir}/release.lock
active_container=mbox-app
caddy_container=mbox-caddy
network=mbox-net
public_verifier=${release_dir}/verify-public-app.sh

case "${release_dir}" in "${install_root}"/releases/*) ;; *) exit 1 ;; esac
install -d -m 0700 "${release_lock_dir}"
test "$(stat -c '%u:%a' "${release_lock_dir}")" = 0:700
exec 8>"${release_lock_file}"
chmod 0600 "${release_lock_file}"
if ! flock -n 8; then
  echo "another release or database-maintenance operation is active" >&2
  exit 75
fi
test -f "${manifest}"
test -x "${public_verifier}"

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
  done < <(jq -er '.deploymentScripts | to_entries[] | [.value.file,.value.sha256] | @tsv' "${release_dir}/release-manifest.json")
  test "${count}" = 12
}
verify_deployment_scripts
rollback_mode=$(jq -r '.rollbackMode // "application_image"' "${manifest}")
if [ "${rollback_mode}" = forward_only_after_contract_cutover ]; then
  echo "contract migration cutover has resumed writes; application-only rollback is forbidden" >&2
  exit 2
fi
test "${rollback_mode}" = application_image
rollback_container=$(jq -er '.rollbackContainer' "${manifest}")
failed_sha=$(jq -er '.releaseSha' "${manifest}")
previous_release_sha=$(jq -er '.previousReleaseSha' "${manifest}")
previous_release_dir=$(jq -er '.previousReleaseDir' "${manifest}")
previous_identity_complete=$(jq -r '.previousIdentityComplete // false' "${manifest}")
case "${previous_identity_complete}" in true) previous_identity_complete=1 ;; false) previous_identity_complete=0 ;; *) exit 1 ;; esac
case "${rollback_container}" in mbox-app-rollback-*) ;; *) exit 1 ;; esac
case "${previous_release_dir}" in "${install_root}"/releases/*) ;; *) exit 1 ;; esac
[[ "${failed_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${previous_release_sha}" =~ ^[0-9a-f]{40}$ ]]
test "${previous_release_sha}" != "${failed_sha}"
test -d "${previous_release_dir}"
test -f "${previous_release_dir}/release-manifest.json"
test "$(jq -er '.releaseSha' "${previous_release_dir}/release-manifest.json")" = "${previous_release_sha}"
failed_release_digest=$(jq -er '.imageDigest' "${release_dir}/release-manifest.json")
failed_platform_image_digest=$(jq -er '.platformImageDigest' "${release_dir}/release-manifest.json")
failed_schema_version=$(jq -er '.migration.count' "${release_dir}/release-manifest.json")
failed_deployment_tier=$(jq -er '.tier' "${manifest}")
previous_release_digest=$(jq -er '.imageDigest' "${previous_release_dir}/release-manifest.json")
previous_platform_image_digest=$(jq -er '.previousPlatformImageDigest' "${manifest}")
previous_schema_version=$(jq -er '.migration.count' "${previous_release_dir}/release-manifest.json")
previous_deployment_tier=$(jq -er '.previousDeploymentTier' "${manifest}")
[[ "${previous_release_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${failed_release_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${failed_platform_image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${previous_platform_image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${previous_schema_version}" =~ ^[0-9]+$ ]]
[[ "${failed_schema_version}" =~ ^[0-9]+$ ]]
case "${previous_deployment_tier}" in validation|production) ;; *) exit 1 ;; esac
case "${failed_deployment_tier}" in validation|production) ;; *) exit 1 ;; esac
docker network inspect "${network}" >/dev/null
docker inspect "${active_container}" >/dev/null
docker inspect "${rollback_container}" >/dev/null
test "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "${failed_sha}"
test "$(docker inspect "${rollback_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "${previous_release_sha}"
test "$(docker inspect "${active_container}" --format '{{.Image}}')" = "${failed_platform_image_digest}"
test "$(docker inspect "${rollback_container}" --format '{{.Image}}')" = "${previous_platform_image_digest}"

current_caddy=$(mktemp "${release_dir}/.Caddyfile.rollback-current.XXXXXX")
candidate_caddy=$(mktemp "${release_dir}/.Caddyfile.rollback-candidate.XXXXXX")
failed_container="mbox-failed-${failed_sha:0:7}-$(date +%Y%m%d-%H%M%S)"
complete=0

cleanup() {
  rm -f "${current_caddy}" "${candidate_caddy}"
}
trap cleanup EXIT

verify_public_release() {
  "${public_verifier}" "${public_url}" "$1" "$2" "$3" "$4" "${5:-15}" "${6:-1}"
}

restore_failed_release_on_error() {
  local exit_code=${1:-$?}
  local active_sha=
  local active_digest=
  [ "${complete}" = 1 ] && return
  trap - ERR INT TERM
  set +e

  # Decide recovery from container identity, not shell progress flags. This
  # closes signal windows between stop/rename operations and flag updates.
  if docker inspect "${active_container}" >/dev/null 2>&1; then
    active_sha=$(docker inspect "${active_container}" \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
    active_digest=$(docker inspect "${active_container}" --format '{{.Image}}' 2>/dev/null)
  fi
  if [ "${active_sha}" = "${previous_release_sha}" ] \
    && [ "${active_digest}" = "${previous_platform_image_digest}" ]; then
    docker update --restart=no "${active_container}" >/dev/null 2>&1
    docker stop -t 20 "${active_container}" >/dev/null 2>&1
    docker rename "${active_container}" "${rollback_container}" >/dev/null 2>&1
  fi
  if ! docker inspect "${active_container}" >/dev/null 2>&1 \
    && [ "$(docker inspect "${failed_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${failed_sha}" ] \
    && [ "$(docker inspect "${failed_container}" --format '{{.Image}}' 2>/dev/null)" = "${failed_platform_image_digest}" ]; then
    docker rename "${failed_container}" "${active_container}" >/dev/null 2>&1
  fi
  if [ "$(docker inspect "${active_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${failed_sha}" ] \
    && [ "$(docker inspect "${active_container}" --format '{{.Image}}' 2>/dev/null)" = "${failed_platform_image_digest}" ]; then
    docker start "${active_container}" >/dev/null 2>&1
    docker update --restart=unless-stopped "${active_container}" >/dev/null 2>&1
  fi
  docker exec "${caddy_container}" \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
  if docker inspect "${rollback_container}" >/dev/null 2>&1 \
    && [ "$(docker inspect "${rollback_container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" = "${previous_release_sha}" ]; then
    docker update --restart=no "${rollback_container}" >/dev/null 2>&1
    docker stop -t 10 "${rollback_container}" >/dev/null 2>&1
  fi
  verify_public_release "${failed_sha}" "${failed_release_digest}" \
    "${failed_schema_version}" "${failed_deployment_tier}" 5 >/dev/null 2>&1 || true
  exit "${exit_code}"
}
trap 'restore_failed_release_on_error $?' ERR
trap 'restore_failed_release_on_error 130' INT
trap 'restore_failed_release_on_error 143' TERM

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
verify_public_release "${previous_release_sha}" "${previous_release_digest}" \
  "${previous_schema_version}" "${previous_deployment_tier}" 15 "${previous_identity_complete}"

# Traffic is already reaching the verified previous container by IP, so these
# name changes do not remove the live upstream.
docker update --restart=no "${active_container}" >/dev/null
docker stop -t 20 "${active_container}" >/dev/null
docker rename "${active_container}" "${failed_container}"
docker rename "${rollback_container}" "${active_container}"
docker update --restart=unless-stopped "${active_container}" >/dev/null
docker exec "${caddy_container}" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_release "${previous_release_sha}" "${previous_release_digest}" \
  "${previous_schema_version}" "${previous_deployment_tier}" 15 "${previous_identity_complete}"

test -f "${previous_release_dir}/app.env"
ln -sfn "${previous_release_dir}" "${install_root}/current"
ln -sfn "${previous_release_dir}/app.env" "${install_root}/.env"
complete=1
trap - ERR INT TERM
printf 'rollback=complete\nrestored_sha=%s\nrestored_container=%s\nfailed_container=%s\n' \
  "${previous_release_sha}" "${active_container}" "${failed_container}"
