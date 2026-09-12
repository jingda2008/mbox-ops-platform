#!/usr/bin/env bash
set -Eeuo pipefail
input=${1:?JSONL input is required}
# Deployment pins this relay host key in a dedicated known_hosts file.
test -f "${input}"
exec ssh -T -i /opt/mbox/observability/sls-relay-ed25519 \
 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
 -o UserKnownHostsFile=/opt/mbox/observability/sls-relay-known-hosts \
 -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
 -p 6122 root@139.224.254.60 < "${input}"
