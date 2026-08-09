import pg from 'pg'
import {
  asPostgresPool,
  PostgresMutationNotIdleError,
  PostgresRepository,
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

try {
  await repository.init()
  await siblingRepository.init()
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
  const secondSnapshot = await operationalStore.read(after.revision, after.store.businessDate)
  const hydrated = hydrateRuntimeStateFromOperationalTables(after, secondSnapshot)
  if (secondSnapshot.tables.length !== after.tables.length) {
    throw new Error(`单行变更后未变化桌台丢失：${secondSnapshot.tables.length}/${after.tables.length}`)
  }
  if (hydrated.tables.find((table) => table.id === target.id)?.guestCount !== target.guestCount + 1) {
    throw new Error('单行变更未同步到规范化读取结果')
  }

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
  const health = await repository.healthCheck()
  if (!health.ready || !health.projectionReady || !health.projectionCountsMatch || health.projectionRevision !== afterContention.revision) {
    throw new Error(`规范化投影健康检查失败：${JSON.stringify(health)}`)
  }
  console.log(JSON.stringify({
    verified: true,
    revision: afterContention.revision,
    tables: secondSnapshot.tables.length,
    projectionRevision: health.projectionRevision,
    countsMatch: health.projectionCountsMatch,
    crossInstanceMutationGate: 'verified',
    distributedLeaseFailover: 'verified',
    distributedLeaseTakeoverMs: Math.round(takeoverMs * 10) / 10,
  }))
} finally {
  await adminPool.end()
  await siblingRepository.close()
  await repository.close()
}
