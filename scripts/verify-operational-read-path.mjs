import pg from 'pg'
import {
  APP_CANONICAL_STATE_CHECKSUM_ALGORITHM,
  asPostgresPool,
  POSTGRES_JSONB_STATE_CHECKSUM_ALGORITHM,
  PostgresMutationNotIdleError,
  PostgresRepository,
  runtimeStateValueChecksum,
} from '../dist-server/server/postgres-repository.js'
import { PostgresOperationalProjector } from '../dist-server/server/operational-projection.js'
import {
  hydrateRuntimeStateFromOperationalTables,
  PostgresOperationalReadStore,
} from '../dist-server/server/operational-read-store.js'
import { createSeedState } from '../dist-server/server/seed.js'
import { provisionRuntime } from '../dist-server/server/provision-runtime.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('规范化读取集成验证必须配置DATABASE_URL')

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
const tenantCode = process.env.MBOX_VERIFY_TENANT_CODE?.trim() || 'ci-tenant'
const tenantName = process.env.MBOX_VERIFY_TENANT_NAME?.trim() || 'CI Tenant'

await provisionRuntime({
  databaseUrl,
  tenantId,
  tenantCode,
  tenantName,
  storeUuid: storeId,
  storeCode: state.store.id,
  state,
})

const primaryNativePool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  application_name: 'mbox-verify-primary',
})
const pool = asPostgresPool(primaryNativePool)
const repository = new PostgresRepository({
  pool,
  tenantId,
  storeId,
  seedState: null,
  projector: new PostgresOperationalProjector(),
})
const siblingNativePool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  application_name: 'mbox-verify-sibling',
})
const siblingPool = asPostgresPool(siblingNativePool)
const siblingRepository = new PostgresRepository({
  pool: siblingPool,
  tenantId,
  storeId,
  seedState: null,
  projector: new PostgresOperationalProjector(),
})
const adminPool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'mbox-verify-admin',
})

async function withoutRuntimeJournal(operation) {
  await adminPool.query('ALTER TABLE mbox.runtime_states DISABLE TRIGGER runtime_states_journal_version')
  try {
    return await operation()
  } finally {
    await adminPool.query('ALTER TABLE mbox.runtime_states ENABLE TRIGGER runtime_states_journal_version')
  }
}

