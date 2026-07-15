#!/usr/bin/env bash
set -euo pipefail
trap 'echo "SMOKE_FAILED line ${LINENO}" >&2' ERR

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

test -n "${domain}"
test -n "${access_code}"
printf '%s' "${pins_json}" | jq -e 'length == 12' >/dev/null
echo 'PIN_CONFIG_OK 12'

expected_roles='{
  "emp-owner":"owner",
  "emp-admin":"admin",
  "emp-lin":"server",
  "emp-jie":"backup",
  "emp-wu":"server",
  "emp-qing":"bartender",
  "emp-han":"kitchen",
  "emp-tao":"runner",
  "emp-mia":"supervisor",
  "emp-chen":"manager",
  "emp-cashier":"cashier",
  "emp-host":"host"
}'

employee_list=$(curl -fsS \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg accessCode "${access_code}" '{accessCode:$accessCode}')" \
  "${base_url}/api/auth/pilot-login")
employee_count=$(printf '%s' "${employee_list}" | jq -r '.employees | length')
echo "ACTIVE_EMPLOYEES ${employee_count}"
printf '%s' "${employee_list}" | jq -e '.employees | length == 12' >/dev/null

for employee_id in $(printf '%s' "${expected_roles}" | jq -r 'keys[]'); do
  expected_role=$(printf '%s' "${expected_roles}" | jq -r --arg id "${employee_id}" '.[$id]')
  employee_pin=$(printf '%s' "${pins_json}" | jq -r --arg id "${employee_id}" '.[$id]')
  login=$(curl -fsS \
    -H 'content-type: application/json' \
    -d "$(jq -nc \
      --arg accessCode "${access_code}" \
      --arg actorId "${employee_id}" \
      --arg employeePin "${employee_pin}" \
      '{accessCode:$accessCode,actorId:$actorId,employeePin:$employeePin}')" \
    "${base_url}/api/auth/pilot-login")
  token=$(printf '%s' "${login}" | jq -er '.token')
  bootstrap=$(curl -fsS -H "authorization: Bearer ${token}" "${base_url}/api/bootstrap")
  printf '%s' "${bootstrap}" | jq -e --arg id "${employee_id}" \
    '.employees | any(.id == $id)' >/dev/null
  actual_role=$(printf '%s' "${bootstrap}" | jq -r --arg id "${employee_id}" \
    '.employees[] | select(.id == $id) | .roleId')
  if [ "${actual_role}" != "${expected_role}" ]; then
    echo "Role mismatch for ${employee_id}: expected ${expected_role}, received ${actual_role:-missing}" >&2
    exit 1
  fi
  echo "LOGIN_OK ${employee_id} ${expected_role}"
done

echo 'STAFF_LOGIN_SMOKE_OK 12'
