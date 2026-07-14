#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates cron curl jq
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
systemctl enable --now cron
curl -fsSLO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
bash add-google-cloud-ops-agent-repo.sh --also-install
rm -f add-google-cloud-ops-agent-repo.sh
mkdir -p /opt/mbox/bootstrap /opt/mbox/backups
chmod 700 /opt/mbox /opt/mbox/bootstrap /opt/mbox/backups
touch /var/lib/mbox-pilot-startup-complete
