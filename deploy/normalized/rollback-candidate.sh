#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value CANDIDATE_CONTAINER_NAME
assert_candidate_name "$CANDIDATE_CONTAINER_NAME"

if ! is_apply_mode; then
  log 'candidate rollback is in dry-run mode; no container will be stopped or removed'
  print_command docker stop --time 20 "$CANDIDATE_CONTAINER_NAME"
  print_command docker rm "$CANDIDATE_CONTAINER_NAME"
  exit 0
fi

require_apply_confirmation NORMALIZED_ROLLBACK_CONFIRM 'REMOVE_ISOLATED_CANDIDATE'
require_tool docker
schema_flavor="$(docker container inspect --format '{{index .Config.Labels "com.mbox.schema-flavor"}}' "$CANDIDATE_CONTAINER_NAME")"
[[ "$schema_flavor" == "$NORMALIZED_SCHEMA_FLAVOR" ]] \
  || die 'refusing rollback because container is not a normalized candidate'

docker stop --time 20 "$CANDIDATE_CONTAINER_NAME" >/dev/null
docker rm "$CANDIDATE_CONTAINER_NAME" >/dev/null
log 'isolated normalized candidate removed; existing production container and routing were not touched'

if [[ -n "${CURRENT_HEALTH_URL:-}" ]]; then
  require_tool curl
  curl --fail --silent --show-error --max-time 5 "${CURRENT_HEALTH_URL}/api/ready" >/dev/null \
    || die 'candidate removed, but current service readiness verification failed'
  log 'current service remains ready after candidate rollback'
fi
