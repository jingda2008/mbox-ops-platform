#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$base/Sources/Domain.swift" "$base/Tests/CoreTests.swift" -o "$test_dir/core-tests"
"$test_dir/core-tests"
