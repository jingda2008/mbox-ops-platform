#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/android/validation-twa"
KEYSTORE_PATH="$HOME/.mbox-secrets/android/mbox-ops-validation.p12"
KEY_ALIAS="mbox-ops-validation"
KEYCHAIN_SERVICE="com.superhigh.mbox.ops.validation.keystore"
OUTPUT_DIR="$ROOT_DIR/deliverables/android"

if [[ ! -f "$PROJECT_DIR/twa-manifest.json" ]]; then
  echo "Android validation project is missing: $PROJECT_DIR/twa-manifest.json" >&2
  exit 1
fi
if [[ ! -f "$KEYSTORE_PATH" ]]; then
  echo "Android validation keystore is missing: $KEYSTORE_PATH" >&2
  exit 1
fi

KEYSTORE_PASSWORD="$(security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w)"
export BUBBLEWRAP_KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD"
export BUBBLEWRAP_KEY_PASSWORD="$KEYSTORE_PASSWORD"
trap 'unset BUBBLEWRAP_KEYSTORE_PASSWORD BUBBLEWRAP_KEY_PASSWORD KEYSTORE_PASSWORD' EXIT

(
  cd "$PROJECT_DIR"
  bubblewrap build \
    --signingKeyPath="$KEYSTORE_PATH" \
    --signingKeyAlias="$KEY_ALIAS"
)

APP_VERSION="$(jq -r '.appVersion' "$PROJECT_DIR/twa-manifest.json")"
mkdir -p "$OUTPUT_DIR"
cp "$PROJECT_DIR/app-release-signed.apk" "$OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.apk"
cp "$PROJECT_DIR/app-release-bundle.aab" "$OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.aab"
shasum -a 256 "$OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.apk" > "$OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.apk.sha256"

echo "APK: $OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.apk"
echo "AAB: $OUTPUT_DIR/MBOX-Ops-Validation-$APP_VERSION.aab"
