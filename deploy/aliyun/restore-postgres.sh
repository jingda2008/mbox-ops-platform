#!/usr/bin/env bash
set -Eeuo pipefail
unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD PGSERVICE

mode=${1:?usage: restore-postgres.sh capture EVIDENCE.json | restore BACKUP.dump}

connection_reference() {
  local service=$1 database=${2:-}
  [[ "${service}" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]]
  : "${PGSERVICEFILE:?PGSERVICEFILE is required with a database service}"
  : "${PGPASSFILE:?PGPASSFILE is required with a database service}"
  test -r "${PGSERVICEFILE}"
  test -r "${PGPASSFILE}"
  ! grep -Eiq '^[[:space:]]*(password|passfile)[[:space:]]*=' "${PGSERVICEFILE}"
  if [ -n "${database}" ]; then
    [[ "${database}" =~ ^[a-zA-Z0-9_]{1,63}$ ]]
    printf 'service=%s dbname=%s' "${service}" "${database}"
  else
    printf 'service=%s' "${service}"
  fi
}

write_database_evidence() {
  local source_url=$1 output=$2 temporary
  temporary=$(mktemp "${output}.XXXXXX")
  PGOPTIONS='-c default_transaction_read_only=on' psql -XAt --dbname="${source_url}" > "${temporary}" <<'SQL'
WITH object_owners AS (
  SELECT 'schema'::text AS object_kind, quote_ident(namespace.nspname) AS object_identity,
    pg_get_userbyid(namespace.nspowner) AS owner_name
  FROM pg_namespace AS namespace WHERE namespace.nspname = 'mbox'
  UNION ALL
  SELECT CASE relation.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
      WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
      WHEN 'S' THEN 'sequence' ELSE relation.relkind::text END,
    quote_ident(namespace.nspname) || '.' || quote_ident(relation.relname),
    pg_get_userbyid(relation.relowner)
  FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname='mbox' AND relation.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT CASE routine.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
    quote_ident(namespace.nspname)||'.'||quote_ident(routine.proname)||
      '('||pg_get_function_identity_arguments(routine.oid)||')', pg_get_userbyid(routine.proowner)
  FROM pg_proc AS routine JOIN pg_namespace AS namespace ON namespace.oid=routine.pronamespace
  WHERE namespace.nspname='mbox'
  UNION ALL
  SELECT CASE type.typtype WHEN 'd' THEN 'domain' ELSE 'type' END,
    quote_ident(namespace.nspname)||'.'||quote_ident(type.typname),pg_get_userbyid(type.typowner)
  FROM pg_type AS type JOIN pg_namespace AS namespace ON namespace.oid=type.typnamespace
  WHERE namespace.nspname='mbox'
  UNION ALL
  SELECT 'extension',quote_ident(extension.extname),pg_get_userbyid(extension.extowner)
  FROM pg_extension AS extension
), explicit_acls AS (
  SELECT 'schema'::text AS object_kind, quote_ident(namespace.nspname) AS object_identity,
    pg_get_userbyid(acl.grantor) AS grantor,
    CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type,acl.is_grantable
  FROM pg_namespace AS namespace
  CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl,acldefault('n',namespace.nspowner))) AS acl
  WHERE namespace.nspname='mbox'
  UNION ALL
  SELECT 'relation',quote_ident(namespace.nspname)||'.'||quote_ident(relation.relname),
    pg_get_userbyid(acl.grantor),
    CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
    acl.privilege_type,acl.is_grantable
  FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,
    acldefault(CASE relation.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END,
      relation.relowner))) AS acl
  WHERE namespace.nspname='mbox' AND relation.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT 'routine',quote_ident(namespace.nspname)||'.'||quote_ident(routine.proname)||
      '('||pg_get_function_identity_arguments(routine.oid)||')',pg_get_userbyid(acl.grantor),
    CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
    acl.privilege_type,acl.is_grantable
  FROM pg_proc AS routine JOIN pg_namespace AS namespace ON namespace.oid=routine.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) AS acl
  WHERE namespace.nspname='mbox'
), tenant_counts AS (
  SELECT 'tenants'::text AS table_name,id AS tenant_id,NULL::uuid AS store_id,1::bigint AS row_count
    FROM mbox.tenants
  UNION ALL SELECT 'stores',tenant_id,id,1 FROM mbox.stores
  UNION ALL SELECT 'customers',tenant_id,store_id,count(*) FROM mbox.customers GROUP BY tenant_id,store_id
  UNION ALL SELECT 'table_sessions',tenant_id,store_id,count(*) FROM mbox.table_sessions GROUP BY tenant_id,store_id
  UNION ALL SELECT 'orders',tenant_id,store_id,count(*) FROM mbox.orders GROUP BY tenant_id,store_id
  UNION ALL SELECT 'payments',tenant_id,store_id,count(*) FROM mbox.payments GROUP BY tenant_id,store_id
  UNION ALL SELECT 'refunds',tenant_id,store_id,count(*) FROM mbox.refunds GROUP BY tenant_id,store_id
  UNION ALL SELECT 'table_session_customer_participations',tenant_id,store_id,count(*)
    FROM mbox.table_session_customer_participations GROUP BY tenant_id,store_id
)
SELECT jsonb_build_object(
  'clusterSystemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'database',(SELECT jsonb_build_object('name',current_database(),
    'owner',pg_get_userbyid(database.datdba),'encoding',pg_encoding_to_char(database.encoding),
    'collate',database.datcollate,'ctype',database.datctype,'connectionLimit',database.datconnlimit,
    'allowConnections',database.datallowconn,'localeProvider',database.datlocprovider,
    'icuLocale',database.daticulocale,'collationVersion',database.datcollversion,
    'acl',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'grantor',pg_get_userbyid(acl.grantor),
      'grantee',CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
      'privilege',acl.privilege_type,'grantable',acl.is_grantable)
      ORDER BY pg_get_userbyid(acl.grantor),acl.grantee,acl.privilege_type,acl.is_grantable),'[]'::jsonb)
      FROM aclexplode(COALESCE(database.datacl,acldefault('d',database.datdba))) AS acl))
    FROM pg_database AS database WHERE database.datname=current_database()),
  'schemaVersion',(SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true),
  'migrations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version,
    'filename',filename,'checksum',checksum::text) ORDER BY version),'[]'::jsonb)
    FROM mbox.normalized_schema_migrations),
  'objectOwners',(SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',object_kind,
    'identity',object_identity,'owner',owner_name) ORDER BY object_kind,object_identity),'[]'::jsonb)
    FROM object_owners),
  'securityDefiners',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity',quote_ident(namespace.nspname)||'.'||quote_ident(routine.proname)||
      '('||pg_get_function_identity_arguments(routine.oid)||')','owner',pg_get_userbyid(routine.proowner),
    'config',COALESCE(to_jsonb(routine.proconfig),'[]'::jsonb))
    ORDER BY routine.proname,pg_get_function_identity_arguments(routine.oid)),'[]'::jsonb)
    FROM pg_proc AS routine JOIN pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname='mbox' AND routine.prosecdef),
  'acls',(SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',object_kind,
    'identity',object_identity,'grantor',grantor,'grantee',grantee,'privilege',privilege_type,
    'grantable',is_grantable) ORDER BY object_kind,object_identity,grantor,grantee,
      privilege_type,is_grantable),'[]'::jsonb) FROM explicit_acls),
  'rowSecurity',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'relation',quote_ident(namespace.nspname)||'.'||quote_ident(relation.relname),
    'enabled',relation.relrowsecurity,'forced',relation.relforcerowsecurity)
    ORDER BY relation.relname),'[]'::jsonb)
    FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='mbox' AND relation.relkind IN ('r','p')),
  'policies',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'relation',quote_ident(namespace.nspname)||'.'||quote_ident(relation.relname),
    'name',policy.polname,'permissive',policy.polpermissive,'command',policy.polcmd,
    'roles',(SELECT COALESCE(jsonb_agg(pg_get_userbyid(role_id) ORDER BY pg_get_userbyid(role_id)),
      '[]'::jsonb) FROM unnest(policy.polroles) AS role_id),
    'using',pg_get_expr(policy.polqual,policy.polrelid),
    'check',pg_get_expr(policy.polwithcheck,policy.polrelid))
    ORDER BY relation.relname,policy.polname),'[]'::jsonb)
    FROM pg_policy AS policy JOIN pg_class AS relation ON relation.oid=policy.polrelid
    JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='mbox'),
  'defaultAcls',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'owner',pg_get_userbyid(default_acl.defaclrole),
    'namespace',COALESCE(namespace.nspname,'*'),'kind',default_acl.defaclobjtype,
    'acl',default_acl.defaclacl::text) ORDER BY pg_get_userbyid(default_acl.defaclrole),
      COALESCE(namespace.nspname,'*'),default_acl.defaclobjtype),'[]'::jsonb)
    FROM pg_default_acl AS default_acl
    LEFT JOIN pg_namespace AS namespace ON namespace.oid=default_acl.defaclnamespace
    WHERE default_acl.defaclnamespace=0 OR namespace.nspname='mbox'),
  'databaseSettings',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role',CASE setting.setrole WHEN 0 THEN '*' ELSE pg_get_userbyid(setting.setrole) END,
    'settings',to_jsonb(setting.setconfig)) ORDER BY setting.setrole),'[]'::jsonb)
    FROM pg_db_role_setting AS setting
    WHERE setting.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())),
  'tenantCounts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('table',table_name,
    'tenantId',tenant_id,'storeId',store_id,'count',row_count)
    ORDER BY table_name,tenant_id,store_id),'[]'::jsonb) FROM tenant_counts)
)::text;
SQL
  jq -eS . "${temporary}" > "${output}"
  chmod 0600 "${output}"
  rm -f "${temporary}"
}

