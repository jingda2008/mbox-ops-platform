#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value IMAGE_REF
require_value APP_COMMIT_SHA
require_value EXPECTED_IMAGE_DIGEST
require_value ENV_FILE
validate_commit_sha "$APP_COMMIT_SHA"
validate_image_digest "$EXPECTED_IMAGE_DIGEST"
require_file "$ENV_FILE"

if ! is_apply_mode; then
  log 'empty database initialization is in dry-run mode; the database will not be contacted'
  print_command docker run --rm \
    --env-file "$ENV_FILE" \
    --env NORMALIZED_EMPTY_DATABASE_CONFIRM=INITIALIZE_EMPTY_DATABASE \
    "$IMAGE_REF" \
    node deploy/normalized/initialize-empty-database.mjs
  exit 0
fi

require_apply_confirmation NORMALIZED_DATABASE_CONFIRM 'INITIALIZE_NEW_EMPTY_DATABASE'
require_tool docker
verify_image_identity "$IMAGE_REF" "$APP_COMMIT_SHA" "$EXPECTED_IMAGE_DIGEST"
docker run --rm \
  --env-file "$ENV_FILE" \
  --env NORMALIZED_EMPTY_DATABASE_CONFIRM=INITIALIZE_EMPTY_DATABASE \
  "$IMAGE_REF" \
  node deploy/normalized/initialize-empty-database.mjs
