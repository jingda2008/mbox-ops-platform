#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value IMAGE_REF
require_value APP_COMMIT_SHA
require_value EXPECTED_IMAGE_DIGEST
require_value ENV_FILE
require_value CANDIDATE_CONTAINER_NAME
require_value CANDIDATE_BIND_ADDRESS
require_value CANDIDATE_HOST_PORT
require_value CANDIDATE_BASE_URL
validate_commit_sha "$APP_COMMIT_SHA"
validate_image_digest "$EXPECTED_IMAGE_DIGEST"
assert_candidate_name "$CANDIDATE_CONTAINER_NAME"
require_file "$ENV_FILE"
[[ "$CANDIDATE_HOST_PORT" =~ ^[0-9]{2,5}$ ]] || die 'CANDIDATE_HOST_PORT must be numeric'

docker_args=(
  docker run --detach
  --name "$CANDIDATE_CONTAINER_NAME"
  --label "com.mbox.release.sha=${APP_COMMIT_SHA}"
  --label "com.mbox.schema-flavor=${NORMALIZED_SCHEMA_FLAVOR}"
  --env-file "$ENV_FILE"
  --env "APP_COMMIT_SHA=${APP_COMMIT_SHA}"
  --publish "${CANDIDATE_BIND_ADDRESS}:${CANDIDATE_HOST_PORT}:8787"
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=64m
  --security-opt no-new-privileges
  --cap-drop ALL
  --restart no
)
if [[ -n "${DOCKER_NETWORK:-}" ]]; then
  docker_args+=(--network "$DOCKER_NETWORK")
fi
docker_args+=("$IMAGE_REF")

if ! is_apply_mode; then
  log 'candidate startup is in dry-run mode; the existing service is protected and unchanged'
  print_command "${docker_args[@]}"
  log "planned verification URL: ${CANDIDATE_BASE_URL}/api/ready"
  exit 0
fi

require_apply_confirmation NORMALIZED_CANDIDATE_CONFIRM 'START_ISOLATED_CANDIDATE'
require_tool docker
verify_image_identity "$IMAGE_REF" "$APP_COMMIT_SHA" "$EXPECTED_IMAGE_DIGEST"
if docker container inspect "$CANDIDATE_CONTAINER_NAME" >/dev/null 2>&1; then
  die 'candidate container already exists; refusing implicit replacement'
fi
docker_id="$("${docker_args[@]}")"
log "isolated candidate started: container=${CANDIDATE_CONTAINER_NAME} id=${docker_id:0:12}"

MBOX_DEPLOY_APPLY=1 \
  NORMALIZED_VERIFY_CONFIRM=VERIFY_ISOLATED_CANDIDATE \
  "${SCRIPT_DIR}/verify-candidate.sh"
