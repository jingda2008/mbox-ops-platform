#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
backup="${1:?usage: restore-postgres.sh BACKUP.dump}"

test -f "$backup"
test -f "$backup.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "$backup.sha256"
else
  shasum -a 256 -c "$backup.sha256"
fi

if [ "${MBOX_CONFIRM_RESTORE:-}" != "RESTORE" ]; then
  echo "Refusing restore. Set MBOX_CONFIRM_RESTORE=RESTORE." >&2
  exit 2
fi

pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --exit-on-error "$backup"
