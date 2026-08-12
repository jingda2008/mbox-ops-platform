import pg from 'pg'
import {
  asPostgresPool,
  PostgresIdempotencyConflictError,
  PostgresRepository,
} from '../dist-server/server/postgres-repository.js'
import { PostgresOperationalProjector } from '../dist-server/server/operational-projection.js'
import { provisionRuntime } from '../dist-server/server/provision-runtime.js'
import { createSeedState } from '../dist-server/server/seed.js'
import {
  addOrderItem,
  completeKdsTask,
  createOrderDraft,
  deliverKdsTask,
  pickUpKdsTask,
  startKdsTask,
  submitOrder,
} from '../dist-server/server/order-domain.js'
import {
  ensureDeliveryServiceTask,
  syncDeliveryServiceTaskForKdsAction,
} from '../dist-server/server/fulfillment-service.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('KDS规范化事务验证必须配置DATABASE_URL')

const tenantId = '31111111-1111-4111-8111-111111111111'
const storeId = '32222222-2222-4222-8222-222222222222'
const actorId = 'emp-chen'
const deliveryActorId = 'emp-lin'
const operationScope = 'verify.kds.authority.v2'
const state = createSeedState(new Date('2026-08-11T12:00:00.000Z'))

createOrderDraft(state.orderDomain, {
  orderId: 'order-kds-authority-verification',
  tableSessionId: 'session:table-l01:kds-authority-verification',
  createdBy: actorId,
  occurredAt: '2026-08-11T12:00:00.000Z',
  idempotencyKey: 'verify-kds-draft-0001',
})
addOrderItem(state.orderDomain, {
  orderId: 'order-kds-authority-verification',
  item: {
    id: 'item-kds-authority-verification',
    skuId: 'product-beer',
    name: 'KDS事务验证酒水',
    specification: '330ml',
    quantity: 1,
    unitListPriceAmount: 6800,
    unitSalePriceAmount: 6800,
    unitCostAmount: 1800,
    stationId: 'bar-main',
    configVersion: 1,
  },
  actorId,
  occurredAt: '2026-08-11T12:00:10.000Z',
  idempotencyKey: 'verify-kds-item-0001',
})
const order = submitOrder(state.orderDomain, {
  orderId: 'order-kds-authority-verification',
  submittedBy: actorId,
  occurredAt: '2026-08-11T12:00:20.000Z',
  idempotencyKey: 'verify-kds-submit-0001',
})
const taskId = order.items[0]?.kdsTaskId
if (!taskId) throw new Error('KDS事务验证种子没有生成任务')

await provisionRuntime({
  databaseUrl,
  tenantId,
  tenantCode: 'kds-authority-ci',
  tenantName: 'KDS Authority CI',
  storeUuid: storeId,
  storeCode: state.store.id,
  state,
})

const primaryPool = new pg.Pool({ connectionString: databaseUrl, max: 4, application_name: 'mbox-kds-authority-primary' })
const siblingPool = new pg.Pool({ connectionString: databaseUrl, max: 4, application_name: 'mbox-kds-authority-sibling' })
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2, application_name: 'mbox-kds-authority-admin' })
const primary = new PostgresRepository({
  pool: asPostgresPool(primaryPool), tenantId, storeId, seedState: null,
  projector: new PostgresOperationalProjector(),
})
const sibling = new PostgresRepository({
  pool: asPostgresPool(siblingPool), tenantId, storeId, seedState: null,
  projector: new PostgresOperationalProjector(),
})

function projectionEntityIds(task) {
  return {
    operational_service_tasks: task.deliveryServiceTask?.id ? [task.deliveryServiceTask.id] : [],
    operational_orders: [task.orderId],
    operational_order_items: [task.orderItemId],
    operational_kds_tasks: [task.id],
  }
}

function commandOptions({ key, fingerprint, eventType, actor = actorId }) {
  return {
    idempotency: { operationScope, idempotencyKey: key, requestFingerprint: fingerprint },
    authoritativeKds: { taskId, eventType, actorId: actor, requestId: `verify-${key}` },
    metricLabel: 'kds',
    projectionTables: [
      'operational_service_tasks',
      'operational_orders',
      'operational_order_items',
      'operational_kds_tasks',
    ],
    projectionEntityIds,
  }
}

async function applyCommand(repository, { key, fingerprint, eventType, actor = actorId, occurredAt, mutate }) {
  return repository.mutate((working) => {
    const beforeRevision = working.revision
    const task = mutate(working, { taskId, actorId: actor, occurredAt, idempotencyKey: key })
    if (working.revision === beforeRevision) working.revision += 1
    return task
  }, commandOptions({ key, fingerprint, eventType, actor }))
}