validate_manifest_and_evidence() {
  local evidence=$1 manifest=$2 expected_schema=$3 expected_migrations actual_migrations
  test -f "${evidence}"
  test -f "${manifest}"
  test "$(jq -er '.schemaVersion' "${evidence}")" = "${expected_schema}"
  test "$(jq -er '.migration.count' "${manifest}")" = "$((10#${expected_schema}))"
  expected_migrations=$(jq -cS '[.migration.files[] | {
    version:(.filename|capture("^(?<version>[0-9]{3})_").version),
    filename:.filename,checksum:.sha256}]' "${manifest}")
  actual_migrations=$(jq -cS '.migrations' "${evidence}")
  test "${actual_migrations}" = "${expected_migrations}"
}

if [ "${mode}" = capture ]; then
  : "${MBOX_EXPECTED_RESTORE_DATABASE:?MBOX_EXPECTED_RESTORE_DATABASE is required}"
  : "${DATABASE_SERVICE:?DATABASE_SERVICE is required}"
  database_connection=$(connection_reference "${DATABASE_SERVICE}")
  evidence=${2:?evidence output is required}
  test "$(psql -XAt --dbname="${database_connection}" --command='SELECT current_database()')" = \
    "${MBOX_EXPECTED_RESTORE_DATABASE}"
  test "$(psql -XAt --dbname="${database_connection}" <<'SQL'
