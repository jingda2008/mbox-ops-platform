#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
# Let Xcode embed simulator entitlements and sign nested binaries correctly.
# Simulator.entitlements is scoped to iphonesimulator in the project settings;
# real devices and distribution require the actual Apple signing team/profile.
xcodebuild -project "$base/MBOXStaff.xcodeproj" -scheme MBOXStaff -sdk iphonesimulator -configuration Debug -derivedDataPath "$base/build" CODE_SIGNING_ALLOWED=YES build
