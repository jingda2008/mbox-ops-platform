#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$base/Sources/SpeechDraft.swift" "$base/Tests/SpeechDraftTests.swift" -o "$test_dir/speech-draft-tests"
"$test_dir/speech-draft-tests"
