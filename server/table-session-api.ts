import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  closeTableSessionSchema,
  salesAttributionSchema,
  tableCombinationSchema,
  tableOperationsConfigInputSchema,
  transferTableSessionSchema,
  walkInOpenSchema,
  type RuntimeState,
  type TableCombinationRecord,
  type TableTransferRecord,
} from '../src/shared/contracts.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import {
  activeTableCombinationLinks,
  currentOpenTableSession,
  currentSalesEmployeeId,
  openTableSession,
  recordSalesAttribution,
  tableOperationsConfig,
  tableSessionSummary,
} from './table-sessions.js'
import { startAwaitingOrder, stopAwaitingOrder } from './proactive-service.js'
import { mutateReservationState, reservationsFor } from './reservation-api.js'
import { confirmReservation, createReservation, markReservationArrived, seatReservation } from './reservation-domain.js'

const openTaskStatuses = new Set(['pending', 'accepted', 'arrived', 'completed', 'reopened', 'escalated'])
const confirmedPaymentStatuses = new Set(['succeeded', 'reported_pending_reconciliation'])
const pendingRefundStatuses = new Set(['requested', 'approved', 'processing'])
const openServiceTaskStatuses = new Set(['pending', 'accepted', 'arrived', 'completed', 'reopened', 'escalated'])
const activeSongStatuses = new Set(['pending_confirmation', 'pending_payment', 'paid', 'accepted', 'performing', 'refund_required'])

function childIdempotencyKey(key: string, suffix: string) {
  return `${key.slice(0, Math.max(8, 118 - suffix.length))}:${suffix}`
}

function assertTablePrimaryReady(state: RuntimeState, tableId: string) {
  const table = state.tables.find((candidate) => candidate.id === tableId)
  if (!table) throw new Error('桌台不存在')
  const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId && employee.status === 'active')
  const activeShift = primary && state.shiftAssignments.find((shift) =>
    shift.employeeId === primary.id && shift.businessDate === state.store.businessDate &&
    shift.status === 'active' && shift.areaIds.includes(table.areaId),
  )
  if (!primary || !primary.online || primary.paused || !activeShift) {
    throw new Error('桌台主服务员当前不可接待，请先完成员工调度')
  }
  return table
}

function validateTableOperationsConfig(state: RuntimeState, rules: ReturnType<typeof tableOperationsConfigInputSchema.parse>['minimumSpendRules']) {
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error('低消规则ID不能重复')
  for (const rule of rules) {
    if (new Set(rule.weekdays).size !== rule.weekdays.length) throw new Error(`${rule.name}的星期不能重复`)
    if (rule.startTime === rule.endTime) throw new Error(`${rule.name}的开始和结束时间不能相同`)
    if (rule.targetType === 'table' && !state.tables.some((table) => table.id === rule.targetId)) {
      throw new Error(`${rule.name}引用的桌台不存在`)
    }
    if (rule.targetType === 'area' && !state.areas.some((area) => area.id === rule.targetId)) {
      throw new Error(`${rule.name}引用的区域不存在`)
    }
  }
}

function currentCombinationForTable(state: RuntimeState, tableId: string) {
  return activeTableCombinationLinks(state).filter((record) =>
    record.primaryTableId === tableId || record.relatedTableId === tableId,
  )
}

function assertAddedTableCanSplit(state: RuntimeState, record: TableCombinationRecord) {
  const sessionId = record.relatedTableSessionId
  if (state.orderDomain.orders.some((order) => order.tableSessionId === sessionId)) {
    throw new Error('加桌已经产生订单，不能拆回；请保留到结账后再处理')
  }
  if (state.paymentDomain.paymentIntents.some((intent) => intent.tableSessionId === sessionId)) {
    throw new Error('加桌已经产生支付记录，不能拆回')
  }
  if (state.orderDomain.kdsTasks.some((task) => task.tableSessionId === sessionId)) {
    throw new Error('加桌已经产生出品任务，不能拆回')
  }
}

