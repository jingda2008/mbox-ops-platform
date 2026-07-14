#!/usr/bin/env bash
set -euo pipefail

cd /opt/mbox
set -a
source .env
set +a

mkdir -p backups
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="backups/mbox-pilot-${timestamp}.dump"

docker compose exec -T db pg_dump -U mbox -d mbox -Fc > "${file}"
token="$(curl -fsS -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | jq -r '.access_token')"
curl -fsS -X POST \
  -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@${file}" \
  "https://storage.googleapis.com/upload/storage/v1/b/${MBOX_BACKUP_BUCKET}/o?uploadType=media&name=$(basename "${file}")" >/dev/null
find backups -type f -name 'mbox-pilot-*.dump' -mtime +3 -delete
