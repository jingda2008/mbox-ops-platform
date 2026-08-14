#!/usr/bin/env bash
set -Eeuo pipefail

backup=${1:?Caddyfile backup is required}
caddy_container=${MBOX_CADDY_CONTAINER:-mbox-caddy}
case "${backup}" in
  /opt/mbox/ingress-backups/*) ;;
  *) echo "backup is outside the managed ingress backup directory" >&2; exit 1 ;;
esac
test -f "${backup}"
config_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/etc/caddy/Caddyfile") | .Source')
data_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/data") | .Source')
cat "${backup}" > "${config_source}"
chmod 0600 "${config_source}"
rm -f "${data_source}/mbox-ingress/payment-domain.caddy"
host_config_sha=$(sha256sum "${config_source}" | awk '{print $1}')
container_config_sha=$(docker exec "${caddy_container}" cat /etc/caddy/Caddyfile | sha256sum | awk '{print $1}')
test "${host_config_sha}" = "${container_config_sha}"
docker exec "${caddy_container}" caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null
jq -nc --arg backup "${backup}" '{status:"rolled_back",backup:$backup}'