function activeShiftForTable(state: RuntimeState, employeeId: string, areaId: string) {
  return state.shiftAssignments.some((shift) =>
    shift.employeeId === employeeId &&
    shift.businessDate === state.store.businessDate &&
    shift.status === 'active' &&
    shift.areaIds.includes(areaId),
  )
}

function targetResponsibilityChain(state: RuntimeState, tableId: string) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) return []
  return [table.primaryEmployeeId, ...table.backupEmployeeIds].filter((employeeId, index, values) =>
    values.indexOf(employeeId) === index && state.employees.some((employee) =>
      employee.id === employeeId && employee.status === 'active' && employee.online && !employee.paused,
    ),
  )
}

export function transferOpenTableSession(
  state: RuntimeState,
  sourceTableId: string,
  input: ReturnType<typeof transferTableSessionSchema.parse>,
  actorId: string,
  occurredAt: string,
) {
  state.tableTransfers ??= []
  const replay = state.tableTransfers.find((record) => record.idempotencyKey === input.idempotencyKey)
  if (replay) {
    if (
      replay.sourceTableId !== sourceTableId || replay.targetTableId !== input.targetTableId ||
      replay.kind !== input.kind || replay.reason !== input.reason
    ) throw new Error('幂等键已用于不同转桌请求')
    return replay
  }

  if (sourceTableId === input.targetTableId) throw new Error('目标桌不能与原桌相同')
  const source = state.tables.find((table) => table.id === sourceTableId)
  const target = state.tables.find((table) => table.id === input.targetTableId)
  if (!source || source.status !== 'occupied' || !source.openedAt) throw new Error('只有营业中的桌台可以转桌')
  if (!target) throw new Error('目标桌台不存在')
  if (currentCombinationForTable(state, source.id).length > 0 || currentCombinationForTable(state, target.id).length > 0) {
    throw new Error('桌台处于合台/加桌关系中，请先使用专用拆回流程')
  }
  if (target.status === 'occupied') throw new Error('目标桌已有客人；合台需要使用专用合台流程，不能直接转桌')
  if (target.status === 'reserved') throw new Error('目标桌已被预约锁定，请先由门迎或店长处理预约后再转桌')
  if (target.status === 'paused') throw new Error('目标桌已暂停使用')
  if (target.capacity < source.guestCount) throw new Error(`目标桌容量不足：${source.guestCount}/${target.capacity}`)
  const targetPrimary = state.employees.find((employee) =>
    employee.id === target.primaryEmployeeId && employee.status === 'active',
  )
  if (!targetPrimary || !targetPrimary.online || targetPrimary.paused || !activeShiftForTable(state, targetPrimary.id, target.areaId)) {
    throw new Error('目标桌主服务员当前不可接待，请先完成员工调度')
  }
  if (state.songState.tableSessions.some((session) => session.tableId === target.id && session.status === 'open')) {
    throw new Error('目标桌存在开放桌次，不能转入')
  }

  const session = currentOpenTableSession(state, source.id)
  const guestCount = source.guestCount
  const movedServiceTasks = state.tasks.filter((task) => task.tableId === source.id && openServiceTaskStatuses.has(task.status))
  const movedAwaitingOrderIntents = state.awaitingOrderIntents.filter((intent) =>
    intent.tableId === source.id && intent.status === 'active',
  )
  const movedReservations = state.reservationState?.reservations.filter((reservation) =>
    reservation.tableSessionId === session.id && reservation.status === 'seated',
  ) ?? []
  const movedSongRequests = state.songState.requests.filter((request) =>
    request.tableSessionId === session.id && activeSongStatuses.has(request.status),
  )
  const movedBenefitRedemptions = state.benefitRedemptions.filter((redemption) =>
    redemption.tableSessionId === session.id && redemption.status === 'locked',
  )
  const notifiedEmployeeIds = targetResponsibilityChain(state, target.id)

  session.tableId = target.id
  session.tableCode = target.code
  source.status = 'available'
  source.guestCount = 0
  source.openedAt = null
  target.status = 'occupied'
  target.guestCount = guestCount
  target.openedAt = session.openedAt

  for (const task of movedServiceTasks) {
    task.tableId = target.id
    task.notifiedEmployeeIds = [...new Set([...task.notifiedEmployeeIds, ...notifiedEmployeeIds])]
    task.updatedAt = occurredAt
    state.taskEvents.push({
      id: `event_${randomUUID()}`,
      taskId: task.id,
      type: 'task.table_transferred.v1',
      actorId,
      occurredAt,
      payload: { sourceTableId: source.id, targetTableId: target.id, tableSessionId: session.id },
    })
  }
  for (const intent of movedAwaitingOrderIntents) intent.tableId = target.id
  for (const reservation of movedReservations) {
    reservation.tableId = target.id
    reservation.tableCode = target.code
    reservation.updatedAt = occurredAt
    reservation.revision += 1
  }
  for (const request of movedSongRequests) {
    request.tableId = target.id
    request.tableCode = target.code
    request.updatedAt = occurredAt
    request.revision += 1
  }
  for (const redemption of movedBenefitRedemptions) {
    redemption.tableId = target.id
    redemption.tableOpenedAt = session.openedAt
  }

  const record: TableTransferRecord = {
    id: `table-transfer:${randomUUID()}`,
    tableSessionId: session.id,
    kind: input.kind,
    sourceTableId: source.id,
    sourceTableCode: source.code,
    targetTableId: target.id,
    targetTableCode: target.code,
    guestCount: target.guestCount,
    actorId,
    reason: input.reason,
    occurredAt,
    idempotencyKey: input.idempotencyKey,
    movedServiceTaskIds: movedServiceTasks.map((task) => task.id),
    movedAwaitingOrderIntentIds: movedAwaitingOrderIntents.map((intent) => intent.id),
    movedReservationIds: movedReservations.map((reservation) => reservation.id),
    movedSongRequestIds: movedSongRequests.map((request) => request.id),
    movedBenefitRedemptionIds: movedBenefitRedemptions.map((redemption) => redemption.id),
  }
  state.tableTransfers.push(record)
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'table.transferred.v1',
    objectType: 'tableTransfer',
    objectId: record.id,
    occurredAt,
    details: { ...structuredClone(record) },
  })
  state.revision += 1
  return record
}

