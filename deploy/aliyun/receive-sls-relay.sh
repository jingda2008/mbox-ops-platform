#!/usr/bin/env bash
set -Eeuo pipefail
# Use only as an SSH forced command for the application's restricted log key.
# No SSH argument is executed, and only bounded, allowlisted SLS events are sent.
input=$(mktemp)
trap 'rm -f "${input}"' EXIT
head -c 524289 > "${input}"
test "$(wc -c < "${input}")" -le 524288
test "$(wc -l < "${input}")" -le 500
exec 9>/opt/mbox/observability/sls-relay.lock
flock -w 10 9
/opt/mbox/bin/send-sls-events.sh "${input}"
