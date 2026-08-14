#!/usr/bin/env bash
set -Eeuo pipefail

domain=${MBOX_PAYMENT_DOMAIN:-pay.shmbox.com}
certificate=${MBOX_PAYMENT_CERT_FILE:?MBOX_PAYMENT_CERT_FILE is required}
private_key=${MBOX_PAYMENT_KEY_FILE:?MBOX_PAYMENT_KEY_FILE is required}
caddy_container=${MBOX_CADDY_CONTAINER:-mbox-caddy}
backup_root=${MBOX_INGRESS_BACKUP_ROOT:-/opt/mbox/ingress-backups}

[[ "${domain}" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]
test -r "${certificate}"
test -r "${private_key}"
command -v docker >/dev/null
command -v jq >/dev/null
command -v openssl >/dev/null
command -v sha256sum >/dev/null

openssl x509 -in "${certificate}" -noout -checkhost "${domain}" >/dev/null
openssl x509 -in "${certificate}" -noout -checkend 604800 >/dev/null
cert_public=$(openssl x509 -in "${certificate}" -pubkey -noout | sha256sum | awk '{print $1}')
key_public=$(openssl pkey -in "${private_key}" -pubout 2>/dev/null | sha256sum | awk '{print $1}')
test "${cert_public}" = "${key_public}"

config_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/etc/caddy/Caddyfile") | .Source')
data_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/data") | .Source')
test -f "${config_source}"
test -d "${data_source}"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
ingress_directory=${data_source}/mbox-ingress
snippet=${ingress_directory}/payment-domain.caddy
install -d -m 0700 "${backup_root}" "${data_source}/mbox-certificates" "${ingress_directory}"
backup=${backup_root}/${timestamp}-Caddyfile
install -m 0600 "${config_source}" "${backup}"
snippet_backup=
if test -f "${snippet}"; then
  snippet_backup=${backup_root}/${timestamp}-payment-domain.caddy
  install -m 0600 "${snippet}" "${snippet_backup}"
fi
install -m 0600 "${certificate}" "${data_source}/mbox-certificates/${domain}.pem"
install -m 0600 "${private_key}" "${data_source}/mbox-certificates/${domain}.key"

candidate=$(mktemp)
snippet_candidate=$(mktemp)
cleanup() { rm -f "${candidate}" "${snippet_candidate}"; }
trap cleanup EXIT

cp "${config_source}" "${candidate}"
if ! grep -Fqx 'import /data/mbox-ingress/*.caddy' "${candidate}"; then
  printf '\nimport /data/mbox-ingress/*.caddy\n' >> "${candidate}"
fi

cat > "${snippet_candidate}" <<EOF
https://${domain} {
	tls /data/mbox-certificates/${domain}.pem /data/mbox-certificates/${domain}.key
	encode zstd gzip
	reverse_proxy mbox-app:8787
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
	log {
		output stdout
		format filter {
			request>uri query {
				replace token REDACTED
				replace tableToken REDACTED
				replace sessionToken REDACTED
				replace access_token REDACTED
				replace refresh_token REDACTED
				replace code REDACTED
				replace state REDACTED
				replace js_code REDACTED
				replace customerAuthCode REDACTED
			}
			wrap json
		}
	}
}
EOF

restore() {
  install -m 0600 "${backup}" "${config_source}"
  if test -n "${snippet_backup}"; then
    install -m 0600 "${snippet_backup}" "${snippet}"
  else
    rm -f "${snippet}"
  fi
  docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
}
trap 'restore' ERR
install -m 0600 "${candidate}" "${config_source}"
install -m 0600 "${snippet_candidate}" "${snippet}"
docker exec "${caddy_container}" caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null
curl --fail --silent --show-error --max-time 10 \
  --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/live" >/dev/null
trap - ERR

config_sha=$(sha256sum "${config_source}" | awk '{print $1}')
cert_fingerprint=$(openssl x509 -in "${certificate}" -noout -fingerprint -sha256 | cut -d= -f2)
jq -nc \
  --arg domain "${domain}" \
  --arg configSha256 "${config_sha}" \
  --arg certificateSha256 "${cert_fingerprint}" \
  --arg backup "${backup}" \
  --arg snippet "/data/mbox-ingress/payment-domain.caddy" \
  '{status:"configured",domain:$domain,configSha256:$configSha256,certificateSha256:$certificateSha256,rollbackBackup:$backup,persistentSnippet:$snippet}'
