#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=release-state.sh
source "${root}/deploy/aliyun/release-state.sh"
command -v flock >/dev/null
stat -c '%u:%a' /tmp >/dev/null

lock_root=$(mktemp -d)
trap 'rm -rf "${lock_root}"' EXIT
(release_lock_acquire "${lock_root}" "$(id -u)"; sleep 2) &
lock_holder=$!
for _ in $(seq 1 50); do
  [ -f "${lock_root}/locks/release.lock" ] && break
  sleep 0.02
done
test -f "${lock_root}/locks/release.lock"
if (release_lock_acquire "${lock_root}" "$(id -u)"); then
  echo 'second release acquired the global maintenance lock' >&2
  exit 1
fi
wait "${lock_holder}"
