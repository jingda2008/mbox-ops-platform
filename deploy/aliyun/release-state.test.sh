#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=release-state.sh
source "${root}/deploy/aliyun/release-state.sh"

state_file=$(mktemp)
rm -f "${state_file}"
trap 'rm -f "${state_file}"' EXIT
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
