#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$base/Sources/ServiceAttention.swift" "$base/Tests/ServiceAttentionTests.swift" -o "$test_dir/test"
"$test_dir/test"
