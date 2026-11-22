#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=release-state.sh
source "${root}/deploy/aliyun/release-state.sh"

state_file=$(mktemp)
contract_state_file=$(mktemp)
contract_dir=$(mktemp -d)
rm -f "${state_file}"
rm -f "${contract_state_file}"
trap 'rm -f "${state_file}" "${contract_state_file}"; rm -rf "${contract_dir}"' EXIT

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

# Cross-day debt changes closed-invoice payment semantics, including rollback.
test "$(release_contract_boundary_between 299 300)" = 300
test "$(release_contract_boundary_between 299 301)" = 301
test "$(release_contract_boundary_between 300 301)" = 301
test "$(release_contract_boundary_between 298 299)" = 0

test "$(release_contract_boundary_between 300 304)" = 304
test "$(release_contract_boundary_between 303 304)" = 304
test "$(release_contract_boundary_between 304 304)" = 0
test "$(release_contract_boundary_between 304 305)" = 305
test "$(release_contract_boundary_between 305 305)" = 0

# Channel zero-price/gift accounting and party caps require a compatible writer.
test "$(release_contract_boundary_between 305 313)" = 313
test "$(release_contract_boundary_between 312 313)" = 313
test "$(release_contract_boundary_between 313 313)" = 0
test "$(release_contract_boundary_between 313 314)" = 314
test "$(release_contract_boundary_between 305 314)" = 314

# On-use claims require compatible gift writers even though schema320 is additive.
test "$(release_contract_boundary_between 319 320)" = 320
test "$(release_contract_boundary_between 314 320)" = 320
test "$(release_contract_boundary_between 320 320)" = 0
test "$(release_contract_boundary_between 314 319)" = 0

# Existing production tickets must be claimed exclusively by payment-aware writers.
test "$(release_contract_boundary_between 320 321)" = 321
test "$(release_contract_boundary_between 319 321)" = 321
test "$(release_contract_boundary_between 321 321)" = 0
echo '{"migration":{"count":321}}' > "${contract_dir}/release-manifest.json"
if release_assert_application_rollback_safe "${contract_dir}" 320; then exit 1; fi
jq -e '.contractBoundary==321 and .targetSchema==320 and .status=="blocked"' \
  "${contract_dir}/application-contract-rollback-guard.json" >/dev/null
