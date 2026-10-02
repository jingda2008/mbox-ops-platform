#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
for script in "$base"/test-*.sh; do
  bash "$script"
done
