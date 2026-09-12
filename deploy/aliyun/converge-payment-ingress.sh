#!/usr/bin/env bash
set -Eeuo pipefail
# Run on the legacy payment/evidence relay only, after verifying the current
# application release. Keep TLS verification and preserve the old container/logs.
expected=${MBOX_EXPECTED_PRIMARY_SHA:?full primary release SHA is required}
legacy=${MBOX_EXPECTED_LEGACY_SHA:?full legacy SHA is required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]]
[[ "$legacy" =~ ^[0-9a-f]{40}$ ]]
test "$(docker inspect mbox-app --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$legacy"
primary_ready() {
 curl --resolve mbox.shmbox.com:443:10.100.80.223 -fsS --max-time 10 https://mbox.shmbox.com/api/ready \
  | jq -e --arg sha "$expected" '.status=="ready" and .deploymentTier=="production" and .commitSha==$sha' >/dev/null
}
primary_ready
config=$(docker inspect mbox-caddy | jq -er '.[0].Mounts[]|select(.Destination=="/etc/caddy/Caddyfile")|.Source')
data=$(docker inspect mbox-caddy | jq -er '.[0].Mounts[]|select(.Destination=="/data")|.Source')
snippet="$data/mbox-ingress/payment-domain.caddy"
watchdog=/opt/mbox/config/health-watchdog.env
test -f "$config"; test -f "$snippet"; test -f "$watchdog"
backup="/opt/mbox/ingress-backups/$(date -u +%Y%m%dT%H%M%SZ)-converged"
install -d -m 0700 "$backup" /opt/mbox/locks /opt/mbox/run/health-watchdog
exec 8>/opt/mbox/locks/release.lock; flock -w 30 8
exec 9>/opt/mbox/run/health-watchdog/watchdog.lock; flock -w 30 9
cp "$config" "$backup/Caddyfile"; cp "$snippet" "$backup/payment-domain.caddy"; cp "$watchdog" "$backup/health-watchdog.env"
chmod 0600 "$backup"/*
rewrite() {
 awk '
 /^[ \t]*reverse_proxy mbox-app:8787[ \t]*$/ {
  print "\treverse_proxy https://10.100.80.223 {"
  print "\t\theader_up Host mbox.shmbox.com"
  print "\t\ttransport http {"
  print "\t\t\ttls_server_name mbox.shmbox.com"
  print "\t\t}"
  print "\t}"
  next
 } {print}' "$1"
}
rewrite "$backup/Caddyfile" > "$backup/Caddyfile.next"
rewrite "$backup/payment-domain.caddy" > "$backup/payment-domain.caddy.next"
# No legacy upstream may remain in either public ingress.
! grep -q 'reverse_proxy mbox-app' "$backup/Caddyfile.next" "$backup/payment-domain.caddy.next"
stopped=0
restore_on_error() {
 if [ "$stopped" = 0 ]; then
  cat "$backup/Caddyfile" > "$config"; cp "$backup/payment-domain.caddy" "$snippet"; cp "$backup/health-watchdog.env" "$watchdog"
  docker exec mbox-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
 else
  echo 'legacy runtime remains stopped; current ingress preserved for investigation' >&2
 fi
}
trap restore_on_error ERR
cat "$backup/Caddyfile.next" > "$config"; cp "$backup/payment-domain.caddy.next" "$snippet"
docker exec mbox-caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec mbox-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
verify_ingress() {
 for origin in pay.shmbox.com 139.224.254.60; do
  curl --resolve "$origin:443:127.0.0.1" -fsS --max-time 10 "https://$origin/api/ready" \
   | jq -e --arg sha "$expected" '.status=="ready" and .commitSha==$sha' >/dev/null
 done
}
verify_ingress
# Remove the old process from watchdog/reboot resurrection before stopping it.
sed '/^MBOX_REQUIRED_CONTAINERS=/d' "$backup/health-watchdog.env" > "$watchdog"
printf '\nMBOX_REQUIRED_CONTAINERS="mbox-caddy"\n' >> "$watchdog"
chmod 0600 "$watchdog"
docker update --restart=no mbox-app >/dev/null
docker stop --time 30 mbox-app >/dev/null
stopped=1
test "$(docker inspect mbox-app --format '{{.State.Running}}')" = false
primary_ready; verify_ingress
trap - ERR
jq -n --arg sha "$expected" --arg legacy "$legacy" --arg backup "$backup" \
 '{primarySha:$sha,legacySha:$legacy,legacyStopped:true,ingressVerified:true,backup:$backup}' | tee "$backup/result.json"
