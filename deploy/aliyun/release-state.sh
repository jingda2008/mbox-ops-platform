#!/usr/bin/env bash
set -euo pipefail

release_lock_acquire() {
  local install_root=$1 expected_uid=$2 lock_dir lock_file
  lock_dir=${install_root}/locks
  lock_file=${lock_dir}/release.lock
  install -d -m 0700 "${lock_dir}"
  test "$(stat -c '%u:%a' "${lock_dir}")" = "${expected_uid}:700"
  exec 8>"${lock_file}"
  chmod 0600 "${lock_file}"
  if ! flock -n 8; then
    echo "another release or database-maintenance operation is active" >&2
    return 75
  fi
}

release_state_init() {
  local state_file=$1 release_sha=$2 image_digest=$3
  test ! -e "${state_file}"
  jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg releaseSha "${release_sha}" \
    --arg imageDigest "${image_digest}" \
    '{schemaVersion:1,releaseSha:$releaseSha,imageDigest:$imageDigest,current:"frozen",history:[{state:"frozen",at:$timestamp}]}' \
    > "${state_file}"
  chmod 0600 "${state_file}"
}

release_state_require() {
  local state_file=$1 expected=$2
  test "$(jq -er '.current' "${state_file}")" = "${expected}" || {
    printf 'release state mismatch: expected %s\n' "${expected}" >&2
    return 1
  }
}

release_state_transition() {
  local state_file=$1 expected=$2 next=$3
  release_state_require "${state_file}" "${expected}" || return 1
  release_state_transition_allowed "${expected}" "${next}" || return 1
  local temporary
  temporary=$(mktemp "${state_file}.XXXXXX")
  jq \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg next "${next}" \
    '.current=$next | .history += [{state:$next,at:$timestamp}]' \
    "${state_file}" > "${temporary}"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${state_file}"
}

release_state_transition_allowed() {
  case "$1:$2" in
    frozen:artifact_verified|\
    artifact_verified:config_preflight_passed|\
    config_preflight_passed:external_preflight_passed|\
    external_preflight_passed:migration_compatible|\
    migration_compatible:writer_drained|\
    migration_compatible:rolled_back|\
    writer_drained:post_drain_backup_verified|\
    post_drain_backup_verified:migrated|\
    migration_compatible:backup_verified|\
    backup_verified:migrated|\
    migrated:provisioned|\
    provisioned:candidate_healthy|\
    candidate_healthy:candidate_deep_verified|\
    candidate_deep_verified:cutover_started|\
    cutover_started:cutover_verified|\
    cutover_verified:evidence_archived|\
    evidence_archived:completed|\
    writer_drained:rolled_back|\
    post_drain_backup_verified:rolled_back|\
    post_drain_backup_verified:database_restored|\
    migrated:database_restored|\
    provisioned:database_restored|\
    candidate_healthy:database_restored|\
    candidate_deep_verified:database_restored|\
    cutover_started:database_restored|\
    database_restored:rolled_back|\
    completed:rolled_back|\
    provisioned:rolled_back|\
    candidate_healthy:rolled_back|\
    candidate_deep_verified:rolled_back|\
    cutover_started:rolled_back|\
    cutover_verified:rolled_back|\
    evidence_archived:rolled_back) return 0 ;;
    *) printf 'invalid release transition: %s -> %s\n' "$1" "$2" >&2; return 1 ;;
  esac
}