SELECT CASE WHEN NOT role.rolsuper AND role.rolbypassrls
    AND pg_has_role(current_user,'pg_monitor','member')
    AND pg_has_role(current_user,'pg_read_all_data','member')
  THEN 'authorized' ELSE 'denied' END
FROM pg_roles AS role WHERE role.rolname=current_user;
SQL
)" = authorized
  write_database_evidence "${database_connection}" "${evidence}"
  exit 0
fi

test "${mode}" = restore
: "${MBOX_EXPECTED_RESTORE_DATABASE:?MBOX_EXPECTED_RESTORE_DATABASE is required}"
: "${MBOX_EXPECTED_RESTORE_SCHEMA_VERSION:?MBOX_EXPECTED_RESTORE_SCHEMA_VERSION is required}"
: "${MBOX_EXPECTED_RESTORE_MANIFEST:?MBOX_EXPECTED_RESTORE_MANIFEST is required}"
: "${MBOX_EXPECTED_RESTORE_EVIDENCE:?MBOX_EXPECTED_RESTORE_EVIDENCE is required}"
: "${MBOX_RESTORE_REPORT:?MBOX_RESTORE_REPORT is required}"
test "${MBOX_CONFIRM_RESTORE:-}" = RESTORE
: "${DATABASE_SERVICE:?DATABASE_SERVICE is required}"
: "${ADMIN_DATABASE_SERVICE:?ADMIN_DATABASE_SERVICE is required}"
database_connection=$(connection_reference "${DATABASE_SERVICE}")
admin_connection=$(connection_reference "${ADMIN_DATABASE_SERVICE}")
backup=${2:?backup is required}
test -f "${backup}"
test -f "${backup}.sha256"
sha256sum --check "${backup}.sha256" >/dev/null
[[ "${MBOX_EXPECTED_RESTORE_DATABASE}" =~ ^[a-zA-Z0-9_]{1,40}$ ]]
[[ "${MBOX_EXPECTED_RESTORE_SCHEMA_VERSION}" =~ ^[0-9]{3}$ ]]
validate_manifest_and_evidence "${MBOX_EXPECTED_RESTORE_EVIDENCE}" \
  "${MBOX_EXPECTED_RESTORE_MANIFEST}" "${MBOX_EXPECTED_RESTORE_SCHEMA_VERSION}"
