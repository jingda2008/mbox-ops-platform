#!/usr/bin/env bash
set -Eeuo pipefail
unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD PGSERVICE

: "${BACKUP_DIR:?BACKUP_DIR is required}"

connection_reference() {
  : "${DATABASE_SERVICE:?DATABASE_SERVICE is required}"
  [[ "${DATABASE_SERVICE}" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]]
  : "${PGSERVICEFILE:?PGSERVICEFILE is required with DATABASE_SERVICE}"
  : "${PGPASSFILE:?PGPASSFILE is required with DATABASE_SERVICE}"
  test -r "${PGSERVICEFILE}"
  test -r "${PGPASSFILE}"
  ! grep -Eiq '^[[:space:]]*(password|passfile)[[:space:]]*=' "${PGSERVICEFILE}"
  printf 'service=%s' "${DATABASE_SERVICE}"
}

database_connection=$(connection_reference)

test "$(PGOPTIONS='-c default_transaction_read_only=on' psql -XAt --dbname="${database_connection}" <<'SQL'
SELECT CASE WHEN NOT role.rolsuper AND role.rolbypassrls AND (
    (pg_has_role(current_user,'pg_monitor','member')
      AND pg_has_role(current_user,'pg_read_all_data','member'))
    OR EXISTS (
      SELECT 1 FROM pg_roles AS provider_role
      WHERE provider_role.rolname='pg_rds_superuser'
        AND pg_has_role(role.oid,provider_role.oid,'member')
    )
  )
  THEN 'authorized' ELSE 'denied' END
FROM pg_roles AS role
WHERE role.rolname = current_user;
SQL
)" = authorized

install -d -m 0700 "${BACKUP_DIR}"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target=$(mktemp "${BACKUP_DIR}/mbox-${timestamp}-XXXXXX.dump")
umask 077

# Ownership, ACLs and SECURITY DEFINER owners are part of the recovery fact set.
# The dedicated BYPASSRLS backup login is forced read-only for this snapshot.
PGOPTIONS='-c default_transaction_read_only=on' \
  pg_dump --dbname="${database_connection}" --format=custom --compress=9 --file="${target}"
sha256sum "${target}" > "${target}.sha256"
printf '%s\n' "${target}"
