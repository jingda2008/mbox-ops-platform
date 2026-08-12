#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}

test "$(id -u)" = 0
command -v docker >/dev/null
command -v aliyun >/dev/null
command -v jq >/dev/null
command -v flock >/dev/null
test -n "$(curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/ram/security-credentials/)"
docker exec mbox-app test -r /app/scripts/filter-sls-events.mjs

install -d -m 0755 "${install_root}/bin"
install -d -m 0700 "${install_root}/observability"
install -m 0755 "${repo_root}/deploy/aliyun/collect-selective-events.sh" "${install_root}/bin/collect-selective-events.sh"
install -m 0755 "${repo_root}/deploy/aliyun/send-sls-events.sh" "${install_root}/bin/send-sls-events.sh"
install -m 0644 "${repo_root}/deploy/aliyun/systemd/mbox-sls-collector.service" /etc/systemd/system/mbox-sls-collector.service
install -m 0644 "${repo_root}/deploy/aliyun/systemd/mbox-sls-collector.timer" /etc/systemd/system/mbox-sls-collector.timer

systemctl daemon-reload
systemctl enable --now mbox-sls-collector.timer
systemctl start mbox-sls-collector.service
systemctl is-active mbox-sls-collector.timer >/dev/null
test "$(systemctl show mbox-sls-collector.service --property=Result --value)" = success
printf 'selective_observability=installed\ntimer=active\n'
