#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

require_value APP_COMMIT_SHA
require_value EXPECTED_IMAGE_DIGEST
require_value CANDIDATE_CONTAINER_NAME
require_value CANDIDATE_BASE_URL
require_value PUBLIC_BASE_URL
validate_commit_sha "$APP_COMMIT_SHA"
validate_image_digest "$EXPECTED_IMAGE_DIGEST"
assert_candidate_name "$CANDIDATE_CONTAINER_NAME"

ACTIVE_CONTAINER_NAME="${ACTIVE_CONTAINER_NAME:-$PROTECTED_CONTAINER_NAME}"
CADDY_CONTAINER_NAME="${CADDY_CONTAINER_NAME:-mbox-caddy}"
DEPLOYMENT_TIER="${DEPLOYMENT_TIER:-validation}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/opt/mbox/normalized-releases/${APP_COMMIT_SHA:0:7}}"
case "$DEPLOYMENT_TIER" in
  validation|production) ;;
  *) die 'DEPLOYMENT_TIER must be validation or production' ;;
esac
[[ "$ACTIVE_CONTAINER_NAME" == "$PROTECTED_CONTAINER_NAME" ]] \
  || die 'ACTIVE_CONTAINER_NAME must remain the protected production name'

if ! is_apply_mode; then
  log 'candidate activation is in dry-run mode; no routing or container changes will occur'
  log "planned activation: candidate=${CANDIDATE_CONTAINER_NAME} active=${ACTIVE_CONTAINER_NAME} tier=${DEPLOYMENT_TIER}"
  exit 0
fi

require_apply_confirmation NORMALIZED_ACTIVATION_CONFIRM 'ACTIVATE_VERIFIED_NORMALIZED_CANDIDATE'
require_tool curl
require_tool docker
require_tool jq

docker container inspect "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1 \
  || die 'active container is missing'
docker container inspect "$CADDY_CONTAINER_NAME" >/dev/null 2>&1 \
  || die 'Caddy container is missing'
docker container inspect "$CANDIDATE_CONTAINER_NAME" >/dev/null 2>&1 \
  || die 'candidate container is missing'