try {
  const legacyChecksum = runtimeStateValueChecksum(state)
  await withoutRuntimeJournal(() => adminPool.query(`
      UPDATE mbox.runtime_states
      SET state_sha256 = $3,
          state_checksum_algorithm = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId, legacyChecksum, APP_CANONICAL_STATE_CHECKSUM_ALGORITHM]))

  await repository.init()
  const legacyCheckpoint = await adminPool.query(`
    SELECT state_sha256, state_checksum_algorithm
    FROM mbox.operational_projection_checkpoints
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [tenantId, storeId])
  if (
    legacyCheckpoint.rows[0]?.state_sha256 !== legacyChecksum
    || legacyCheckpoint.rows[0]?.state_checksum_algorithm !== APP_CANONICAL_STATE_CHECKSUM_ALGORITHM
  ) {
    throw new Error('旧版应用校验和没有被启动投影原样保留')
  }

  const before = await repository.readFresh()
  const operationalStore = new PostgresOperationalReadStore(pool, { tenantId, storeId })
  const firstSnapshot = await operationalStore.read(before.revision, before.store.businessDate)
  if (firstSnapshot.tables.length !== before.tables.length) {
    throw new Error(`首次回填桌台数量不一致：${firstSnapshot.tables.length}/${before.tables.length}`)
  }

  const target = before.tables[0]
  await repository.mutate((working) => {
    working.tables[0] = { ...working.tables[0], guestCount: working.tables[0].guestCount + 1 }
    working.revision += 1
  })

  const after = await repository.readFresh()
  const upgradedChecksum = await adminPool.query(`
    SELECT runtime.state_sha256,
      runtime.state_checksum_algorithm,
      checkpoint.state_sha256 AS checkpoint_sha256,
      checkpoint.state_checksum_algorithm AS checkpoint_algorithm,
      runtime.state_sha256 = encode(sha256(convert_to(runtime.state::text, 'UTF8')), 'hex') AS checksum_valid
    FROM mbox.runtime_states runtime
    JOIN mbox.operational_projection_checkpoints checkpoint
      ON checkpoint.tenant_id = runtime.tenant_id AND checkpoint.store_id = runtime.store_id
    WHERE runtime.tenant_id = $1::uuid AND runtime.store_id = $2::uuid
  `, [tenantId, storeId])
  const upgraded = upgradedChecksum.rows[0]
  if (
    upgraded?.state_checksum_algorithm !== POSTGRES_JSONB_STATE_CHECKSUM_ALGORITHM
    || upgraded?.checkpoint_algorithm !== POSTGRES_JSONB_STATE_CHECKSUM_ALGORITHM
    || upgraded?.state_sha256 !== upgraded?.checkpoint_sha256
    || upgraded?.checksum_valid !== true
  ) {
    throw new Error(`首次写入没有把校验和原子升级到PostgreSQL算法：${JSON.stringify(upgraded)}`)
  }
  const upgradeJournal = await adminPool.query(`
    SELECT previous_state_checksum_algorithm, state_checksum_algorithm
    FROM mbox.runtime_state_versions
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND previous_state_checksum_algorithm = $3
      AND state_checksum_algorithm = $4
    ORDER BY revision DESC
    LIMIT 1
  `, [tenantId, storeId, APP_CANONICAL_STATE_CHECKSUM_ALGORITHM, POSTGRES_JSONB_STATE_CHECKSUM_ALGORITHM])
  if (upgradeJournal.rowCount !== 1) throw new Error('运行状态日志没有记录校验算法升级链')

  await siblingRepository.init()
  const siblingHealthAfterRestart = await siblingRepository.healthCheck()
  if (!siblingHealthAfterRestart.ready || siblingHealthAfterRestart.projectionChecksumMatch !== true || siblingHealthAfterRestart.kdsAuthorityConsistent !== true) {
    throw new Error(`第二实例重启后校验和投影不一致：${JSON.stringify(siblingHealthAfterRestart)}`)
  }
  const secondSnapshot = await operationalStore.read(after.revision, after.store.businessDate)
  const hydrated = hydrateRuntimeStateFromOperationalTables(after, secondSnapshot)
  if (secondSnapshot.tables.length !== after.tables.length) {
    throw new Error(`单行变更后未变化桌台丢失：${secondSnapshot.tables.length}/${after.tables.length}`)
  }
  if (hydrated.tables.find((table) => table.id === target.id)?.guestCount !== target.guestCount + 1) {
    throw new Error('单行变更未同步到规范化读取结果')
  }

  await adminPool.query(`
    UPDATE mbox.operational_projection_checkpoints
    SET state_sha256 = repeat('0', 64)
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [tenantId, storeId])
  let checkpointTamperRejected = false
  try {
    await operationalStore.read(after.revision, after.store.businessDate)
  } catch {
    checkpointTamperRejected = true
  }
  if (!checkpointTamperRejected) throw new Error('规范化读取没有拒绝被篡改的投影校验和')
  await adminPool.query(`
    UPDATE mbox.operational_projection_checkpoints
    SET state_sha256 = $3, state_checksum_algorithm = $4
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [tenantId, storeId, upgraded.state_sha256, POSTGRES_JSONB_STATE_CHECKSUM_ALGORITHM])

  let releaseForeground
  let markForegroundEntered
  const foregroundEntered = new Promise((resolve) => { markForegroundEntered = resolve })
  const foregroundRelease = new Promise((resolve) => { releaseForeground = resolve })
  const foregroundMutation = siblingRepository.mutate(async (working) => {
    markForegroundEntered()
    await foregroundRelease
    working.revision += 1
  })
  await foregroundEntered
  const schedulerAttemptStartedAt = performance.now()
  let rejectedAsBusy = false
  try {
    await repository.mutate((working) => {
      working.revision += 1
    }, { metricLabel: 'scheduler', minimumGlobalIdleMs: 750 })
  } catch (error) {
    if (!(error instanceof PostgresMutationNotIdleError)) throw error
    rejectedAsBusy = true
  } finally {
    releaseForeground()
  }
  await foregroundMutation
  if (!rejectedAsBusy) throw new Error('另一实例持有前台写事务时，后台调度写没有被拒绝')
  if (performance.now() - schedulerAttemptStartedAt > 500) {
    throw new Error('后台调度写没有快速避让前台事务')
  }

  let releaseLeaseOperation
  let markLeaseEntered
  const leaseEntered = new Promise((resolve) => { markLeaseEntered = resolve })
  const leaseRelease = new Promise((resolve) => { releaseLeaseOperation = resolve })
  const failedLeaseRun = siblingRepository.runWithDistributedLease(
    'operational-scheduler-failover',
    async () => {
      markLeaseEntered()
      await leaseRelease
      return 'terminated-holder'
    },
  )
  await leaseEntered

  const blockedLeaseRun = await repository.runWithDistributedLease(
    'operational-scheduler-failover',
    async () => 'must-not-run',
  )
  if (blockedLeaseRun.acquired) throw new Error('分布式调度租约允许两个实例同时执行')

  const holder = await adminPool.query(`
    SELECT DISTINCT activity.pid
    FROM pg_stat_activity AS activity
    JOIN pg_locks AS held_lock ON held_lock.pid = activity.pid
    WHERE activity.application_name = $1
      AND held_lock.locktype = 'advisory'
      AND held_lock.granted
  `, ['mbox-verify-sibling'])
  if (holder.rowCount !== 1 || !holder.rows[0]?.pid) {
    throw new Error(`无法唯一定位调度租约持有连接：${JSON.stringify(holder.rows)}`)
  }
  const terminated = await adminPool.query(
    'SELECT pg_terminate_backend($1) AS terminated',
    [holder.rows[0].pid],
  )
  if (terminated.rows[0]?.terminated !== true) throw new Error('未能终止调度租约持有连接')

  releaseLeaseOperation()
  let failedHolderRejected = false
  try {
    await failedLeaseRun
  } catch {
    failedHolderRejected = true
  }
  if (!failedHolderRejected) throw new Error('数据库连接中断后旧调度实例仍报告执行成功')

  const takeoverStartedAt = performance.now()
  const takeover = await repository.runWithDistributedLease(
    'operational-scheduler-failover',
    async () => 'replacement-holder',
  )
  const takeoverMs = performance.now() - takeoverStartedAt
  if (!takeover.acquired || takeover.value !== 'replacement-holder') {
    throw new Error('租约持有连接中断后健康实例未接管调度')
  }
  if (takeoverMs > 1_000) throw new Error(`调度故障接管过慢：${takeoverMs.toFixed(1)}ms`)

  const afterContention = await repository.readFresh()
  const rollbackBaseline = await adminPool.query(`
    SELECT
      (SELECT count(*)::integer FROM mbox.runtime_state_versions
       WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS journal_count,
      checkpoint.runtime_revision,
      checkpoint.state_sha256,
      checkpoint.state_checksum_algorithm
    FROM mbox.operational_projection_checkpoints checkpoint
    WHERE checkpoint.tenant_id = $1::uuid AND checkpoint.store_id = $2::uuid
  `, [tenantId, storeId])

  let projectorCalls = 0
  const delegateProjector = new PostgresOperationalProjector()
  const failingProjector = {
    async project(...args) {
      projectorCalls += 1
      const result = await delegateProjector.project(...args)
      if (projectorCalls > 1) throw new Error('intentional projection failure')
      return result
    },
    healthCheck(...args) {
      return delegateProjector.healthCheck(...args)
    },
  }
  const rollbackNativePool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'mbox-verify-rollback',
  })
  const rollbackRepository = new PostgresRepository({
    pool: asPostgresPool(rollbackNativePool),
    tenantId,
    storeId,
    seedState: null,
    projector: failingProjector,
  })
  try {
    await rollbackRepository.init()
    let mutationRejected = false
    try {
      await rollbackRepository.mutate((working) => {
        working.tables[0] = { ...working.tables[0], guestCount: working.tables[0].guestCount + 10 }
        working.revision += 1
      })
    } catch (error) {
      mutationRejected = error instanceof Error && error.message === 'intentional projection failure'
    }
    if (!mutationRejected) throw new Error('投影失败没有拒绝运行状态写入')
    const afterRollback = await repository.readFresh()
    if (afterRollback.revision !== afterContention.revision || afterRollback.tables[0].guestCount !== afterContention.tables[0].guestCount) {
      throw new Error('投影失败后运行状态或修订号没有回滚')
    }
    const rollbackEvidence = await adminPool.query(`
      SELECT
        (SELECT count(*)::integer FROM mbox.runtime_state_versions
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS journal_count,
        checkpoint.runtime_revision,
        checkpoint.state_sha256,
        checkpoint.state_checksum_algorithm,
        (SELECT bool_and(snapshot_revision = checkpoint.runtime_revision)
         FROM mbox.operational_tables
         WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS tables_revision_match
      FROM mbox.operational_projection_checkpoints checkpoint
      WHERE checkpoint.tenant_id = $1::uuid AND checkpoint.store_id = $2::uuid
    `, [tenantId, storeId])
    if (JSON.stringify(rollbackEvidence.rows[0]) !== JSON.stringify({
      ...rollbackBaseline.rows[0],
      tables_revision_match: true,
    })) {
      throw new Error(`投影部分写入失败后checkpoint、journal或规范化行没有完整回滚：${JSON.stringify(rollbackEvidence.rows[0])}`)
    }
  } finally {
    await rollbackRepository.close()
  }

  const authoritativeBeforeTamper = await adminPool.query(`
    SELECT state_sha256, state_checksum_algorithm
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [tenantId, storeId])
  await withoutRuntimeJournal(() => adminPool.query(`
      UPDATE mbox.runtime_states
      SET state_sha256 = repeat('f', 64)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId]))
  const tamperNativePool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: 'mbox-verify-tamper' })
  const tamperRepository = new PostgresRepository({
    pool: asPostgresPool(tamperNativePool), tenantId, storeId, seedState: null,
    projector: new PostgresOperationalProjector(),
  })
  let aggregateTamperRejected = false
  try {
    await tamperRepository.init()
  } catch {
    aggregateTamperRejected = true
  } finally {
    await tamperRepository.close()
  }
  if (!aggregateTamperRejected) throw new Error('仓库启动没有拒绝被篡改的运行状态校验和')
  await withoutRuntimeJournal(() => adminPool.query(`
      UPDATE mbox.runtime_states
      SET state_sha256 = $3, state_checksum_algorithm = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [
      tenantId,
      storeId,
      authoritativeBeforeTamper.rows[0].state_sha256,
      authoritativeBeforeTamper.rows[0].state_checksum_algorithm,
    ]))

  const health = await repository.healthCheck()
  if (!health.ready || !health.projectionReady || !health.projectionCountsMatch || !health.projectionChecksumMatch || health.kdsAuthorityConsistent !== true || health.projectionRevision !== afterContention.revision) {
    throw new Error(`规范化投影健康检查失败：${JSON.stringify(health)}`)
  }
  console.log(JSON.stringify({
    verified: true,
    revision: afterContention.revision,
    tables: secondSnapshot.tables.length,
    projectionRevision: health.projectionRevision,
    countsMatch: health.projectionCountsMatch,
    kdsAuthorityConsistent: health.kdsAuthorityConsistent,
    crossInstanceMutationGate: 'verified',
    distributedLeaseFailover: 'verified',
    distributedLeaseTakeoverMs: Math.round(takeoverMs * 10) / 10,
    checksumAlgorithmUpgrade: 'verified',
    checksumTamperDetection: 'verified',
    projectionRollback: 'verified',
  }))
} finally {
  await adminPool.end()
  await siblingRepository.close()
  await repository.close()
}
