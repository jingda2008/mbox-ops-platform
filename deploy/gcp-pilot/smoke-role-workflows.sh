#!/usr/bin/env bash
set -euo pipefail
trap 'echo "ROLE_WORKFLOW_SMOKE_FAILED line ${LINENO}" >&2' ERR

install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
env_file="${install_root}/.env"
test -f "${env_file}"

value_from_env() {
  local key=$1
  sed -n "s/^${key}=//p" "${env_file}" | tail -n 1
}

domain=$(value_from_env MBOX_DOMAIN)
access_code=$(value_from_env MBOX_PILOT_ACCESS_CODE)
pins_json=$(value_from_env MBOX_PILOT_EMPLOYEE_PINS_JSON)
base_url="https://${domain}"

login_token() {
  local actor_id=$1 employee_pin
  employee_pin=$(printf '%s' "${pins_json}" | jq -r --arg id "${actor_id}" '.[$id]')
  curl -fsS \
    -H 'content-type: application/json' \
    -d "$(jq -nc \
      --arg accessCode "${access_code}" \
      --arg actorId "${actor_id}" \
      --arg employeePin "${employee_pin}" \
      '{accessCode:$accessCode,actorId:$actorId,employeePin:$employeePin}')" \
    "${base_url}/api/auth/pilot-login" | jq -er '.token'
}

manager_token=$(login_token emp-chen)
server_token=$(login_token emp-lin)
temporary_dir=$(mktemp -d)
trap 'rm -rf "${temporary_dir}"' EXIT

manager_waitlist_status=$(curl -sS -o "${temporary_dir}/manager-waitlist.json" -w '%{http_code}' \
  -H "authorization: Bearer ${manager_token}" "${base_url}/api/waitlist")
server_waitlist_status=$(curl -sS -o "${temporary_dir}/server-waitlist.json" -w '%{http_code}' \
  -H "authorization: Bearer ${server_token}" "${base_url}/api/waitlist")

transfer_payload='{"targetTableId":"table-l01","kind":"relocate","reason":"云端权限冒烟，不改变业务状态","idempotencyKey":"cloud-smoke-transfer-same-table-001"}'
manager_transfer_status=$(curl -sS -o "${temporary_dir}/manager-transfer.json" -w '%{http_code}' \
  -H "authorization: Bearer ${manager_token}" -H 'content-type: application/json' \
  -d "${transfer_payload}" "${base_url}/api/tables/table-l01/transfer")
server_transfer_status=$(curl -sS -o "${temporary_dir}/server-transfer.json" -w '%{http_code}' \
  -H "authorization: Bearer ${server_token}" -H 'content-type: application/json' \
  -d "${transfer_payload}" "${base_url}/api/tables/table-l01/transfer")

test "${manager_waitlist_status}" = 200
test "${server_waitlist_status}" = 403
test "${manager_transfer_status}" = 400
test "$(jq -r '.message' "${temporary_dir}/manager-transfer.json")" = '目标桌不能与原桌相同'
test "${server_transfer_status}" = 403

echo "WAITLIST_MANAGER=${manager_waitlist_status} WAITLIST_SERVER=${server_waitlist_status}"
echo "TRANSFER_MANAGER_BUSINESS_GUARD=${manager_transfer_status} TRANSFER_SERVER_RBAC=${server_transfer_status}"
echo 'ROLE_WORKFLOW_SMOKE_OK'