function assertSessionCanClose(state: RuntimeState, tableId: string, tableSessionId: string) {
  const openKds = state.orderDomain.kdsTasks.filter((task) =>
    task.tableSessionId === tableSessionId && task.status !== 'delivered',
  )
  if (openKds.length > 0) throw new Error(`仍有${openKds.length}项商品未送达，不能结台`)

  const openTasks = state.tasks.filter((task) => task.tableId === tableId && openTaskStatuses.has(task.status))
  if (openTasks.length > 0) throw new Error(`仍有${openTasks.length}项服务任务未关闭，不能结台`)

  const lockedBenefits = state.benefitRedemptions.filter((item) =>
    item.tableSessionId === tableSessionId && item.status === 'locked',
  )
  if (lockedBenefits.length > 0) throw new Error(`仍有${lockedBenefits.length}项权益锁定未处理，不能结台`)

  const pendingRefunds = state.paymentDomain.refunds.filter((refund) =>
    refund.tableSessionId === tableSessionId && pendingRefundStatuses.has(refund.status),
  )
  if (pendingRefunds.length > 0) throw new Error(`仍有${pendingRefunds.length}笔退款处理中，不能结台`)

  const orders = state.orderDomain.orders.filter((order) => order.tableSessionId === tableSessionId)
  if (orders.some((order) => ['draft', 'authorization_pending'].includes(order.status))) {
    throw new Error('桌次仍有草稿或待授权订单，不能结台')
  }
  const confirmedIntents = state.paymentDomain.paymentIntents.filter((intent) =>
    intent.tableSessionId === tableSessionId && confirmedPaymentStatuses.has(intent.status),
  )
  const completedRefunds = state.paymentDomain.refunds.filter((refund) =>
    refund.tableSessionId === tableSessionId && refund.status === 'succeeded',
  )
  for (const order of orders) {
    for (const item of order.items) {
      const paidQuantity = confirmedIntents.flatMap((intent) => intent.lineAllocations)
        .filter((allocation) => allocation.orderId === order.id && allocation.orderItemId === item.id)
        .reduce((sum, allocation) => sum + allocation.quantity, 0)
      const refundedQuantity = completedRefunds.flatMap((refund) => refund.items)
        .filter((refundItem) => refundItem.orderId === order.id && refundItem.orderItemId === item.id)
        .reduce((sum, refundItem) => sum + refundItem.quantity, 0)
      if (paidQuantity < item.quantity - refundedQuantity) {
        throw new Error(`商品“${item.name}”尚未完成收款，不能结台`)
      }
    }
  }
}

