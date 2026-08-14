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
install -m 0600 "${backup}" "${config_source}"
rm -f "${data_source}/mbox-ingress/payment-domain.caddy"
docker exec "${caddy_container}" caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null
jq -nc --arg backup "${backup}" '{status:"rolled_back",backup:$backup}'