# New print inheritance stores the cashier-payment cut-off separately. Before
# starting pre-259 workers, drain every candidate writer, then inspect the live
# scoped policy. Never convert route-specific copies into a guessed override.
release_assert_print_rollback_safe() {
  local release_dir=$1 image_digest=$2 target_schema=$3
  shift 3
  [[ "${target_schema}" =~ ^[0-9]+$ ]] || return 2
  [ "${target_schema}" -lt 259 ] || return 0
  local source_schema writer evidence temporary
  source_schema=$(jq -er '.migration.count' "${release_dir}/release-manifest.json") || return 2
  [[ "${source_schema}" =~ ^[0-9]+$ ]] || return 2
  [ "${source_schema}" -ge 259 ] || return 0
  evidence=${release_dir}/print-policy-rollback-guard.json
  jq -n --arg targetSchema "${target_schema}" \
    '{status:"blocked",reason:"writer_drain_or_query_incomplete",targetSchema:($targetSchema|tonumber),action:"keep_previous_workers_stopped"}' > "${evidence}" || return 2
  chmod 0600 "${evidence}"
  for writer in "$@"; do
    [ -n "${writer}" ] || continue
    if docker inspect "${writer}" >/dev/null 2>&1; then
      docker update --restart=no "${writer}" >/dev/null || return 2
      docker stop -t 20 "${writer}" >/dev/null || return 2
      test "$(docker inspect "${writer}" --format '{{.State.Running}}')" = false || return 2
    fi
  done
  temporary=$(mktemp "${release_dir}/.print-rollback-guard.XXXXXX") || return 2
  # Only the exact new image is used, and only as a one-shot read-only checker.
  # Its runtime identity verifier rejects admin logins, role switching and RLS
  # bypass. Scope must match an existing store before an empty result is trusted.
  if docker run --rm -i --network mbox-net --env-file "${release_dir}/app.env" \
    -e MBOX_START_WORKERS=false --entrypoint node "${image_digest}" > "${temporary}" <<'NODE'
const {Client}=require('pg')
;(async()=>{
  const tenantId=process.env.MBOX_TENANT_ID,storeId=process.env.MBOX_STORE_ID
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if(!uuid.test(tenantId??'')||!uuid.test(storeId??''))throw new Error('scope_invalid')
  const {assertRuntimeDatabaseConnection,runtimeDatabaseLogin}=await import('/app/dist-normalized/server/normalized/runtime-database-identity.js')
  const client=new Client({connectionString:process.env.DATABASE_URL})
  await client.connect()
  try{
    await assertRuntimeDatabaseConnection(client,runtimeDatabaseLogin(process.env.DATABASE_URL))
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[tenantId,storeId])
    const store=await client.query('SELECT id FROM mbox.stores WHERE tenant_id=$1 AND id=$2',[tenantId,storeId])
    if(store.rowCount!==1)throw new Error('scope_store_missing')
    const schema=(await client.query("SELECT COALESCE(max(version::integer),0) AS version,to_regclass('mbox.print_ticket_policy_inheritance')::text AS inheritance_table FROM mbox.normalized_schema_migrations")).rows[0]
    if(!schema.inheritance_table){
      if(schema.version>=259)throw new Error('inheritance_table_missing')
      await client.query('COMMIT')
      process.stdout.write(JSON.stringify({status:'safe',reason:'schema_before_print_inheritance',tenantId,storeId,policies:[],action:'allow_previous_workers',checkedAt:new Date().toISOString()})+'\n')
      return
    }
    const result=await client.query(`SELECT inherited.ticket_kind,inherited.updated_at::text AS cutoff
      FROM mbox.print_ticket_policy_inheritance inherited
      LEFT JOIN mbox.print_ticket_policies policy ON policy.tenant_id=inherited.tenant_id
        AND policy.store_id=inherited.store_id AND policy.ticket_kind=inherited.ticket_kind
      WHERE inherited.tenant_id=$1 AND inherited.store_id=$2
        AND inherited.ticket_kind='cashier_payment' AND COALESCE(policy.enabled,true)`,[tenantId,storeId])
    await client.query('COMMIT')
    process.stdout.write(JSON.stringify({status:result.rowCount?'blocked':'safe',reason:result.rowCount?'cashier_payment_inherited_cutoff':'no_incompatible_cashier_policy',tenantId,storeId,policies:result.rows,action:result.rowCount?'keep_previous_workers_stopped':'allow_previous_workers',checkedAt:new Date().toISOString()})+'\n')
    if(result.rowCount)process.exitCode=2
  }finally{await client.end()}
})().catch(()=>{process.stdout.write(JSON.stringify({status:'blocked',reason:'scoped_runtime_query_failed',action:'keep_previous_workers_stopped'})+'\n');process.exitCode=2})
NODE
  then
    if jq -e '.status == "safe" and .action == "allow_previous_workers" and (.policies | length) == 0 and (.tenantId | type) == "string" and (.storeId | type) == "string"' "${temporary}" >/dev/null; then
      mv "${temporary}" "${evidence}"
      return 0
    fi
  fi
  if jq -e '.status == "blocked"' "${temporary}" >/dev/null 2>&1; then mv "${temporary}" "${evidence}"; else rm -f "${temporary}"; fi
  echo "rollback refused: print inheritance compatibility could not be verified; previous workers remain stopped; evidence=${evidence}" >&2
  return 2
}