export function registerTableSessionRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get<{ Params: { tableId: string } }>('/api/tables/:tableId/session-summary', async (request) => {
    const state = await repository.read()
    requireTableDataScope(request, state, request.params.tableId, 'table.session.view')
    const table = state.tables.find((candidate) => candidate.id === request.params.tableId)
    if (!table || table.status !== 'occupied') throw new Error('桌台当前没有营业桌次')
    return tableSessionSummary(state, currentOpenTableSession(state, table.id))
  })

  app.put('/api/table-operations/config', async (request) => {
    const input = tableOperationsConfigInputSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'config.write')
      const replay = state.auditEntries.find((entry) =>
        entry.action === 'table_operations.config_updated.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (replay) {
        if (
          JSON.stringify(replay.details.minimumSpendRules) !== JSON.stringify(input.minimumSpendRules) ||
          JSON.stringify(replay.details.reminder) !== JSON.stringify(input.reminder) ||
          replay.details.reason !== input.reason
        ) {
          throw new Error('幂等键已用于不同桌台经营配置')
        }
        return tableOperationsConfig(state)
      }
      validateTableOperationsConfig(state, input.minimumSpendRules)
      const occurredAt = new Date().toISOString()
      const previous = tableOperationsConfig(state)
      state.tableOperationsConfig = {
        version: previous.version + 1,
        updatedAt: occurredAt,
        reminder: structuredClone(input.reminder),
        minimumSpendRules: structuredClone(input.minimumSpendRules),
      }
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'table_operations.config_updated.v1',
        objectType: 'tableOperationsConfig',
        objectId: state.store.id,
        occurredAt,
        details: {
          previousVersion: previous.version,
          version: state.tableOperationsConfig.version,
          reason: input.reason,
          reminder: structuredClone(input.reminder),
          minimumSpendRules: structuredClone(input.minimumSpendRules),
          idempotencyKey: input.idempotencyKey,
        },
      })
      state.revision += 1
      return state.tableOperationsConfig
    })
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/walk-in-open', async (request, reply) => {
    const input = walkInOpenSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      requireTableDataScope(request, state, request.params.tableId, 'reservation.manage')
      const replay = state.auditEntries.find((entry) =>
        entry.action === 'table.walk_in_opened.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (replay) {
        if (replay.objectId !== request.params.tableId) throw new Error('幂等键已用于其他桌台')
        const table = state.tables.find((candidate) => candidate.id === request.params.tableId)
        const session = state.songState.tableSessions.find((candidate) => candidate.id === replay.details.tableSessionId)
        const reservation = reservationsFor(state).reservations.find((candidate) => candidate.id === replay.details.reservationId)
        if (!table || !session || !reservation) throw new Error('临客开台幂等记录不完整')
        return { table, reservation, summary: tableSessionSummary(state, session) }
      }
      const table = assertTablePrimaryReady(state, request.params.tableId)
      if (table.status !== 'available') throw new Error('只有空桌可以临客开台')
      if (input.partySize > table.capacity) throw new Error(`到店人数超过桌台容量：${input.partySize}/${table.capacity}`)
      const occurredAt = new Date().toISOString()
      const reservationId = `walk-in:${randomUUID()}`
      const customerReference = input.customerReference ?? reservationId
      const reservation = mutateReservationState(state, (domain) => {
        createReservation(domain, {
          reservationId,
          customerReference,
          customerName: input.customerName,
          contactReference: customerReference,
          sourceCode: 'walk_in',
          partySize: input.partySize,
          areaPreferenceCode: table.areaId,
          scheduledAt: occurredAt,
          depositRequiredAmount: 0,
          depositCurrency: 'CNY',
          actorId: actor.actorId,
          occurredAt,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'create'),
        })
        confirmReservation(domain, {
          reservationId, actorId: actor.actorId, occurredAt,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'confirm'),
        })
        markReservationArrived(domain, {
          reservationId, actorId: actor.actorId, occurredAt,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'arrive'),
        })
        const session = openTableSession(state, table, occurredAt, { source: 'walk_in', sourceId: reservationId })
        return seatReservation(domain, {
          reservationId, actorId: actor.actorId, occurredAt, tableId: table.id, tableCode: table.code,
          tableSessionId: session.id, idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'seat'),
        })
      })
      const session = currentOpenTableSession(state, table.id)
      table.status = 'occupied'
      table.guestCount = input.partySize
      table.openedAt = occurredAt
      recordSalesAttribution(state, {
        subjectType: 'reservation', subjectId: reservation.id, salesEmployeeId: input.salesEmployeeId,
        actorId: actor.actorId, reason: '临客开台指定销售', occurredAt,
        idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'reservation-sales'),
      })
      recordSalesAttribution(state, {
        subjectType: 'walk_in', subjectId: reservation.id, salesEmployeeId: input.salesEmployeeId,
        actorId: actor.actorId, reason: '临客开台指定销售', occurredAt,
        idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'walkin-sales'),
      })
      recordSalesAttribution(state, {
        subjectType: 'table_session', subjectId: session.id, salesEmployeeId: input.salesEmployeeId,
        actorId: actor.actorId, reason: '临客开台继承销售归属', occurredAt,
        idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'session-sales'),
      })
      if (state.config.proactiveOrderCare.enabled) {
        startAwaitingOrder(state, table.id, actor.actorId, `walk-in-open:${reservation.id}`, new Date(occurredAt))
      }
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'table.walk_in_opened.v1',
        objectType: 'table',
        objectId: table.id,
        occurredAt,
        details: {
          reservationId: reservation.id,
          tableSessionId: session.id,
          guestCount: input.partySize,
          salesEmployeeId: input.salesEmployeeId,
          idempotencyKey: input.idempotencyKey,
        },
      })
      state.revision += 1
      return { table, reservation, summary: tableSessionSummary(state, session) }
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { sessionId: string } }>('/api/table-sessions/:sessionId/sales-attribution', async (request) => {
    const input = salesAttributionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'table.write')
      const session = state.songState.tableSessions.find((candidate) => candidate.id === request.params.sessionId)
      if (!session || session.status !== 'open') throw new Error('只能修改开放桌次的销售归属')
      requireTableDataScope(request, state, session.tableId, 'table.write')
      const before = state.salesAttributionRecords?.length ?? 0
      const record = recordSalesAttribution(state, {
        subjectType: 'table_session', subjectId: session.id, salesEmployeeId: input.salesEmployeeId,
        actorId: actor.actorId, reason: input.reason, occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if ((state.salesAttributionRecords?.length ?? 0) > before) state.revision += 1
      return record
    })
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/combinations', async (request) => {
    const input = tableCombinationSchema.parse(request.body)
    return repository.mutate((state) => {
      state.tableCombinationRecords ??= []
      const actor = requireConfiguredOperation(request, state, 'table.write')
      requireTableDataScope(request, state, request.params.tableId, 'table.write')
      const replay = state.tableCombinationRecords.find((record) => record.idempotencyKey === input.idempotencyKey)
      if (replay) {
        const sameRequest = replay.action === input.action && replay.reason === input.reason && (
          input.action === 'split_back' ? replay.linkId === input.linkId : replay.relatedTableId === input.targetTableId
        )
        if (!sameRequest) throw new Error('幂等键已用于不同桌组操作')
        return replay
      }
      const occurredAt = new Date().toISOString()
      let record: TableCombinationRecord

      if (input.action === 'split_back') {
        const active = activeTableCombinationLinks(state).find((candidate) => candidate.linkId === input.linkId)
        if (!active) throw new Error('桌组关系不存在或已经拆回')
        if (![active.primaryTableId, active.relatedTableId].includes(request.params.tableId)) {
          throw new Error('当前桌台不属于该桌组关系')
        }
        requireTableDataScope(request, state, active.relatedTableId, 'table.write')
        if (active.kind === 'add_table') {
          assertAddedTableCanSplit(state, active)
          const relatedTable = state.tables.find((table) => table.id === active.relatedTableId)
          const relatedSession = state.songState.tableSessions.find((session) => session.id === active.relatedTableSessionId)
          if (!relatedTable || !relatedSession || relatedSession.status !== 'open') throw new Error('加桌当前状态不完整，不能拆回')
          const activeCare = state.awaitingOrderIntents.find((intent) => intent.tableId === relatedTable.id && intent.status === 'active')
          if (activeCare) stopAwaitingOrder(state, relatedTable.id, actor.actorId, 'added_table_split_back')
          relatedSession.status = 'closed'
          relatedSession.closedAt = occurredAt
          relatedTable.status = 'available'
          relatedTable.guestCount = 0
          relatedTable.openedAt = null
        }
        record = {
          ...structuredClone(active),
          id: `table-combination:${randomUUID()}`,
          action: 'split_back',
          actorId: actor.actorId,
          reason: input.reason,
          occurredAt,
          idempotencyKey: input.idempotencyKey,
        }
      } else {
        if (request.params.tableId === input.targetTableId) throw new Error('目标桌不能与主桌相同')
        const primaryTable = state.tables.find((table) => table.id === request.params.tableId)
        const relatedTable = state.tables.find((table) => table.id === input.targetTableId)
        if (!primaryTable || primaryTable.status !== 'occupied') throw new Error('只有营业中的桌台可以作为主桌')
        if (!relatedTable) throw new Error('目标桌台不存在')
        requireTableDataScope(request, state, relatedTable.id, 'table.write')
        const activeLinks = activeTableCombinationLinks(state)
        if (activeLinks.some((link) => link.relatedTableId === primaryTable.id)) throw new Error('当前桌是其他桌组的关联桌，不能再作为主桌')
        if (activeLinks.some((link) => [link.primaryTableId, link.relatedTableId].includes(relatedTable.id))) {
          throw new Error('目标桌已经在其他合台/加桌关系中')
        }
        const primarySession = currentOpenTableSession(state, primaryTable.id)
        let relatedSession
        if (input.action === 'merge') {
          if (relatedTable.status !== 'occupied') throw new Error('合台目标必须是营业中的桌台；空桌请使用加桌')
          relatedSession = currentOpenTableSession(state, relatedTable.id)
        } else {
          assertTablePrimaryReady(state, relatedTable.id)
          if (relatedTable.status !== 'available') throw new Error('加桌目标必须是空桌')
          relatedSession = openTableSession(state, relatedTable, occurredAt, { source: 'added_table', sourceId: primarySession.id })
          relatedTable.status = 'occupied'
          relatedTable.guestCount = 0
          relatedTable.openedAt = occurredAt
          const salesEmployeeId = currentSalesEmployeeId(state, 'table_session', primarySession.id)
          if (salesEmployeeId) {
            recordSalesAttribution(state, {
              subjectType: 'table_session', subjectId: relatedSession.id, salesEmployeeId,
              actorId: actor.actorId, reason: '加桌继承主桌销售归属', occurredAt,
              idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'added-sales'),
            })
          }
        }
        record = {
          id: `table-combination:${randomUUID()}`,
          linkId: `table-link:${randomUUID()}`,
          action: input.action,
          kind: input.action,
          primaryTableId: primaryTable.id,
          primaryTableCode: primaryTable.code,
          primaryTableSessionId: primarySession.id,
          relatedTableId: relatedTable.id,
          relatedTableCode: relatedTable.code,
          relatedTableSessionId: relatedSession.id,
          actorId: actor.actorId,
          reason: input.reason,
          occurredAt,
          idempotencyKey: input.idempotencyKey,
        }
      }

      state.tableCombinationRecords.push(record)
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: `table.combination.${record.action}.v1`,
        objectType: 'tableCombination',
        objectId: record.linkId,
        occurredAt,
        details: { ...structuredClone(record) },
      })
      state.revision += 1
      return record
    })
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/transfer', async (request) => {
    const input = transferTableSessionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'table.write')
      requireTableDataScope(request, state, request.params.tableId, 'table.write')
      requireTableDataScope(request, state, input.targetTableId, 'table.write')
      return transferOpenTableSession(state, request.params.tableId, input, actor.actorId, new Date().toISOString())
    })
  })

  app.post<{ Params: { tableId: string } }>('/api/tables/:tableId/close', async (request) => {
    const input = closeTableSessionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'table.close')
      requireTableDataScope(request, state, request.params.tableId, 'table.close')
      const replay = state.auditEntries.find((entry) =>
        entry.action === 'table.closed.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (replay) {
        if (replay.objectId !== request.params.tableId) throw new Error('幂等键已用于其他桌台')
        return state.tables.find((table) => table.id === request.params.tableId)
      }
      const table = state.tables.find((item) => item.id === request.params.tableId)
      if (!table || table.status !== 'occupied') throw new Error('只有营业中的桌台可以结台')
      const session = currentOpenTableSession(state, table.id)
      const combinations = currentCombinationForTable(state, table.id)
      if (combinations.length > 0) throw new Error('桌台仍在合台/加桌关系中，请先拆回再结台')
      assertSessionCanClose(state, table.id, session.id)
      const summary = tableSessionSummary(state, session)
      if (summary.differenceAmount > 0) {
        if (!input.minimumSpendWaiver) {
          throw new Error(`当前消费${summary.spendAmount}分，距低消还差${summary.differenceAmount}分；需要经理填写原因后豁免`)
        }
        if (!['manager', 'owner'].includes(actor.roleId)) throw new Error('只有经理或店主可以豁免低消差额')
        state.auditEntries.push({
          id: `audit_${randomUUID()}`,
          actorId: actor.actorId,
          action: 'table.minimum_spend_waived.v1',
          objectType: 'tableSession',
          objectId: session.id,
          occurredAt: new Date().toISOString(),
          details: {
            minimumSpendAmount: summary.minimumSpendAmount,
            spendAmount: summary.spendAmount,
            differenceAmount: summary.differenceAmount,
            configVersion: summary.configVersion,
            ruleName: summary.ruleName,
            reason: input.minimumSpendWaiver.reason,
            idempotencyKey: input.idempotencyKey,
          },
        })
      }
      const activeCare = state.awaitingOrderIntents.find((intent) => intent.tableId === table.id && intent.status === 'active')
      if (activeCare) stopAwaitingOrder(state, table.id, actor.actorId, 'table_closed')
      const closedAt = new Date().toISOString()
      session.status = 'closed'
      session.closedAt = closedAt
      table.status = 'available'
      table.guestCount = 0
      table.openedAt = null
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'table.closed.v1',
        objectType: 'table',
        objectId: table.id,
        occurredAt: closedAt,
        details: { tableSessionId: session.id, reason: input.reason, idempotencyKey: input.idempotencyKey },
      })
      state.revision += 1
      return table
    })
  })
}
