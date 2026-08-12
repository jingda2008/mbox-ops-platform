#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value IMAGE_REF
require_value APP_COMMIT_SHA
require_value EXPECTED_IMAGE_DIGEST
require_value ENV_FILE
require_value STORE_CONFIG_FILE
require_value CATALOG_CONFIG_FILE
validate_commit_sha "$APP_COMMIT_SHA"
validate_image_digest "$EXPECTED_IMAGE_DIGEST"
require_file "$ENV_FILE"
require_file "$STORE_CONFIG_FILE"
require_file "$CATALOG_CONFIG_FILE"

container_config='/run/mbox-config/store.json'
container_catalog='/run/mbox-config/catalog.json'
store_command=(
  docker run --rm
  --env-file "$ENV_FILE"
  --env "APP_COMMIT_SHA=${APP_COMMIT_SHA}"
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=32m
  --security-opt no-new-privileges
  --cap-drop ALL
  --mount "type=bind,src=${STORE_CONFIG_FILE},dst=${container_config},readonly"
  "$IMAGE_REF"
  node dist-normalized/server/provision-normalized-store.js "--config=${container_config}"
)
catalog_command=(
  docker run --rm
  --env-file "$ENV_FILE"
  --env "APP_COMMIT_SHA=${APP_COMMIT_SHA}"
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=32m
  --security-opt no-new-privileges
  --cap-drop ALL
  --mount "type=bind,src=${CATALOG_CONFIG_FILE},dst=${container_catalog},readonly"
  "$IMAGE_REF"
  node dist-normalized/server/provision-normalized-catalog.js "--config=${container_catalog}"
)

if ! is_apply_mode; then
  log 'store provisioning is in dry-run mode; no database or container mutation will occur'
  print_command "${store_command[@]}"
  print_command "${catalog_command[@]}"
  exit 0
fi

require_apply_confirmation NORMALIZED_STORE_CONFIRM 'PROVISION_VERSIONED_STORE_CONFIG'
require_tool docker
verify_image_identity "$IMAGE_REF" "$APP_COMMIT_SHA" "$EXPECTED_IMAGE_DIGEST"
"${store_command[@]}"
"${catalog_command[@]}"
log "versioned normalized store and catalog configuration applied for sha=${APP_COMMIT_SHA}"
