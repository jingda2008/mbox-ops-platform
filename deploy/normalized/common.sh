#!/usr/bin/env bash
set -Eeuo pipefail

NORMALIZED_SCHEMA_FLAVOR='normalized-core-v1'
PROTECTED_CONTAINER_NAME='mbox-app'

log() {
  printf '[normalized-deploy] %s\n' "$*"
}

die() {
  printf '[normalized-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

is_apply_mode() {
  [[ "${MBOX_DEPLOY_APPLY:-0}" == '1' ]]
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "missing required environment variable: ${name}"
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || die "required file does not exist: ${path}"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool is unavailable: $1"
}

validate_commit_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{7,64}$ ]] || die 'APP_COMMIT_SHA must be a 7-64 character hexadecimal commit SHA'
}

validate_image_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'EXPECTED_IMAGE_DIGEST must use sha256:<64 lowercase hex characters>'
}

assert_candidate_name() {
  local name="$1"
  [[ "$name" != "$PROTECTED_CONTAINER_NAME" ]] || die 'the existing production container is protected'
  [[ "$name" =~ ^mbox-normalized-candidate-[a-zA-Z0-9_.-]+$ ]] \
    || die 'candidate container name must start with mbox-normalized-candidate-'
}

print_command() {
  printf '[normalized-deploy] DRY-RUN:'
  printf ' %q' "$@"
  printf '\n'
}

run_mutation() {
  if is_apply_mode; then
    "$@"
  else
    print_command "$@"
  fi
}

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}

verify_image_identity() {
  local image_ref="$1"
  local expected_sha="$2"
  local expected_digest="$3"
  local actual_sha actual_digest schema_flavor

  actual_sha="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
  actual_digest="$(image_id "$image_ref")"
  schema_flavor="$(docker image inspect --format '{{index .Config.Labels "com.mbox.schema-flavor"}}' "$image_ref")"

  [[ "$actual_sha" == "$expected_sha" ]] || die 'image commit label does not match APP_COMMIT_SHA'
  [[ "$actual_digest" == "$expected_digest" ]] || die 'image content digest does not match EXPECTED_IMAGE_DIGEST'
  [[ "$schema_flavor" == "$NORMALIZED_SCHEMA_FLAVOR" ]] || die 'image schema flavor is not normalized-core-v1'
}

require_apply_confirmation() {
  local confirmation_name="$1"
  local confirmation_value="$2"
  if ! is_apply_mode; then
    return 0
  fi
  [[ "${!confirmation_name:-}" == "$confirmation_value" ]] \
    || die "apply mode requires ${confirmation_name}=${confirmation_value}"
}
