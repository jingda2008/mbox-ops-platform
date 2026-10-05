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
# Runs the real AppModel with an injected transport and no business-file reads.
swiftc -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" "$base/Tests/AppSessionTests.swift" -o "$test_dir/app-session-tests"
"$test_dir/app-session-tests" "$base/../shared/fixtures/live-contract.json"
