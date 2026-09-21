#!/usr/bin/env bash
set -Eeuo pipefail
release_dir=${1:?release directory required}
tier=${2:?tier required}
public_url=${3:?public URL required}
# activate-release owns the host release lock and immutable bundle verification.
test "${MBOX_VERIFIED_MAINTENANCE_ENTRY:-}" = 1
plan="${release_dir}/maintenance-plan.json"
test -f "${plan}" && test ! -L "${plan}"
test "$(stat -c '%u:%a' "${plan}")" = 0:600
controller_python=$(jq -er '.controllerPython' "${plan}")
[[ "${controller_python}" =~ ^/[A-Za-z0-9_./-]+$ ]]
controller_python=$(readlink -f "${controller_python}")
test -f "${controller_python}" && test -x "${controller_python}"
check_path=${controller_python}
while :; do
  test "$(stat -c %u "${check_path}")" = 0
  mode=$(stat -c %a "${check_path}")
  (( (8#${mode} & 8#022) == 0 ))
  test "${check_path}" != / || break
  check_path=$(dirname "${check_path}")
done
"${controller_python}" -c 'import sys; assert sys.version_info >= (3, 7), "Python 3.7+ required"'
exec "${controller_python}" "${release_dir}/maintenance-bootstrap.py" "${release_dir}" "${tier}" "${public_url}" "${@:4}"
