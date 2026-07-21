#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IOS_PROJECT="$ROOT_DIR/ios/App/App.xcodeproj"
ARCHIVE_PATH="$ROOT_DIR/output/ios/MBOXOps.xcarchive"
EXPORT_DIR="$ROOT_DIR/output/ios/export"

# The user's optional global Git proxy may be offline during Xcode package resolution.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=http.proxy
export GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=https.proxy
export GIT_CONFIG_VALUE_1=

if [[ ! -d /Applications/Xcode.app ]]; then
  echo "错误：未安装完整 Xcode。请先从 Mac App Store 安装 Xcode。" >&2
  exit 1
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "错误：Xcode 尚未完成首次启动或许可证确认。请运行 sudo xcodebuild -license accept 和 sudo xcodebuild -runFirstLaunch。" >&2
  exit 1
fi

if [[ ! -f "$IOS_PROJECT/project.pbxproj" ]]; then
  echo "错误：iOS 原生工程不存在，请先运行 npx cap add ios --packagemanager SPM。" >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q 'Apple Development\|Apple Distribution'; then
  echo "错误：本机没有 Apple 开发/发行签名证书，无法生成可安装 IPA。" >&2
  echo "请在 Xcode > Settings > Accounts 登录 Apple Developer 账号并创建证书。" >&2
  exit 1
fi

cd "$ROOT_DIR"
npm run ios:sync
mkdir -p "$(dirname "$ARCHIVE_PATH")" "$EXPORT_DIR"

xcodebuild \
  -project "$IOS_PROJECT" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -packageAuthorizationProvider netrc \
  -scmProvider system \
  -allowProvisioningUpdates \
  archive

if [[ ! -f "$ROOT_DIR/ios/ExportOptions-AdHoc.plist" ]]; then
  echo "归档已生成，但缺少 ios/ExportOptions-AdHoc.plist；请填写 Apple Team ID 后再导出 IPA。" >&2
  exit 1
fi

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$ROOT_DIR/ios/ExportOptions-AdHoc.plist" \
  -packageAuthorizationProvider netrc \
  -scmProvider system \
  -allowProvisioningUpdates

echo "iOS 安装包输出目录：$EXPORT_DIR"
