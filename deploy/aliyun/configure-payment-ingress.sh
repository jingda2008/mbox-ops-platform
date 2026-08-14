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

work_directory=$(mktemp -d)
candidate=${work_directory}/Caddyfile
snippet_candidate=${work_directory}/payment-domain.caddy
certificate_chain=${work_directory}/${domain}.pem
cleanup() { rm -rf "${work_directory}"; }
trap cleanup EXIT

awk -v directory="${work_directory}" '
  /-----BEGIN CERTIFICATE-----/ {
    count += 1
    output = sprintf("%s/certificate-%03d.pem", directory, count)
  }
  output != "" { print > output }
  /-----END CERTIFICATE-----/ {
    close(output)
    output = ""
  }
  END { if (count == 0) exit 1 }
' "${certificate}"
certificate_parts=("${work_directory}"/certificate-*.pem)
input_certificate_count=${#certificate_parts[@]}
served_certificate_count=0
removed_self_signed_roots=0
: > "${certificate_chain}"
for certificate_part in "${certificate_parts[@]}"; do
  subject=$(openssl x509 -in "${certificate_part}" -noout -subject -nameopt RFC2253)
  issuer=$(openssl x509 -in "${certificate_part}" -noout -issuer -nameopt RFC2253)
  if [ "${input_certificate_count}" -gt 1 ] && [ "${subject#subject=}" = "${issuer#issuer=}" ]; then
    removed_self_signed_roots=$((removed_self_signed_roots + 1))
    continue
  fi
  cat "${certificate_part}" >> "${certificate_chain}"
  served_certificate_count=$((served_certificate_count + 1))
done
test "${served_certificate_count}" -gt 0
openssl x509 -in "${certificate_chain}" -noout -checkhost "${domain}" >/dev/null

config_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/etc/caddy/Caddyfile") | .Source')
data_source=$(docker inspect "${caddy_container}" \
  | jq -er '.[0].Mounts[] | select(.Destination == "/data") | .Source')
test -f "${config_source}"
test -d "${data_source}"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
ingress_directory=${data_source}/mbox-ingress
snippet=${ingress_directory}/payment-domain.caddy
managed_certificate=${data_source}/mbox-certificates/${domain}.pem
managed_private_key=${data_source}/mbox-certificates/${domain}.key
install -d -m 0700 "${backup_root}" "${data_source}/mbox-certificates" "${ingress_directory}"
backup=${backup_root}/${timestamp}-Caddyfile
install -m 0600 "${config_source}" "${backup}"
snippet_backup=
certificate_backup=
private_key_backup=
if test -f "${snippet}"; then
  snippet_backup=${backup_root}/${timestamp}-payment-domain.caddy
  install -m 0600 "${snippet}" "${snippet_backup}"
fi
if test -f "${managed_certificate}"; then
  certificate_backup=${backup_root}/${timestamp}-${domain}.pem
  install -m 0600 "${managed_certificate}" "${certificate_backup}"
fi
if test -f "${managed_private_key}"; then
  private_key_backup=${backup_root}/${timestamp}-${domain}.key
  install -m 0600 "${managed_private_key}" "${private_key_backup}"
fi
install -m 0600 "${certificate_chain}" "${managed_certificate}"
install -m 0600 "${private_key}" "${managed_private_key}"

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
  if test -n "${certificate_backup}"; then
    install -m 0600 "${certificate_backup}" "${managed_certificate}"
  else
    rm -f "${managed_certificate}"
  fi
  if test -n "${private_key_backup}"; then
    install -m 0600 "${private_key_backup}" "${managed_private_key}"
  else
    rm -f "${managed_private_key}"
  fi
  docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
}
trap 'restore' ERR
install -m 0600 "${candidate}" "${config_source}"
install -m 0600 "${snippet_candidate}" "${snippet}"
docker exec "${caddy_container}" caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec "${caddy_container}" caddy reload --config /etc/caddy/Caddyfile >/dev/null
probe_succeeded=0
for _ in $(seq 1 20); do
  if curl --fail --silent --max-time 2 \
    --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/live" >/dev/null 2>&1; then
    probe_succeeded=1
    break
  fi
  sleep 0.5
done
test "${probe_succeeded}" = 1
trap - ERR

config_sha=$(sha256sum "${config_source}" | awk '{print $1}')
cert_fingerprint=$(openssl x509 -in "${certificate_chain}" -noout -fingerprint -sha256 | cut -d= -f2)
jq -nc \
  --arg domain "${domain}" \
  --arg configSha256 "${config_sha}" \
  --arg certificateSha256 "${cert_fingerprint}" \
  --arg backup "${backup}" \
  --arg snippet "/data/mbox-ingress/payment-domain.caddy" \
  --argjson inputCertificateCount "${input_certificate_count}" \
  --argjson servedCertificateCount "${served_certificate_count}" \
  --argjson removedSelfSignedRoots "${removed_self_signed_roots}" \
  '{status:"configured",domain:$domain,configSha256:$configSha256,certificateSha256:$certificateSha256,rollbackBackup:$backup,persistentSnippet:$snippet,inputCertificateCount:$inputCertificateCount,servedCertificateCount:$servedCertificateCount,removedSelfSignedRoots:$removedSelfSignedRoots}'
