#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
sources=()
for source in "$base"/Sources/*.swift; do
  case "$(basename "$source")" in
    *View.swift|MBOXApp.swift|ButtonDesign.swift|MenuComponents.swift|LiveOrderCheckout.swift|LiveTableActions.swift) continue ;;
  esac
  sources+=("$source")
done
swiftc -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" "$base/Tests/NativePushTests.swift" -o "$test_dir/native-push-tests"
"$test_dir/native-push-tests" "$base/../shared/fixtures/live-contract.json"
