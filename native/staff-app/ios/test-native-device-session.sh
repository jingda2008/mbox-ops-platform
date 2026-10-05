#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
cp -R "$base/Sources" "$test_dir/Sources"
cp "$base/Tests/NativeDeviceSessionTests.swift" "$test_dir/NativeDeviceSessionTests.swift"
sources=()
for source in "$test_dir"/Sources/*.swift; do
  case "$(basename "$source")" in
    *View.swift|*Forms.swift|MBOXApp.swift|ButtonDesign.swift|MenuComponents.swift|LiveOrderCheckout.swift|LiveTableActions.swift) continue ;;
  esac
  sources+=("$source")
done
swiftc -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" "$test_dir/NativeDeviceSessionTests.swift" -o "$test_dir/native-device-session-tests"
"$test_dir/native-device-session-tests"