test "$(jq -er '.database.name' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")" = \
  "${MBOX_EXPECTED_RESTORE_DATABASE}"
test "$(jq -er '.database.localeProvider' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")" = c
test "$(psql -XAt --dbname="${database_connection}" --command='SELECT current_database()')" = \
  "${MBOX_EXPECTED_RESTORE_DATABASE}"

target_cluster_identity=$(psql -XAt --dbname="${database_connection}" <<'SQL'
SELECT COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port') || '|' ||
  pg_postmaster_start_time()::text || '|' || current_setting('server_version_num');
SQL
)

admin_database=$(psql -XAt --dbname="${admin_connection}" --command='SELECT current_database()')
test -n "${admin_database}"
test "${admin_database}" != "${MBOX_EXPECTED_RESTORE_DATABASE}"
test "$(psql -XAt --dbname="${admin_connection}" <<'SQL'
SELECT CASE WHEN role.rolsuper THEN 'authorized' ELSE 'denied' END
FROM pg_roles AS role WHERE role.rolname=current_user;
SQL
)" = authorized
admin_cluster_identity=$(psql -XAt --dbname="${admin_connection}" <<'SQL'
SELECT COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port') || '|' ||
  pg_postmaster_start_time()::text || '|' || current_setting('server_version_num');
SQL
)
test "${admin_cluster_identity}" = "${target_cluster_identity}"
test "$(psql -XAt --dbname="${admin_connection}" \
  --command='SELECT system_identifier::text FROM pg_control_system()')" = \
  "$(jq -er '.clusterSystemIdentifier' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")"

token=$(sha256sum "${backup}" | awk '{print substr($1,1,10)}')_$$
staging_database=mbox_restore_${token}
preserved_database=mbox_pre096_${token}
failed_database=mbox_failed_restore_${token}
for name in "${staging_database}" "${preserved_database}" "${failed_database}"; do
  [[ "${name}" =~ ^[a-z0-9_]{1,63}$ ]]
done
staging_connection=$(connection_reference "${ADMIN_DATABASE_SERVICE}" "${staging_database}")
target_admin_connection=$(connection_reference "${ADMIN_DATABASE_SERVICE}" "${MBOX_EXPECTED_RESTORE_DATABASE}")
readarray -t database_facts < <(jq -er '.database | [.owner,.encoding,.collate,.ctype][]' \
  "${MBOX_EXPECTED_RESTORE_EVIDENCE}")
test "${#database_facts[@]}" = 4
database_owner=${database_facts[0]}
database_encoding=${database_facts[1]}
database_collate=${database_facts[2]}
database_ctype=${database_facts[3]}
database_connection_limit=$(jq -er '.database.connectionLimit' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")
database_allow_connections=$(jq -er '.database.allowConnections' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")
test -n "${database_owner}"
[[ "${database_connection_limit}" =~ ^-?[0-9]+$ ]]
test "${database_allow_connections}" = true
test "$(psql -XAt --dbname="${admin_connection}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" <<'SQL'
SELECT count(*) FROM pg_stat_activity
WHERE datname=:'target_database' AND backend_type='client backend';
SQL
)" = 0
test "$(psql -XAt --dbname="${admin_connection}" \
  --set=staging_database="${staging_database}" --set=preserved_database="${preserved_database}" \
  --set=failed_database="${failed_database}" <<'SQL'
SELECT count(*) FROM pg_database
WHERE datname IN (:'staging_database',:'preserved_database',:'failed_database');
SQL
)" = 0

