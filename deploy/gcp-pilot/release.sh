#!/usr/bin/env bash
set -euo pipefail

: "${MBOX_IMAGE:?MBOX_IMAGE is required}"
: "${MBOX_PILOT_EMPLOYEE_PINS_B64:?MBOX_PILOT_EMPLOYEE_PINS_B64 is required}"

install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
compose_source=${MBOX_COMPOSE_SOURCE:-/tmp/mbox-docker-compose.yml}
env_file="${install_root}/.env"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

cd "${install_root}"
test -f "${env_file}"
test -f "${compose_source}"

cp -a "${env_file}" "${env_file}.pre-${timestamp}"
install -m 0644 "${compose_source}" docker-compose.yml

pins_json=$(printf '%s' "${MBOX_PILOT_EMPLOYEE_PINS_B64}" | base64 -d)
node_count=$(printf '%s' "${pins_json}" | grep -o '"emp-[^"]*"' | wc -l | tr -d ' ')
if [ "${node_count}" -ne 12 ]; then
  echo "Expected 12 employee PIN entries, received ${node_count}" >&2
  exit 1
fi

next_env=$(mktemp)
trap 'rm -f "${next_env}"' EXIT
grep -v -E '^(MBOX_IMAGE|MBOX_PILOT_EMPLOYEE_PINS_JSON)=' "${env_file}" > "${next_env}"
printf 'MBOX_IMAGE=%s\n' "${MBOX_IMAGE}" >> "${next_env}"
printf 'MBOX_PILOT_EMPLOYEE_PINS_JSON=%s\n' "${pins_json}" >> "${next_env}"
install -m 0600 "${next_env}" "${env_file}"

registry_host=${MBOX_IMAGE%%/*}
metadata_token=$(curl -fsS \
  -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | jq -r '.access_token')
test -n "${metadata_token}"
printf '%s' "${metadata_token}" \
  | docker login -u oauth2accesstoken --password-stdin "https://${registry_host}" >/dev/null

docker compose pull app
docker compose run --rm app node dist-server/server/migrate.js
docker compose up -d --no-deps app

for _ in $(seq 1 45); do
  status=$(docker inspect --format='{{.State.Health.Status}}' mbox-pilot-app 2>/dev/null || true)
  if [ "${status}" = 'healthy' ]; then
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
    exit 0
  fi
  sleep 2
done

docker logs --tail 100 mbox-pilot-app >&2 || true
echo 'New application container did not become healthy' >&2
exit 1
