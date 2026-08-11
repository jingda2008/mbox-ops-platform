#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value IMAGE_REF
require_value APP_COMMIT_SHA
validate_commit_sha "$APP_COMMIT_SHA"
APP_RELEASE_VERSION="${APP_RELEASE_VERSION:-candidate}"

if ! is_apply_mode; then
  log 'image build is in dry-run mode; no Docker resources will change'
  print_command docker build \
    --file "${REPO_ROOT}/Dockerfile.normalized" \
    --tag "$IMAGE_REF" \
    --build-arg "APP_COMMIT_SHA=${APP_COMMIT_SHA}" \
    --build-arg "APP_RELEASE_VERSION=${APP_RELEASE_VERSION}" \
    "$REPO_ROOT"
  exit 0
fi

require_apply_confirmation NORMALIZED_BUILD_CONFIRM 'BUILD_NORMALIZED_IMAGE'
require_tool docker
docker build \
  --file "${REPO_ROOT}/Dockerfile.normalized" \
  --tag "$IMAGE_REF" \
  --build-arg "APP_COMMIT_SHA=${APP_COMMIT_SHA}" \
  --build-arg "APP_RELEASE_VERSION=${APP_RELEASE_VERSION}" \
  "$REPO_ROOT"

actual_digest="$(image_id "$IMAGE_REF")"
actual_sha="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_REF")"
[[ "$actual_sha" == "$APP_COMMIT_SHA" ]] || die 'built image commit label verification failed'
log "built immutable candidate image: image=${IMAGE_REF} digest=${actual_digest} sha=${actual_sha}"
