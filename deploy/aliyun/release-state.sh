#!/usr/bin/env bash
set -euo pipefail

release_state_init() {
  local state_file=$1 release_sha=$2 image_digest=$3
  test ! -e "${state_file}"
  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg releaseSha "${release_sha}" \
    --arg imageDigest "${image_digest}" \
    '{schemaVersion:1,releaseSha:$releaseSha,imageDigest:$imageDigest,current:"frozen",history:[{state:"frozen",at:$timestamp}]}' \
    > "${state_file}"
  chmod 0600 "${state_file}"
}

release_state_require() {
  local state_file=$1 expected=$2
  test "$(jq -er '.current' "${state_file}")" = "${expected}" || {
    printf 'release state mismatch: expected %s\n' "${expected}" >&2
    return 1
  }
}

release_state_transition() {
  local state_file=$1 expected=$2 next=$3
  release_state_require "${state_file}" "${expected}" || return 1
  release_state_transition_allowed "${expected}" "${next}" || return 1
  local temporary
  temporary=$(mktemp "${state_file}.XXXXXX")
  jq \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg next "${next}" \
    '.current=$next | .history += [{state:$next,at:$timestamp}]' \
    "${state_file}" > "${temporary}"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${state_file}"
}

release_state_transition_allowed() {
  case "$1:$2" in
    frozen:artifact_verified|\
    artifact_verified:config_preflight_passed|\
    config_preflight_passed:external_preflight_passed|\
    external_preflight_passed:migration_compatible|\
    migration_compatible:backup_verified|\
    backup_verified:migrated|\
    migrated:provisioned|\
    provisioned:candidate_healthy|\
    candidate_healthy:candidate_deep_verified|\
    candidate_deep_verified:cutover_started|\
    cutover_started:cutover_verified|\
    cutover_verified:evidence_archived|\
    evidence_archived:completed|\
    completed:rolled_back|\
    provisioned:rolled_back|\
    candidate_healthy:rolled_back|\
    candidate_deep_verified:rolled_back|\
    cutover_started:rolled_back|\
    cutover_verified:rolled_back|\
    evidence_archived:rolled_back) return 0 ;;
    *) printf 'invalid release transition: %s -> %s\n' "$1" "$2" >&2; return 1 ;;
  esac
}