staging_created=0
restore_original_database_name() {
  local target_exists preserved_exists staging_exists failed_exists
  target_exists=$(psql -XAt --dbname="${admin_connection}" \
    --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname=:'target_database';
SQL
)
  preserved_exists=$(psql -XAt --dbname="${admin_connection}" \
    --set=preserved_database="${preserved_database}" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname=:'preserved_database';
SQL
)
  if [ "${preserved_exists}" = 1 ]; then
    if [ "${target_exists}" = 1 ]; then
      psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
        --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" \
        --set=failed_database="${failed_database}" >/dev/null <<'SQL'
ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname=:'target_database' AND backend_type='client backend';
ALTER DATABASE :"target_database" RENAME TO :"failed_database";
SQL
    fi
    psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
      --set=preserved_database="${preserved_database}" \
      --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" >/dev/null <<'SQL'
ALTER DATABASE :"preserved_database" RENAME TO :"target_database";
ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS true;
SQL
    staging_exists=$(psql -XAt --dbname="${admin_connection}" \
      --set=staging_database="${staging_database}" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname=:'staging_database';
SQL
)
    staging_created=${staging_exists}
    failed_exists=$(psql -XAt --dbname="${admin_connection}" \
      --set=failed_database="${failed_database}" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname=:'failed_database';
SQL
)
    if [ "${failed_exists}" = 1 ]; then
      psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
        --set=failed_database="${failed_database}" >/dev/null <<'SQL'
DROP DATABASE :"failed_database";
SQL
    fi
  elif [ "${target_exists}" = 1 ]; then
    psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
      --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" >/dev/null <<'SQL'
ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS true;
SQL
  fi
}

cleanup_restore() {
  local exit_code=${1:-$?}
  trap - ERR INT TERM
  restore_original_database_name || true
  psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
    --set=staging_database="${staging_database}" >/dev/null <<'SQL' || true
DROP DATABASE IF EXISTS :"staging_database";
SQL
  exit "${exit_code}"
}
trap 'cleanup_restore $?' ERR
trap 'cleanup_restore 130' INT
trap 'cleanup_restore 143' TERM

psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=staging_database="${staging_database}" --set=database_owner="${database_owner}" \
  --set=database_encoding="${database_encoding}" --set=database_collate="${database_collate}" \
  --set=database_ctype="${database_ctype}" \
  --set=database_connection_limit="${database_connection_limit}" >/dev/null <<'SQL'
CREATE DATABASE :"staging_database" WITH OWNER=:"database_owner" TEMPLATE=template0
  ENCODING=:'database_encoding' LC_COLLATE=:'database_collate' LC_CTYPE=:'database_ctype'
  CONNECTION LIMIT :database_connection_limit;
SQL
staging_created=1
pg_restore --dbname="${staging_connection}" --exit-on-error --single-transaction "${backup}"
psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=staging_database="${staging_database}" --set=database_owner="${database_owner}" \
  >/dev/null <<'SQL'
REVOKE ALL PRIVILEGES ON DATABASE :"staging_database" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"staging_database" FROM :"database_owner";
SQL
while IFS=$'\t' read -r acl_grantor acl_grantee acl_privilege acl_grantable; do
  case "${acl_privilege}" in CONNECT|CREATE|TEMPORARY) ;; *) exit 1 ;; esac
  case "${acl_grantable}" in true|false) ;; *) exit 1 ;; esac
  psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
    --set=staging_database="${staging_database}" --set=acl_grantor="${acl_grantor}" \
    --set=acl_grantee="${acl_grantee}" --set=acl_privilege="${acl_privilege}" \
    --set=acl_grantable="${acl_grantable}" >/dev/null <<'SQL'
SET ROLE :"acl_grantor";
SELECT format('GRANT %s ON DATABASE %I TO %s%s', :'acl_privilege', :'staging_database',
  CASE WHEN :'acl_grantee'='PUBLIC' THEN 'PUBLIC' ELSE format('%I',:'acl_grantee') END,
  CASE WHEN :'acl_grantable'='true' THEN ' WITH GRANT OPTION' ELSE '' END) \gexec
RESET ROLE;
SQL
done < <(jq -er '.database.acl[] | [.grantor,.grantee,.privilege,(.grantable|tostring)] | @tsv' \
  "${MBOX_EXPECTED_RESTORE_EVIDENCE}")
