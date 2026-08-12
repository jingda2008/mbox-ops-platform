#!/usr/bin/env bash
set -Eeuo pipefail

install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
container=${MBOX_APP_CONTAINER:-mbox-app}
cursor_dir=${install_root}/observability
cursor_file=${cursor_dir}/docker-since.txt
queue_file=${cursor_dir}/pending-events.jsonl
release_queue_file=${cursor_dir}/pending-release-events.jsonl
queue_lock_file=${cursor_dir}/pending-events.lock
filter=/app/scripts/filter-sls-events.mjs
sender=${install_root}/bin/send-sls-events.sh
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
since=$(cat "${cursor_file}" 2>/dev/null || date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
maximum_events=${MBOX_SLS_MAX_EVENTS_PER_RUN:-500}
maximum_payload_bytes=${MBOX_SLS_MAX_PAYLOAD_BYTES_PER_RUN:-524288}

[[ "${maximum_events}" =~ ^[1-9][0-9]*$ ]]
[[ "${maximum_payload_bytes}" =~ ^[1-9][0-9]*$ ]]

install -d -m 0700 "${cursor_dir}"
test -x "${sender}"
docker exec "${container}" test -r "${filter}"
touch "${queue_file}" "${release_queue_file}"
chmod 0600 "${queue_file}" "${release_queue_file}"
exec 9>"${queue_lock_file}"
flock -n 9 || exit 0
temporary=$(mktemp)
merged=$(mktemp)
selected=$(mktemp)
remainder=$(mktemp)
trap 'rm -f "${temporary}" "${merged}" "${selected}" "${remainder}"' EXIT

docker logs --since "${since}" --timestamps "${container}" 2>&1 \
  | sed -E 's/^[0-9TZ:.-]+ //' \
  | docker exec -i "${container}" node "${filter}" > "${temporary}"

oom=$(docker inspect "${container}" --format '{{if .State.OOMKilled}}true{{else}}false{{end}}')
restart_count=$(docker inspect "${container}" --format '{{.RestartCount}}')
container_id=$(docker inspect "${container}" --format '{{.Id}}')
release_sha=$(docker inspect "${container}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
state_file=${cursor_dir}/container-state.json
previous_restarts=$(jq -r '.restartCount // 0' "${state_file}" 2>/dev/null || echo 0)
previous_oom=$(jq -r '.oomKilled // false' "${state_file}" 2>/dev/null || echo false)
previous_container_id=$(jq -r '.containerId // empty' "${state_file}" 2>/dev/null || true)
if [ "${container_id}" != "${previous_container_id}" ]; then
  jq -nc --arg timestamp "${now}" --arg container "${container}" --arg releaseSha "${release_sha}" \
    '{timestamp:$timestamp,mboxAuditEvent:"container_started",container:$container,releaseSha:$releaseSha,severity:"info",outcome:"new-container-observed"}' \
    | docker exec -i "${container}" node "${filter}" >> "${temporary}"
elif [ "${oom}" = true ] && [ "${previous_oom}" != true ]; then
  jq -nc --arg timestamp "${now}" --arg container "${container}" \
    '{timestamp:$timestamp,mboxAuditEvent:"container_oom",container:$container,severity:"error"}' \
    | docker exec -i "${container}" node "${filter}" >> "${temporary}"
elif [ "${restart_count}" -gt "${previous_restarts}" ]; then
  jq -nc --arg timestamp "${now}" --arg container "${container}" --arg outcome "restart-count-increased" \
    '{timestamp:$timestamp,mboxAuditEvent:"container_restarted",container:$container,severity:"warning",outcome:$outcome}' \
    | docker exec -i "${container}" node "${filter}" >> "${temporary}"
fi

cat "${queue_file}" "${release_queue_file}" "${temporary}" > "${merged}"
touch "${selected}" "${remainder}"
LC_ALL=C awk \
  -v max_events="${maximum_events}" \
  -v max_bytes="${maximum_payload_bytes}" \
  -v selected="${selected}" \
  -v remainder="${remainder}" \
  '{ line_bytes = length($0) + 1; if (count < max_events && used + line_bytes <= max_bytes) { print > selected; count += 1; used += line_bytes } else { print > remainder } }' \
  "${merged}"

# Persist every event before advancing the Docker cursor. A failed SLS request
# leaves the complete batch queued without replaying the same container logs.
cp "${merged}" "${queue_file}"
: > "${release_queue_file}"
printf '%s\n' "${now}" > "${cursor_file}"
jq -n --argjson restartCount "${restart_count}" --argjson oomKilled "${oom}" \
  --arg containerId "${container_id}" --arg releaseSha "${release_sha}" --arg checkedAt "${now}" \
  '{containerId:$containerId,releaseSha:$releaseSha,restartCount:$restartCount,oomKilled:$oomKilled,checkedAt:$checkedAt}' > "${state_file}"
touch "${queue_file}" "${release_queue_file}"
chmod 0600 "${cursor_file}" "${queue_file}" "${release_queue_file}" "${state_file}"

if [ -s "${selected}" ]; then
  if "${sender}" "${selected}"; then
    cp "${remainder}" "${queue_file}"
    chmod 0600 "${queue_file}"
  else
    exit 1
  fi
fi
