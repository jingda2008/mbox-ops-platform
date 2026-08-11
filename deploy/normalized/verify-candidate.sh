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
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-75}"
[[ "$VERIFY_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die 'VERIFY_TIMEOUT_SECONDS must be numeric'

if ! is_apply_mode; then
  log 'candidate verification is in dry-run mode; no Docker or HTTP request will run'
  log 'planned checks: image digest, image SHA label, container image ID, /api/version and /api/ready'
  exit 0
fi

require_apply_confirmation NORMALIZED_VERIFY_CONFIRM 'VERIFY_ISOLATED_CANDIDATE'
require_tool docker
require_tool curl
require_tool node
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

READY_JSON="$ready_json" VERSION_JSON="$version_json" EXPECTED_SHA="$APP_COMMIT_SHA" \
EXPECTED_SCHEMA="$NORMALIZED_SCHEMA_FLAVOR" node --input-type=module <<'NODE'
const ready = JSON.parse(process.env.READY_JSON)
const version = JSON.parse(process.env.VERSION_JSON)
const expectedSha = process.env.EXPECTED_SHA
const expectedSchema = process.env.EXPECTED_SCHEMA
if (ready.status !== 'ready') throw new Error('candidate readiness status is not ready')
if (ready.commitSha !== expectedSha || version.commitSha !== expectedSha) {
  throw new Error('candidate API commit SHA mismatch')
}
if (ready.schemaFlavor !== expectedSchema || version.schemaFlavor !== expectedSchema) {
  throw new Error('candidate API schema flavor mismatch')
}
const requiredAdapterCapabilities = [
  'outbox.deliver', 'notification.deliver', 'print.deliver', 'sop.execute',
  'payment.create.postar', 'refund.execute.postar',
]
const adapterCapabilities = new Set(ready.workers?.adapterCapabilities ?? [])
if (ready.workers?.status !== 'healthy' || ready.workers?.integrationWorkersEnabled !== true
  || requiredAdapterCapabilities.some((capability) => !adapterCapabilities.has(capability))) {
  throw new Error('candidate integration workers are not healthy')
}
NODE

docker exec \
  --env "APP_COMMIT_SHA=${APP_COMMIT_SHA}" \
  "$CANDIDATE_CONTAINER_NAME" \
  node dist-normalized/server/verify-normalized-commercial-readiness.js >/dev/null \
  || die 'candidate database is not commercially ready'

log "candidate verified: container=${CANDIDATE_CONTAINER_NAME} sha=${APP_COMMIT_SHA} digest=${EXPECTED_IMAGE_DIGEST}"