async function authoritativeSnapshot() {
  const result = await adminPool.query(`
    SELECT runtime.revision::integer,
      task.status,
      task.payload,
      task.snapshot_revision::integer,
      (SELECT count(*)::integer FROM mbox.operational_kds_task_events event
       WHERE event.tenant_id = $1::uuid AND event.store_id = $2::uuid) AS event_count
    FROM mbox.runtime_states runtime
    JOIN mbox.operational_kds_tasks task
      ON task.tenant_id = runtime.tenant_id AND task.store_id = runtime.store_id
    WHERE runtime.tenant_id = $1::uuid AND runtime.store_id = $2::uuid
      AND task.source_id = $3
  `, [tenantId, storeId, taskId])
  if (result.rowCount !== 1) throw new Error('无法读取KDS权威快照')
  return result.rows[0]
}

try {
  await primary.init()
  await sibling.init()

  const startFingerprint = JSON.stringify({ taskId, action: 'start', actorId })
  const started = await applyCommand(primary, {
    key: 'verify-kds-start-0001',
    fingerprint: startFingerprint,
    eventType: 'kds.start.v2',
    occurredAt: '2026-08-11T12:01:00.000Z',
    mutate: (working, command) => startKdsTask(working.orderDomain, command),
  })
  if (started.status !== 'preparing') throw new Error('开始制作没有进入preparing')

  const replayed = await applyCommand(sibling, {
    key: 'verify-kds-start-0001',
    fingerprint: startFingerprint,
    eventType: 'kds.start.v2',
    occurredAt: '2026-08-11T12:01:30.000Z',
    mutate: () => { throw new Error('幂等重放不应再次执行领域命令') },
  })
  if (replayed.status !== 'preparing') throw new Error('跨实例幂等重放结果不一致')
  const afterReplay = await authoritativeSnapshot()
  if (afterReplay.event_count !== 1) throw new Error('跨实例幂等重放重复写入KDS事件')

  await adminPool.query(`
    DELETE FROM mbox.idempotency_records
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND operation_scope = $3 AND idempotency_key = 'verify-kds-start-0001'
  `, [tenantId, storeId, operationScope])
  const replayAfterCleanup = await applyCommand(sibling, {
    key: 'verify-kds-start-0001',
    fingerprint: startFingerprint,
    eventType: 'kds.start.v2',
    occurredAt: '2026-08-11T12:01:31.000Z',
    mutate: (working, command) => startKdsTask(working.orderDomain, command),
  })
  if (replayAfterCleanup.status !== 'preparing' || (await authoritativeSnapshot()).event_count !== 1) {
    throw new Error('通用幂等记录清理后没有复用永久KDS事件')
  }

  let conflictRejected = false
  try {
    await applyCommand(sibling, {
      key: 'verify-kds-start-0001',
      fingerprint: JSON.stringify({ taskId, action: 'start', actorId: deliveryActorId }),
      eventType: 'kds.start.v2',
      actor: deliveryActorId,
      occurredAt: '2026-08-11T12:01:31.000Z',
      mutate: () => { throw new Error('冲突请求不应执行领域命令') },
    })
  } catch (error) {
    conflictRejected = error instanceof PostgresIdempotencyConflictError
  }
  if (!conflictRejected) throw new Error('同一幂等键的不同请求没有被拒绝')

  const delegateProjector = new PostgresOperationalProjector()
  let failProjection = false
  const failingProjector = {
    async project(...args) {
      await delegateProjector.project(...args)
      if (failProjection) throw new Error('intentional KDS projection failure')
    },
    healthCheck(...args) { return delegateProjector.healthCheck(...args) },
  }
  const rollbackPool = new pg.Pool({ connectionString: databaseUrl, max: 2, application_name: 'mbox-kds-authority-rollback' })
  const rollbackRepository = new PostgresRepository({
    pool: asPostgresPool(rollbackPool), tenantId, storeId, seedState: null, projector: failingProjector,
  })
  try {
    await rollbackRepository.init()
    const rollbackBaseline = await authoritativeSnapshot()
    failProjection = true
    let rollbackRejected = false
    try {
      await applyCommand(rollbackRepository, {
        key: 'verify-kds-complete-rollback-0001',
        fingerprint: JSON.stringify({ taskId, action: 'complete', actorId, fault: true }),
        eventType: 'kds.complete.v2',
        occurredAt: '2026-08-11T12:02:00.000Z',
        mutate: (working, command) => {
          const task = completeKdsTask(working.orderDomain, command)
          ensureDeliveryServiceTask(working, task, command.occurredAt)
          return task
        },
      })
    } catch (error) {
      rollbackRejected = error instanceof Error && error.message === 'intentional KDS projection failure'
    }
    if (!rollbackRejected) throw new Error('投影故障没有拒绝KDS事务')
    const afterRollback = await authoritativeSnapshot()
    if (JSON.stringify(afterRollback) !== JSON.stringify(rollbackBaseline)) {
      throw new Error(`KDS投影故障没有完整回滚：${JSON.stringify({ rollbackBaseline, afterRollback })}`)
    }
  } finally {
    await rollbackRepository.close()
  }

  const completed = await applyCommand(primary, {
    key: 'verify-kds-complete-0001',
    fingerprint: JSON.stringify({ taskId, action: 'complete', actorId }),
    eventType: 'kds.complete.v2',
    occurredAt: '2026-08-11T12:02:00.000Z',
    mutate: (working, command) => {
      const task = completeKdsTask(working.orderDomain, command)
      ensureDeliveryServiceTask(working, task, command.occurredAt)
      return task
    },
  })
  if (completed.status !== 'completed' || !completed.deliveryServiceTask?.id) {
    throw new Error('完成制作没有原子生成配送任务')
  }

  const pickupKey = 'verify-kds-pickup-0001'
  const pickupFingerprint = JSON.stringify({ taskId, action: 'pickUp', actorId: deliveryActorId })
  const pickupCommand = {
    key: pickupKey,
    fingerprint: pickupFingerprint,
    eventType: 'kds.pick_up.v2',
    actor: deliveryActorId,
    occurredAt: '2026-08-11T12:03:00.000Z',
    mutate: (working, command) => {
      const task = pickUpKdsTask(working.orderDomain, command)
      ensureDeliveryServiceTask(working, task, task.completedAt ?? command.occurredAt)
      syncDeliveryServiceTaskForKdsAction(working, task, 'pickUp', command.actorId, command.occurredAt, command.idempotencyKey)
      return task
    },
  }
  const [pickupA, pickupB] = await Promise.all([
    applyCommand(primary, pickupCommand),
    applyCommand(sibling, pickupCommand),
  ])
  if (pickupA.status !== 'picked_up' || pickupB.status !== 'picked_up') {
    throw new Error('跨实例并发取货没有收敛到picked_up')
  }

  const delivered = await applyCommand(sibling, {
    key: 'verify-kds-deliver-0001',
    fingerprint: JSON.stringify({ taskId, action: 'deliver', actorId: deliveryActorId }),
    eventType: 'kds.deliver.v2',
    actor: deliveryActorId,
    occurredAt: '2026-08-11T12:04:00.000Z',
    mutate: (working, command) => {
      const task = deliverKdsTask(working.orderDomain, command)
      ensureDeliveryServiceTask(working, task, task.completedAt ?? command.occurredAt)
      syncDeliveryServiceTaskForKdsAction(working, task, 'deliver', command.actorId, command.occurredAt, command.idempotencyKey)
      return task
    },
  })
  if (delivered.status !== 'delivered') throw new Error('配送完成没有进入delivered')

  const finalState = await sibling.readFresh()
  const finalTask = finalState.orderDomain.kdsTasks.find((candidate) => candidate.id === taskId)
  const deliveryTask = finalState.tasks.find((candidate) => candidate.id === finalTask?.deliveryServiceTask?.id)
  if (finalTask?.status !== 'delivered' || deliveryTask?.status !== 'completed') {
    throw new Error('KDS与配送服务任务最终状态不一致')
  }

  const finalSnapshot = await authoritativeSnapshot()
  if (finalSnapshot.status !== 'delivered' || finalSnapshot.payload.status !== 'delivered') {
    throw new Error('规范化KDS状态列、载荷和兼容镜像没有收敛')
  }
  if (finalSnapshot.event_count !== 4) {
    throw new Error(`KDS权威事件数量不正确：${finalSnapshot.event_count}/4`)
  }

  const originalPayload = finalSnapshot.payload
  await adminPool.query(`
    UPDATE mbox.operational_kds_tasks
    SET payload = jsonb_set(payload, '{itemName}', '"tampered"'::jsonb)
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND source_id = $3
  `, [tenantId, storeId, taskId])
  const tamperedHealth = await primary.healthCheck()
  if (tamperedHealth.ready || tamperedHealth.kdsAuthorityConsistent !== false) {
    throw new Error(`KDS载荷篡改后健康端点没有阻断：${JSON.stringify(tamperedHealth)}`)
  }
  let tamperRejected = false
  try {
    await applyCommand(primary, {
      key: 'verify-kds-tamper-0001',
      fingerprint: JSON.stringify({ taskId, action: 'deliver', actorId: deliveryActorId, tamper: true }),
      eventType: 'kds.deliver.v2',
      actor: deliveryActorId,
      occurredAt: '2026-08-11T12:05:00.000Z',
      mutate: () => { throw new Error('篡改状态不应进入领域命令') },
    })
  } catch (error) {
    tamperRejected = error instanceof Error && error.message.includes('兼容镜像内容不一致')
  }
  if (!tamperRejected) throw new Error('规范化KDS载荷被篡改后命令没有失败关闭')

  const tamperStartupPool = new pg.Pool({
    connectionString: databaseUrl, max: 1, application_name: 'mbox-kds-authority-tamper-startup',
  })
  const tamperStartupRepository = new PostgresRepository({
    pool: asPostgresPool(tamperStartupPool), tenantId, storeId, seedState: null,
    projector: new PostgresOperationalProjector(),
  })
  let tamperStartupRejected = false
  try {
    await tamperStartupRepository.init()
  } catch (error) {
    tamperStartupRejected = error instanceof Error && error.message.includes('与兼容镜像不一致')
  } finally {
    await tamperStartupRepository.close()
  }
  if (!tamperStartupRejected) throw new Error('规范化KDS载荷被篡改后服务重启没有失败关闭')
  await adminPool.query(`
    UPDATE mbox.operational_kds_tasks SET payload = $4::jsonb
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND source_id = $3
  `, [tenantId, storeId, taskId, JSON.stringify(originalPayload)])

  const event = await adminPool.query(`
    SELECT source_event_id FROM mbox.operational_kds_task_events
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    ORDER BY occurred_at LIMIT 1
  `, [tenantId, storeId])
  let appendOnlyEnforced = false
  try {
    await adminPool.query(`
      UPDATE mbox.operational_kds_task_events SET actor_id = 'tampered'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND source_event_id = $3
    `, [tenantId, storeId, event.rows[0].source_event_id])
  } catch {
    appendOnlyEnforced = true
  }
  if (!appendOnlyEnforced) throw new Error('KDS事件账本允许修改历史记录')

  let missingTaskEventRejected = false
  try {
    await adminPool.query(`
      INSERT INTO mbox.operational_kds_task_events (
        tenant_id, store_id, source_event_id, kds_task_id, operation_scope,
        event_type, from_status, to_status, actor_id, idempotency_key,
        request_sha256, occurred_at, business_date, runtime_revision, payload
      ) VALUES (
        $1::uuid, $2::uuid, 'verify-missing-task-event', 'missing-kds-task', $3,
        'kds.start.v2', 'queued', 'preparing', $4, 'verify-missing-task-0001',
        repeat('0', 64), clock_timestamp(), '2026-08-11'::date, 1, '{}'::jsonb
      )
    `, [tenantId, storeId, operationScope, actorId])
  } catch (error) {
    missingTaskEventRejected = error?.code === '23503'
  }
  if (!missingTaskEventRejected) throw new Error('KDS事件允许引用不存在的任务')

  const rollbackCompatibilityClient = await adminPool.connect()
  try {
    await rollbackCompatibilityClient.query('BEGIN')
    const deleted = await rollbackCompatibilityClient.query(`
      DELETE FROM mbox.operational_kds_tasks
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND source_id = $3
    `, [tenantId, storeId, taskId])
    if (deleted.rowCount !== 1) throw new Error('无法模拟上一版本启动时的KDS重建')
    await rollbackCompatibilityClient.query('ROLLBACK')
  } catch (error) {
    await rollbackCompatibilityClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    rollbackCompatibilityClient.release()
  }

  const health = await primary.healthCheck()
  if (!health.ready || health.kdsAuthorityConsistent !== true) {
    throw new Error(`KDS权威一致性健康检查失败：${JSON.stringify(health)}`)
  }

  console.log(JSON.stringify({
    verified: true,
    taskId,
    finalStatus: finalTask.status,
    deliveryStatus: deliveryTask.status,
    authorityEvents: finalSnapshot.event_count,
    crossInstanceReplay: 'verified',
    replayAfterIdempotencyCleanup: 'verified',
    crossInstanceConcurrency: 'verified',
    projectionRollback: 'verified',
    tamperFailClosed: 'verified',
    tamperStartupFailClosed: 'verified',
    appendOnlyLedger: 'verified',
    missingTaskEventRejected: 'verified',
    priorVersionRebuildCompatibility: 'verified',
  }))
} finally {
  await Promise.allSettled([primary.close(), sibling.close()])
  await adminPool.end()
}
