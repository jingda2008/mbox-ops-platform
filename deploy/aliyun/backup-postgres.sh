#!/usr/bin/env bash
set -Eeuo pipefail
unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD PGSERVICE

mode=${1:-backup}
install_root=${MBOX_INSTALL_ROOT:-/opt/mbox}

load_maintenance_services() {
  local maintenance_env=${MBOX_DATABASE_MAINTENANCE_ENV:-${install_root}/secrets/database-maintenance.env}
  test -f "${maintenance_env}"
  test "$(stat -c '%u:%a' "${maintenance_env}")" = 0:600
  for key in APPLICATION_DATABASE_SERVICE BACKUP_DATABASE_SERVICE ADMIN_DATABASE_SERVICE \
    PGSERVICEFILE PGPASSFILE; do
    test "$(awk -F= -v expected="${key}" '$1 == expected { count += 1 } END { print count + 0 }' \
      "${maintenance_env}")" = 1
  done
  test -z "$(awk -F= '
    /^[[:space:]]*($|#)/ { next }
    $1 != "APPLICATION_DATABASE_SERVICE" && $1 != "BACKUP_DATABASE_SERVICE" &&
      $1 != "ADMIN_DATABASE_SERVICE" && $1 != "PGSERVICEFILE" && $1 != "PGPASSFILE" { print NR }
  ' "${maintenance_env}")"
  APPLICATION_DATABASE_SERVICE=$(sed -n 's/^APPLICATION_DATABASE_SERVICE=//p' "${maintenance_env}")
  BACKUP_DATABASE_SERVICE=$(sed -n 's/^BACKUP_DATABASE_SERVICE=//p' "${maintenance_env}")
  PGSERVICEFILE=$(sed -n 's/^PGSERVICEFILE=//p' "${maintenance_env}")
  PGPASSFILE=$(sed -n 's/^PGPASSFILE=//p' "${maintenance_env}")
  for service in "${APPLICATION_DATABASE_SERVICE}" "${BACKUP_DATABASE_SERVICE}"; do
    [[ "${service}" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]]
  done
  for secret_file in "${PGSERVICEFILE}" "${PGPASSFILE}"; do
    case "${secret_file}" in "${install_root}"/secrets/*) ;; *) exit 1 ;; esac
    test -f "${secret_file}"
    test "$(stat -c '%u:%a' "${secret_file}")" = 0:600
  done
  ! grep -Eiq '^[[:space:]]*(password|passfile)[[:space:]]*=' "${PGSERVICEFILE}"
  export PGSERVICEFILE PGPASSFILE
}

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

create_backup() {
  : "${BACKUP_DIR:?BACKUP_DIR is required}"
  local database_connection target timestamp
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
  # The BYPASSRLS backup login is forced read-only for this snapshot.
  PGOPTIONS='-c default_transaction_read_only=on' \
    pg_dump --dbname="${database_connection}" --format=custom --compress=9 --file="${target}"
  sha256sum "${target}" > "${target}.sha256"
  printf '%s\n' "${target}"
}

if [ "${mode}" = backup ]; then
  create_backup
  exit 0
fi

test "${mode}" = prepare-relay
release_dir=${2:?release directory is required for prepare-relay}
release_sha=${3:?release SHA is required for prepare-relay}
active_container=${MBOX_ACTIVE_CONTAINER:-mbox-app}
case "${release_dir}" in "${install_root}"/releases/*) ;; *) exit 64 ;; esac
[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]]
test "$(jq -er '.releaseSha' "${release_dir}/release-manifest.json")" = "${release_sha}"
docker inspect "${active_container}" >/dev/null

load_maintenance_services
runtime_database_identity=$(docker exec -i "${active_container}" node <<'NODE'
const {Client}=require('pg')
const client=new Client({connectionString:process.env.DATABASE_URL})
client.connect()
  .then(()=>client.query(`SELECT current_database() || '|' ||
    COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port') AS identity`))
  .then((result)=>{process.stdout.write(result.rows[0].identity);return client.end()})
  .catch((error)=>{console.error(error.message);process.exit(1)})
NODE
)
application_database_identity=$(psql -XAt --dbname="service=${APPLICATION_DATABASE_SERVICE}" \
  --command="SELECT current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port')")
backup_database_identity=$(PGOPTIONS='-c default_transaction_read_only=on' \
  psql -XAt --dbname="service=${BACKUP_DATABASE_SERVICE}" \
  --command="SELECT current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port')")
test -n "${runtime_database_identity}"
test "${application_database_identity}" = "${runtime_database_identity}"
test "${backup_database_identity}" = "${application_database_identity}"

DATABASE_SERVICE=${BACKUP_DATABASE_SERVICE}
BACKUP_DIR=${install_root}/backups
export DATABASE_SERVICE BACKUP_DIR
backup_path=$(create_backup)
backup_name=$(basename "${backup_path}")
[[ "${backup_name}" =~ ^mbox-[A-Za-z0-9._-]+\.dump$ ]]
test -f "${backup_path}"
test -f "${backup_path}.sha256"

relay_stage=${release_dir}/relay-backup-ready
case "${relay_stage}" in "${release_dir}"/*) ;; *) exit 64 ;; esac
rm -rf "${relay_stage}"
rm -f "${release_dir}/preverified-backup-upload.json"
install -d -m 0700 "${relay_stage}"
ln "${backup_path}" "${relay_stage}/${backup_name}" 2>/dev/null \
  || cp "${backup_path}" "${relay_stage}/${backup_name}"
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
generated_epoch=$(date -u +%s)
object_prefix=mbox/backups/$(date -u +%Y-%m-%d)/${release_sha}
backup_sha=$(sha256sum "${relay_stage}/${backup_name}" | awk '{print $1}')
jq -n \
  --arg generatedAt "${generated_at}" \
  --argjson generatedAtEpoch "${generated_epoch}" \
  --arg releaseSha "${release_sha}" \
  --arg databaseIdentity "${application_database_identity}" \
  --arg backupName "${backup_name}" \
  --arg backupSha256 "${backup_sha}" \
  --arg objectPrefix "${object_prefix}" \
  '{schemaVersion:1,generatedAt:$generatedAt,generatedAtEpoch:$generatedAtEpoch,
    releaseSha:$releaseSha,databaseIdentity:$databaseIdentity,backupName:$backupName,
    backupSha256:$backupSha256,objectPrefix:$objectPrefix}' \
  > "${relay_stage}/backup-preparation.json"
(
  cd "${relay_stage}"
  sha256sum "${backup_name}" > "${backup_name}.sha256"
  sha256sum "${backup_name}" "${backup_name}.sha256" backup-preparation.json > SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
chmod 0600 "${relay_stage}"/*
printf '%s\n' "${relay_stage}"
