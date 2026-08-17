#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=release-state.sh
source "${root}/deploy/aliyun/release-state.sh"

state_file=$(mktemp)
contract_state_file=$(mktemp)
rm -f "${state_file}"
rm -f "${contract_state_file}"
trap 'rm -f "${state_file}" "${contract_state_file}"' EXIT

release_state_init "${state_file}" "$(printf 'a%.0s' {1..40})" "sha256:$(printf 'b%.0s' {1..64})"
release_state_transition "${state_file}" frozen artifact_verified
if release_state_transition "${state_file}" artifact_verified migration_compatible 2>/dev/null; then
  echo 'state machine allowed config preflight bypass' >&2
  exit 1
fi
release_state_require "${state_file}" artifact_verified
release_state_transition "${state_file}" artifact_verified config_preflight_passed
release_state_transition "${state_file}" config_preflight_passed external_preflight_passed
release_state_transition "${state_file}" external_preflight_passed migration_compatible
release_state_require "${state_file}" migration_compatible
test "$(jq '.history | length' "${state_file}")" = 5

release_state_init "${contract_state_file}" "$(printf 'c%.0s' {1..40})" "sha256:$(printf 'd%.0s' {1..64})"
release_state_transition "${contract_state_file}" frozen artifact_verified
release_state_transition "${contract_state_file}" artifact_verified config_preflight_passed
release_state_transition "${contract_state_file}" config_preflight_passed external_preflight_passed
release_state_transition "${contract_state_file}" external_preflight_passed migration_compatible
release_state_transition "${contract_state_file}" migration_compatible writer_drained
release_state_transition "${contract_state_file}" writer_drained post_drain_backup_verified
release_state_transition "${contract_state_file}" post_drain_backup_verified migrated
release_state_transition "${contract_state_file}" migrated database_restored
release_state_transition "${contract_state_file}" database_restored rolled_back
release_state_require "${contract_state_file}" rolled_back
