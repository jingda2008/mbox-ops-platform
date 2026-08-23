#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT_DIR/ios/App/App.xcodeproj"
DERIVED_DATA="$ROOT_DIR/output/ios/DerivedData"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/App.app"
DEVICE_NAME="MBOX iPhone Validation"
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
RUNTIME="com.apple.CoreSimulator.SimRuntime.iOS-26-5"

export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=http.proxy
export GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=https.proxy
export GIT_CONFIG_VALUE_1=

if ! xcrun simctl list runtimes | grep -q 'iOS 26.5'; then
  echo "错误：缺少 iOS 26.5 Simulator，请运行 xcodebuild -downloadPlatform iOS。" >&2
  exit 1
fi

device_id="$(xcrun simctl list devices | sed -n "s/.*$DEVICE_NAME (\([0-9A-F-]*\)).*/\1/p" | head -1)"
if [[ -z "$device_id" ]]; then
  device_id="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
fi

# The native Xcode project references Capacitor's generated web bundle.  A
# clean checkout does not contain those generated files, so refresh them
# before building instead of relying on a developer having run sync manually.
cd "$ROOT_DIR"
npm run ios:sync

xcrun simctl boot "$device_id" 2>/dev/null || true
xcodebuild \
  -project "$PROJECT" \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$DERIVED_DATA" \
  -packageAuthorizationProvider netrc \
  -scmProvider system \
  -disableAutomaticPackageResolution \
  CODE_SIGNING_ALLOWED=NO \
  build

xcrun simctl install "$device_id" "$APP_PATH"
xcrun simctl launch "$device_id" com.superhigh.mbox.ops
echo "M-BOX iOS 模拟器验证已启动：$device_id"
