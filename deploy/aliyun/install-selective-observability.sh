#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}
container=${MBOX_APP_CONTAINER:-mbox-app}
filter_path=/app/scripts/filter-sls-events.mjs

fail() {
  printf 'selective observability installation failed: %s\n' "$1" >&2
  exit 1
}

trap 'status=$?; printf "selective observability installation failed unexpectedly at line %s (exit %s)\n" "${LINENO}" "${status}" >&2; exit "${status}"' ERR

test "$(id -u)" = 0 || fail 'root privileges are required'
command -v docker >/dev/null || fail 'docker is required'
command -v jq >/dev/null || fail 'jq is required'
command -v flock >/dev/null || fail 'flock is required'
relay=${MBOX_SLS_USE_RELAY:-0}
if [ "${relay}" = 1 ]; then
  test -f "${install_root}/observability/sls-relay-ed25519" || fail 'restricted relay identity missing'
  test -f "${install_root}/observability/sls-relay-known-hosts" || fail 'pinned relay host identity missing'
else
  command -v aliyun >/dev/null || fail 'aliyun CLI is required'
  ram_role=$(curl -fsS --max-time 2 http://100.100.100.200/latest/meta-data/ram/security-credentials/) \
    || fail 'ECS RAM role metadata is unavailable'
  test -n "${ram_role}" || fail 'ECS RAM role is not attached'
fi
docker container inspect "${container}" >/dev/null 2>&1 \
  || fail "application container ${container} is unavailable"
docker exec "${container}" test -r "${filter_path}" \
  || fail "normalized image is missing ${filter_path}; install a corrected image before enabling the collector"
docker exec "${container}" node --check "${filter_path}" >/dev/null \
  || fail "${filter_path} failed the Node.js syntax check"

install -d -m 0755 "${install_root}/bin"
install -d -m 0700 "${install_root}/observability"
install -m 0755 "${repo_root}/deploy/aliyun/collect-selective-events.sh" "${install_root}/bin/collect-selective-events.sh"
install -m 0755 "${repo_root}/deploy/aliyun/send-sls-events.sh" "${install_root}/bin/send-sls-events.sh"
if [ "${relay}" = 1 ]; then
  install -m 0755 "${repo_root}/deploy/aliyun/send-sls-relay.sh" "${install_root}/bin/send-sls-relay.sh"
  printf 'MBOX_SLS_SENDER=%s/bin/send-sls-relay.sh\n' "${install_root}" > "${install_root}/observability/collector.env"
  chmod 0600 "${install_root}/observability/collector.env"
fi
install -m 0644 "${repo_root}/deploy/aliyun/systemd/mbox-sls-collector.service" /etc/systemd/system/mbox-sls-collector.service
install -m 0644 "${repo_root}/deploy/aliyun/systemd/mbox-sls-collector.timer" /etc/systemd/system/mbox-sls-collector.timer

systemctl daemon-reload || fail 'systemd daemon reload failed'
systemctl enable --now mbox-sls-collector.timer || fail 'collector timer could not be enabled'
systemctl start mbox-sls-collector.service || fail 'initial collector run failed'
systemctl is-active mbox-sls-collector.timer >/dev/null || fail 'collector timer is not active'
test "$(systemctl show mbox-sls-collector.service --property=Result --value)" = success \
  || fail 'collector service did not complete successfully'
printf 'selective_observability=installed\ntimer=active\n'
