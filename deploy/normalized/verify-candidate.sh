#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value IMAGE_REF
require_value APP_COMMIT_SHA
require_value EXPECTED_IMAGE_DIGEST
require_value CANDIDATE_CONTAINER_NAME
require_value CANDIDATE_BASE_URL
validate_commit_sha "$APP_COMMIT_SHA"
validate_image_digest "$EXPECTED_IMAGE_DIGEST"
assert_candidate_name "$CANDIDATE_CONTAINER_NAME"
DEPLOYMENT_TIER="${DEPLOYMENT_TIER:-validation}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-75}"
[[ "$VERIFY_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die 'VERIFY_TIMEOUT_SECONDS must be numeric'
case "$DEPLOYMENT_TIER" in
  validation|production) ;;
  *) die 'DEPLOYMENT_TIER must be validation or production' ;;
esac

if ! is_apply_mode; then
  log 'candidate verification is in dry-run mode; no Docker or HTTP request will run'
  log 'planned checks: image digest, image SHA label, container image ID, /api/version and /api/ready'
  exit 0
fi

require_apply_confirmation NORMALIZED_VERIFY_CONFIRM 'VERIFY_ISOLATED_CANDIDATE'
require_tool docker
require_tool curl
require_tool jq
verify_image_identity "$IMAGE_REF" "$APP_COMMIT_SHA" "$EXPECTED_IMAGE_DIGEST"

container_image_id="$(docker container inspect --format '{{.Image}}' "$CANDIDATE_CONTAINER_NAME")"
expected_image_id="$(image_id "$IMAGE_REF")"
[[ "$container_image_id" == "$expected_image_id" ]] || die 'candidate container is not running the verified image digest'
container_schema="$(docker container inspect --format '{{index .Config.Labels "com.mbox.schema-flavor"}}' "$CANDIDATE_CONTAINER_NAME")"
[[ "$container_schema" == "$NORMALIZED_SCHEMA_FLAVOR" ]] || die 'candidate container schema label mismatch'

deadline=$((SECONDS + VERIFY_TIMEOUT_SECONDS))
ready_json=''
until ready_json="$(curl --fail --silent --show-error --max-time 4 "${CANDIDATE_BASE_URL}/api/ready" 2>/dev/null)"; do
  (( SECONDS < deadline )) || die 'candidate readiness check timed out'
  sleep 2
done
version_json="$(curl --fail --silent --show-error --max-time 4 "${CANDIDATE_BASE_URL}/api/version")"

jq -e --arg sha "$APP_COMMIT_SHA" --arg schema "$NORMALIZED_SCHEMA_FLAVOR" --arg tier "$DEPLOYMENT_TIER" '
  .status == "ready"
  and .commitSha == $sha
  and .schemaFlavor == $schema
  and .deploymentTier == $tier
  and ((has("workers") | not) or .workers.status == "healthy")
' <<<"$ready_json" >/dev/null || die 'candidate readiness identity or worker status is invalid'
jq -e --arg sha "$APP_COMMIT_SHA" --arg schema "$NORMALIZED_SCHEMA_FLAVOR" --arg tier "$DEPLOYMENT_TIER" '
  .commitSha == $sha and .schemaFlavor == $schema and .deploymentTier == $tier
' <<<"$version_json" >/dev/null || die 'candidate version identity is invalid'

if [[ "$DEPLOYMENT_TIER" == production ]]; then
  jq -e '
    .workers.status == "healthy"
    and .workers.integrationWorkersEnabled == true
    and ([
      "outbox.deliver", "notification.deliver", "print.deliver", "sop.execute",
      "payment.create.postar", "refund.execute.postar"
    ] - (.workers.adapterCapabilities // []) | length) == 0
  ' <<<"$ready_json" >/dev/null || die 'candidate integration workers are not commercially ready'
fi

docker exec \
  --env "APP_COMMIT_SHA=${APP_COMMIT_SHA}" \
  "$CANDIDATE_CONTAINER_NAME" \
  node dist-normalized/server/verify-normalized-commercial-readiness.js >/dev/null \
  || die 'candidate database is not commercially ready'

log "candidate verified: container=${CANDIDATE_CONTAINER_NAME} sha=${APP_COMMIT_SHA} digest=${EXPECTED_IMAGE_DIGEST}"