caddy_source="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER_NAME")"
case "$caddy_source" in
  /opt/mbox/*) ;;
  *) die 'Caddy configuration source must be a file below /opt/mbox' ;;
esac
require_file "$caddy_source"

candidate_sha="$(docker container inspect --format '{{index .Config.Labels "com.mbox.release.sha"}}' "$CANDIDATE_CONTAINER_NAME")"
candidate_schema="$(docker container inspect --format '{{index .Config.Labels "com.mbox.schema-flavor"}}' "$CANDIDATE_CONTAINER_NAME")"
candidate_image="$(docker container inspect --format '{{.Image}}' "$CANDIDATE_CONTAINER_NAME")"
[[ "$candidate_sha" == "$APP_COMMIT_SHA" ]] || die 'candidate release label does not match APP_COMMIT_SHA'
[[ "$candidate_schema" == "$NORMALIZED_SCHEMA_FLAVOR" ]] || die 'candidate schema label mismatch'
[[ "$candidate_image" == "$EXPECTED_IMAGE_DIGEST" ]] || die 'candidate image digest mismatch'

MBOX_DEPLOY_APPLY=1 \
  NORMALIZED_VERIFY_CONFIRM=VERIFY_ISOLATED_CANDIDATE \
  DEPLOYMENT_TIER="$DEPLOYMENT_TIER" \
  "${SCRIPT_DIR}/verify-candidate.sh"
curl --fail --silent --show-error --max-time 8 "${PUBLIC_BASE_URL}/api/ready" >/dev/null \
  || die 'current public service is not ready before cutover'

install -d -m 0700 "$EVIDENCE_DIR"
current_caddy="${EVIDENCE_DIR}/Caddyfile.previous"
candidate_caddy="${EVIDENCE_DIR}/Caddyfile.candidate"
final_caddy="${EVIDENCE_DIR}/Caddyfile.final"
docker exec "$CADDY_CONTAINER_NAME" cat /etc/caddy/Caddyfile > "$current_caddy"
grep -q "${ACTIVE_CONTAINER_NAME}:8787" "$current_caddy" \
  || die 'current Caddy configuration does not target the active container'

sed -E \
  -e "s/${ACTIVE_CONTAINER_NAME}:8787/${CANDIDATE_CONTAINER_NAME}:8787/g" \
  -e "s/mbox-normalized-candidate-[A-Za-z0-9_.-]+:8787/${CANDIDATE_CONTAINER_NAME}:8787/g" \
  "$current_caddy" > "$candidate_caddy"
sed "s/${CANDIDATE_CONTAINER_NAME}:8787/${ACTIVE_CONTAINER_NAME}:8787/g" \
  "$candidate_caddy" > "$final_caddy"

rollback_container="${ACTIVE_CONTAINER_NAME}-rollback-${APP_COMMIT_SHA:0:7}-$(date +%Y%m%d-%H%M%S)"
traffic_switched=0
old_renamed=0
promoted=0
persistent_config_updated=0
complete=0

reload_caddy() {
  local source_file="$1"
  local target_file="$2"
  docker cp "$source_file" "${CADDY_CONTAINER_NAME}:${target_file}"
  docker exec "$CADDY_CONTAINER_NAME" \
    caddy validate --config "$target_file" --adapter caddyfile >/dev/null
  docker exec "$CADDY_CONTAINER_NAME" \
    caddy reload --config "$target_file" --adapter caddyfile >/dev/null
}

verify_public_candidate() {
  local attempts="${1:-15}"
  local response
  for _ in $(seq 1 "$attempts"); do
    response="$(curl --fail --silent --show-error --max-time 8 "${PUBLIC_BASE_URL}/api/ready" 2>/dev/null || true)"
    if jq -e --arg sha "$APP_COMMIT_SHA" --arg schema "$NORMALIZED_SCHEMA_FLAVOR" '
      .status == "ready" and .commitSha == $sha and .schemaFlavor == $schema
    ' <<<"$response" >/dev/null 2>&1
    then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_on_error() {
  local exit_code=$?
  [[ "$complete" == 1 ]] && return
  set +e
  log 'activation failed; restoring the previous container and Caddy configuration'
  if [[ "$promoted" == 1 ]]; then
    docker update --restart=no "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
    docker stop -t 20 "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
    docker rename "$ACTIVE_CONTAINER_NAME" "mbox-failed-${APP_COMMIT_SHA:0:7}-$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1
    docker rename "$rollback_container" "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
    docker start "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
  elif [[ "$old_renamed" == 1 ]]; then
    docker rename "$rollback_container" "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
    docker start "$ACTIVE_CONTAINER_NAME" >/dev/null 2>&1
  fi
  if [[ "$traffic_switched" == 1 ]]; then
    if [[ "$persistent_config_updated" == 1 ]]; then
      cp "$current_caddy" "$caddy_source" >/dev/null 2>&1
    fi
    reload_caddy "$current_caddy" /tmp/Caddyfile.rollback >/dev/null 2>&1
  fi
  curl --fail --silent --show-error --max-time 8 "${PUBLIC_BASE_URL}/api/ready" >/dev/null 2>&1
  exit "$exit_code"
}
trap rollback_on_error ERR INT TERM

reload_caddy "$candidate_caddy" /tmp/Caddyfile.normalized-candidate
traffic_switched=1
verify_public_candidate 15

docker update --restart=no "$ACTIVE_CONTAINER_NAME" >/dev/null
docker stop -t 30 "$ACTIVE_CONTAINER_NAME" >/dev/null
docker rename "$ACTIVE_CONTAINER_NAME" "$rollback_container"
old_renamed=1
docker rename "$CANDIDATE_CONTAINER_NAME" "$ACTIVE_CONTAINER_NAME"
promoted=1
docker update --restart=unless-stopped "$ACTIVE_CONTAINER_NAME" >/dev/null

reload_caddy "$final_caddy" /tmp/Caddyfile.normalized-final
verify_public_candidate 15
cp "$final_caddy" "$caddy_source"
persistent_config_updated=1
docker exec "$CADDY_CONTAINER_NAME" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker exec "$CADDY_CONTAINER_NAME" \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
verify_public_candidate 15

deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg deployedAt "$deployed_at" \
  --arg tier "$DEPLOYMENT_TIER" \
  --arg releaseSha "$APP_COMMIT_SHA" \
  --arg imageDigest "$EXPECTED_IMAGE_DIGEST" \
  --arg schemaFlavor "$NORMALIZED_SCHEMA_FLAVOR" \
  --arg rollbackContainer "$rollback_container" \
  '{
    schemaVersion: 1,
    deployedAt: $deployedAt,
    tier: $tier,
    releaseSha: $releaseSha,
    imageDigest: $imageDigest,
    schemaFlavor: $schemaFlavor,
    rollbackContainer: $rollbackContainer
  }' > "$EVIDENCE_DIR/deployment-manifest.json"
(
  cd "$EVIDENCE_DIR"
  sha256sum Caddyfile.previous Caddyfile.final deployment-manifest.json > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

complete=1
trap - ERR INT TERM
log "candidate activated: sha=${APP_COMMIT_SHA} digest=${EXPECTED_IMAGE_DIGEST} rollback=${rollback_container}"
