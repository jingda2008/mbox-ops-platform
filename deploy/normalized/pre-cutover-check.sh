#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value CURRENT_HEALTH_URL
require_value CANDIDATE_BASE_URL
require_value CANDIDATE_CONTAINER_NAME
assert_candidate_name "$CANDIDATE_CONTAINER_NAME"
[[ "$CURRENT_HEALTH_URL" != "$CANDIDATE_BASE_URL" ]] || die 'current and candidate URLs must be different'

if ! is_apply_mode; then
  log 'pre-cutover checks are in dry-run mode; no traffic or container changes will occur'
  log 'planned checks: current service health, isolated candidate identity/readiness, protected-container presence'
  exit 0
fi

require_apply_confirmation NORMALIZED_PRE_CUTOVER_CONFIRM 'CHECK_ONLY_NO_CUTOVER'
require_tool curl
require_tool docker
curl --fail --silent --show-error --max-time 5 "${CURRENT_HEALTH_URL}/api/ready" >/dev/null \
  || die 'current service readiness failed; cutover must not proceed'

MBOX_DEPLOY_APPLY=1 \
  NORMALIZED_VERIFY_CONFIRM=VERIFY_ISOLATED_CANDIDATE \
  "${SCRIPT_DIR}/verify-candidate.sh"

docker container inspect "$PROTECTED_CONTAINER_NAME" >/dev/null 2>&1 \
  || log 'protected legacy container is not managed by this host; no mutation was attempted'
log 'pre-cutover checks passed; this script does not change routing or traffic'
