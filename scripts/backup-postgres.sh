#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=./backups}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/mbox-$timestamp.dump"

umask 077
pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --file="$target"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$target" > "$target.sha256"
else
  shasum -a 256 "$target" > "$target.sha256"
fi
printf '%s\n' "$target"
