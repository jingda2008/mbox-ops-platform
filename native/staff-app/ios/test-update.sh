#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$base/Sources/AppUpdate.swift" "$base/Tests/UpdateTests.swift" -o "$test_dir/update-tests"
"$test_dir/update-tests" "$base/../shared/fixtures/app-update.json"