while IFS= read -r encoded_setting; do
  setting_json=$(printf '%s' "${encoded_setting}" | base64 -d)
  setting_role=$(jq -er '.role' <<<"${setting_json}")
  while IFS= read -r database_setting; do
    setting_key=${database_setting%%=*}
    setting_value=${database_setting#*=}
    [[ "${setting_key}" =~ ^[a-zA-Z0-9_.]+$ ]]
    if [ "${setting_role}" = '*' ]; then
      psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
        --set=staging_database="${staging_database}" --set=setting_key="${setting_key}" \
        --set=setting_value="${setting_value}" >/dev/null <<'SQL'
SELECT format('ALTER DATABASE %I SET %I TO %L',:'staging_database',:'setting_key',:'setting_value') \gexec
SQL
    else
      psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
        --set=staging_database="${staging_database}" --set=setting_role="${setting_role}" \
        --set=setting_key="${setting_key}" --set=setting_value="${setting_value}" >/dev/null <<'SQL'
SELECT format('ALTER ROLE %I IN DATABASE %I SET %I TO %L',:'setting_role',:'staging_database',
  :'setting_key',:'setting_value') \gexec
SQL
    fi
  done < <(jq -er '.settings[]' <<<"${setting_json}")
done < <(jq -r '.databaseSettings[] | @base64' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")
staging_evidence=$(mktemp)
write_database_evidence "${staging_connection}" "${staging_evidence}"
validate_manifest_and_evidence "${staging_evidence}" "${MBOX_EXPECTED_RESTORE_MANIFEST}" \
  "${MBOX_EXPECTED_RESTORE_SCHEMA_VERSION}"
test "$(jq -cS 'del(.database.name)' "${staging_evidence}")" = \
  "$(jq -cS 'del(.database.name)' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")"
test "$(psql -XAt --dbname="${staging_connection}" \
  --command="SELECT to_regclass('mbox.table_customer_movement_events') IS NULL")" = t
rm -f "${staging_evidence}"

psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" \
  --set=staging_database="${staging_database}" >/dev/null <<'SQL'
ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS false;
ALTER DATABASE :"staging_database" WITH ALLOW_CONNECTIONS false;
SQL
test "$(psql -XAt --dbname="${admin_connection}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" \
  --set=staging_database="${staging_database}" <<'SQL'
SELECT count(*) FROM pg_stat_activity
WHERE datname IN (:'target_database',:'staging_database') AND backend_type='client backend';
SQL
)" = 0
psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" \
  --set=preserved_database="${preserved_database}" >/dev/null <<'SQL'
ALTER DATABASE :"target_database" RENAME TO :"preserved_database";
SQL
psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=staging_database="${staging_database}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" >/dev/null <<'SQL'
ALTER DATABASE :"staging_database" RENAME TO :"target_database";
SQL
staging_created=0
psql -X --set=ON_ERROR_STOP=1 --dbname="${admin_connection}" \
  --set=target_database="${MBOX_EXPECTED_RESTORE_DATABASE}" >/dev/null <<'SQL'
ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS true;
SQL

final_evidence=$(mktemp)
write_database_evidence "${target_admin_connection}" "${final_evidence}"
test "$(jq -cS 'del(.database.name)' "${final_evidence}")" = \
  "$(jq -cS 'del(.database.name)' "${MBOX_EXPECTED_RESTORE_EVIDENCE}")"
rm -f "${final_evidence}"
jq -n --arg restoredDatabase "${MBOX_EXPECTED_RESTORE_DATABASE}" \
  --arg preservedDatabase "${preserved_database}" \
  --arg schemaVersion "${MBOX_EXPECTED_RESTORE_SCHEMA_VERSION}" \
  --arg backupSha256 "$(sha256sum "${backup}" | awk '{print $1}')" \
  --arg evidenceSha256 "$(sha256sum "${MBOX_EXPECTED_RESTORE_EVIDENCE}" | awk '{print $1}')" \
  '{schemaVersion:1,status:"restored",restoredDatabase:$restoredDatabase,
    preservedDatabase:$preservedDatabase,restoredSchemaVersion:$schemaVersion,
    backupSha256:$backupSha256,evidenceSha256:$evidenceSha256,
    originalDatabaseRetained:true}' > "${MBOX_RESTORE_REPORT}"
chmod 0600 "${MBOX_RESTORE_REPORT}"
trap - ERR INT TERM
