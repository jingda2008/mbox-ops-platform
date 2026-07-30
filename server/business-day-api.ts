import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  reviewCashierHandoverSchema,
  submitCashierHandoverSchema,
} from '../src/shared/payment-api.js'
import type { PaymentSettlementView, SettlementChannel } from '../src/shared/payment-contracts.js'
import { requireConfiguredOperation } from './authorization.js'
import {
  buildSettlementChannelSummaries,
  closeCashierHandover,
  handoverSnapshotMatches,
  latestCashierHandover,
  reviewCashierHandover,
  submitCashierHandover,
} from './payment-domain.js'
import type { RuntimeRepository } from './repository.js'
import { clearPresenceLeases } from './presence.js'
import type { ShiftAssignment, StaffPermissionId } from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { requireRequestActor } from './auth-context.js'
import { AuthorizationError } from './authorization.js'
import {
  isKdsTaskOperationallyClosed,
  isServiceTaskOperationallyClosed,
  isSongRequestOperationallyClosed,
} from './operational-closure.js'
import { isCurrentBusinessDateTableSession, tableSessionBusinessDate } from './table-sessions.js'
import { archiveServiceTasksForTableSession } from './domain.js'
import { cancelSongRequest } from './song-domain.js'
import { chinaBusinessDateKey } from '../src/shared/china-time.js'

const closeSchema = z.object({
  nextBusinessDate: z.iso.date(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

type RuntimeState = Awaited<ReturnType<RuntimeRepository['read']>>
type Blocker = { kind: string; id: string; detail: string }

export interface BusinessDayArchiveSummary {
  serviceTasks: number
  kdsTasks: number
  tableSessions: number
  awaitingOrderIntents: number
  songRequests: number
  reservations: number
  waitlistEntries: number
  sopExecutions: number
  sopActions: number
  dutyIncidents: number
  orderAuthorizations: number
  benefitLocks: number
  stockCounts: number
  inventoryApprovals: number
  hardwareCommands: number
  printJobs: number
}

export interface ShiftContinuityResult {
  source: 'existing' | 'copied'
  shiftIds: string[]
}

function shiftedTimestamp(timestamp: string, currentBusinessDate: string, nextBusinessDate: string) {
  const current = Date.parse(`${currentBusinessDate}T00:00:00.000Z`)
  const next = Date.parse(`${nextBusinessDate}T00:00:00.000Z`)
  return new Date(Date.parse(timestamp) + (next - current)).toISOString()
}

function rolloverShiftId(state: RuntimeState, sourceId: string, nextBusinessDate: string) {
  const base = `shift_rollover_${nextBusinessDate}_${sourceId}`
  const ids = new Set(state.shiftAssignments.map((shift) => shift.id))
  if (!ids.has(base)) return base
  let suffix = 2
  while (ids.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export function prepareNextBusinessDayShifts(
  state: RuntimeState,
  currentBusinessDate: string,
  nextBusinessDate: string,
): ShiftContinuityResult {
  const activeEmployeeIds = new Set(
    state.employees.filter((employee) => employee.status === 'active').map((employee) => employee.id),
  )
  const existing = state.shiftAssignments.filter((shift) => (
    shift.businessDate === nextBusinessDate
    && ['scheduled', 'active'].includes(shift.status)
    && activeEmployeeIds.has(shift.employeeId)
  ))
  if (existing.length > 0) {
    for (const shift of existing) shift.status = 'active'
    return { source: 'existing', shiftIds: existing.map((shift) => shift.id) }
  }

  const current = state.shiftAssignments.filter((shift) => (
    shift.businessDate === currentBusinessDate
    && shift.status === 'active'
    && activeEmployeeIds.has(shift.employeeId)
  ))
  if (current.length === 0) throw new Error('下一营业日无排班，且当前营业日无可复制的有效班次')

  const copies: ShiftAssignment[] = current.map((shift) => ({
    ...structuredClone(shift),
    id: rolloverShiftId(state, shift.id, nextBusinessDate),
    businessDate: nextBusinessDate,
    startAt: shiftedTimestamp(shift.startAt, currentBusinessDate, nextBusinessDate),
    endAt: shiftedTimestamp(shift.endAt, currentBusinessDate, nextBusinessDate),
    status: 'active',
  }))
  state.shiftAssignments.push(...copies)
  return { source: 'copied', shiftIds: copies.map((shift) => shift.id) }
}

export function collectBlockers(state: RuntimeState, closingActorId: string) {
  const blockers: Blocker[] = []
  const currentSessionIds = new Set(state.songState.tableSessions
    .filter((session) => isCurrentBusinessDateTableSession(state, session))
    .map((session) => session.id))
  const currentPaymentIntentIds = new Set(state.paymentDomain.paymentIntents
    .filter((intent) => currentSessionIds.has(intent.tableSessionId) || intent.businessDate === state.store.businessDate)
    .map((intent) => intent.id))
  for (const task of state.tasks.filter((item) => (
    !isServiceTaskOperationallyClosed(item)
    && (item.tableSessionId ? currentSessionIds.has(item.tableSessionId) : true)
  ))) {
    blockers.push({ kind: 'open_service_task', id: task.id, detail: `${task.serviceTypeId}:${task.status}` })
  }
  for (const task of state.orderDomain.kdsTasks.filter((item) => (
    currentSessionIds.has(item.tableSessionId) && !isKdsTaskOperationallyClosed(state.orderDomain, item)
  ))) {
    blockers.push({ kind: 'undelivered_kds', id: task.id, detail: `${task.stationId}:${task.status}` })
  }
  for (const session of state.songState.tableSessions.filter((item) => item.status === 'open')) {
    const stale = !isCurrentBusinessDateTableSession(state, session)
    blockers.push({
      kind: stale ? 'legacy_table_session_handover_required' : 'open_table_session',
      id: session.id,
      detail: stale ? `${session.tableCode}:${tableSessionBusinessDate(state, session)}->${state.store.businessDate}` : session.tableCode,
    })
  }
  for (const intent of state.paymentDomain.paymentIntents.filter((item) => (
    currentPaymentIntentIds.has(item.id) && ['pending', 'processing'].includes(item.status)
  ))) {
    blockers.push({ kind: 'unresolved_payment', id: intent.id, detail: intent.status })
  }
  for (const refund of state.paymentDomain.refunds.filter((item) => (
    currentPaymentIntentIds.has(item.paymentIntentId) && ['requested', 'approved', 'processing'].includes(item.status)
  ))) {
    blockers.push({ kind: 'unresolved_refund', id: refund.id, detail: refund.status })
  }
  for (const request of state.songState.requests.filter((item) => (
    currentSessionIds.has(item.tableSessionId) && !isSongRequestOperationallyClosed(item)
  ))) {
    blockers.push({ kind: 'active_song_request', id: request.id, detail: `${request.tableCode}:${request.status}` })
  }
  for (const redemption of state.benefitRedemptions.filter((item) => (
    currentSessionIds.has(item.tableSessionId) && item.status === 'locked'
  ))) {
    blockers.push({ kind: 'locked_benefit', id: redemption.id, detail: redemption.tableSessionId })
  }
  for (const reservation of state.reservationState?.reservations ?? []) {
    if (
      reservationBusinessDate(state.reservationState!, reservation.scheduledAt) === state.store.businessDate
      && ['payment_required', 'payment_intent_recorded', 'refund_required', 'refund_processing', 'refund_failed'].includes(reservation.deposit.status)
    ) {
      blockers.push({ kind: 'unresolved_reservation_deposit', id: reservation.id, detail: reservation.deposit.status })
    }
  }
  for (const entry of state.waitlistEntries.filter((item) => ['waiting', 'notified'].includes(item.status))) {
    blockers.push({ kind: 'open_waitlist_entry', id: entry.id, detail: `${entry.status}:${entry.customerName}` })
  }
  const handover = latestCashierHandover(state.paymentDomain, state.store.businessDate)
  if (!handover) {
    blockers.push({ kind: 'cashier_handover_missing', id: state.store.businessDate, detail: '收银尚未提交交班' })
  } else if (handover.status !== 'approved') {
    blockers.push({ kind: 'cashier_handover_not_approved', id: handover.id, detail: handover.status })
  } else {
    if (handover.reviewedBy !== closingActorId) {
      blockers.push({ kind: 'manager_review_session_mismatch', id: handover.id, detail: '必须由完成复核的经理会话切日' })
    }
    if (!handoverSnapshotMatches(state.paymentDomain, handover)) {
      blockers.push({ kind: 'cashier_handover_stale', id: handover.id, detail: '复核后账务数据已变化' })
    }
  }
  return blockers
}

function isFinancialCloseBlocker(state: RuntimeState, blocker: Blocker) {
  if ([
    'unresolved_payment',
    'unresolved_refund',
    'locked_benefit',
    'cashier_handover_missing',
    'cashier_handover_not_approved',
    'manager_review_session_mismatch',
    'cashier_handover_stale',
  ].includes(blocker.kind)) return true
  if (blocker.kind === 'unresolved_reservation_deposit') return blocker.detail !== 'payment_required'
  if (blocker.kind !== 'active_song_request') return false
  return state.songState.requests.some((request) => (
    request.id === blocker.id && ['paid', 'accepted', 'performing', 'refund_required'].includes(request.status)
  ))
}

function shiftedBusinessDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function reservationBusinessDate(reservationState: NonNullable<RuntimeState['reservationState']>, scheduledAt: string) {
  const hours = reservationState.config.businessHours
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(scheduledAt))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  const date = `${part('year')}-${part('month')}-${part('day')}`
  const minutes = Number(part('hour')) * 60 + Number(part('minute'))
  const [openingHour = 0, openingMinute = 0] = hours.openingTime.split(':').map(Number)
  const [closingHour = 0, closingMinute = 0] = hours.closingTime.split(':').map(Number)
  const opening = openingHour * 60 + openingMinute
  const closing = closingHour * 60 + closingMinute
  return closing < opening && minutes < closing ? shiftedBusinessDate(date, -1) : date
}

/** Removes closed-day work from live queues while preserving every record for analysis and audit. */
export function archiveBusinessDayOperations(
  state: RuntimeState,
  closedBusinessDate: string,
  occurredAt: string,
  actorId: string,
): BusinessDayArchiveSummary {
  const summary: BusinessDayArchiveSummary = {
    serviceTasks: 0, kdsTasks: 0, tableSessions: 0, awaitingOrderIntents: 0, songRequests: 0,
    reservations: 0, waitlistEntries: 0, sopExecutions: 0, sopActions: 0, dutyIncidents: 0,
    orderAuthorizations: 0, benefitLocks: 0, stockCounts: 0, inventoryApprovals: 0,
    hardwareCommands: 0, printJobs: 0,
  }

  for (const intent of state.awaitingOrderIntents.filter((item) => item.status === 'active')) {
    intent.status = 'cancelled'
    intent.stoppedAt = occurredAt
    intent.stoppedBy = actorId
    intent.stopReason = 'business_day_closed'
    intent.nextReminderAt = null
    summary.awaitingOrderIntents += 1
  }

  const openSessionIds = new Set(state.songState.tableSessions.filter((session) => session.status === 'open').map((session) => session.id))
  const closingOrderIds = new Set(state.orderDomain.orders
    .filter((order) => openSessionIds.has(order.tableSessionId))
    .map((order) => order.id))

  for (const authorization of state.orderDomain.authorizations.filter((item) => (
    item.status === 'pending' && closingOrderIds.has(item.orderId)
  ))) {
    authorization.status = 'rejected'
    authorization.decidedBy = actorId
    authorization.decidedAt = occurredAt
    authorization.decisionReason = `营业日${closedBusinessDate}结束，待审批操作自动终止`
    summary.orderAuthorizations += 1
  }

  for (const redemption of state.benefitRedemptions.filter((item) => (
    item.status === 'locked' && openSessionIds.has(item.tableSessionId)
  ))) {
    const benefit = state.memberBenefits.find((item) => item.id === redemption.memberBenefitId)
    if (benefit?.status === 'locked') {
      benefit.status = Date.parse(occurredAt) > Date.parse(benefit.validUntil) ? 'expired' : 'available'
    }
    redemption.status = 'cancelled'
    redemption.cancelledBy = actorId
    redemption.cancelledAt = occurredAt
    redemption.cancelReason = `营业日${closedBusinessDate}结束，未核销权益自动释放`
    redemption.cancelIdempotencyKey = `business-close-benefit-${closedBusinessDate}-${redemption.id}`
    redemption.cancelFingerprint = `business_day_closed:${closedBusinessDate}`
    summary.benefitLocks += 1
  }

  if (state.inventoryDomain) {
    for (const count of state.inventoryDomain.stockCounts.filter((item) => (
      item.businessDate === closedBusinessDate && item.status === 'pending_confirmation'
    ))) {
      count.status = 'rejected'
      count.confirmedBy = actorId
      count.confirmedAt = occurredAt
      count.decisionReason = `营业日${closedBusinessDate}结束，盘点差异未复核`
      summary.stockCounts += 1
    }
    for (const approval of state.inventoryDomain.approvalRequests.filter((item) => (
      item.status === 'pending' && chinaBusinessDateKey(item.requestedAt, state.tableOperationsConfig?.businessDayRolloverHour ?? 6) === closedBusinessDate
    ))) {
      approval.status = 'rejected'
      approval.decision = 'reject'
      approval.decidedBy = {
        employeeId: actorId,
        displayName: '系统日结',
        roleId: 'manager',
        authenticatedBy: 'local_header',
      }
      approval.decidedAt = occurredAt
      approval.decisionReason = `营业日${closedBusinessDate}结束，待审批库存操作自动终止`
      approval.decisionIdempotencyKey = `business-close-inventory-${closedBusinessDate}-${approval.id}`
      summary.inventoryApprovals += 1
    }
  }

  for (const command of (state.hardwareState?.commands ?? []).filter((item) => (
    item.status === 'queued'
    && chinaBusinessDateKey(item.requestedAt, state.tableOperationsConfig?.businessDayRolloverHour ?? 6) === closedBusinessDate
  ))) {
    command.status = 'failed'
    command.completedAt = occurredAt
    command.resultMessage = `营业日${closedBusinessDate}结束前未收到设备回执`
    summary.hardwareCommands += 1
  }

  for (const job of (state.commercialOps?.printJobs ?? []).filter((item) => (
    item.status === 'queued' && closingOrderIds.has(item.orderId)
  ))) {
    job.status = 'failed'
    job.updatedAt = occurredAt
    job.lastError = `营业日${closedBusinessDate}结束前未完成打印`
    summary.printJobs += 1
  }
  for (const sessionId of openSessionIds) {
    const archived = archiveServiceTasksForTableSession(
      state, sessionId, occurredAt, actorId, `营业日${closedBusinessDate}结束归档`,
    )
    for (const task of archived.filter((item) => item.archiveOutcome === 'unresolved')) {
      task.resolution = '营业日结束时需求仍未完成'
    }
    summary.serviceTasks += archived.length
  }
  for (const task of state.tasks.filter((item) => !item.archivedAt)) {
    const previousStatus = task.status
    task.archivedAt = occurredAt
    task.archiveOutcome = isServiceTaskOperationallyClosed(task) ? 'resolved' : 'unresolved'
    task.archivedFromStatus = previousStatus
    task.updatedAt = occurredAt
    if (!isServiceTaskOperationallyClosed(task)) task.status = 'cancelled'
    if (!task.resolution && task.archiveOutcome === 'unresolved') task.resolution = '营业日结束时需求仍未完成'
    state.taskEvents.push({
      id: `event_${randomUUID()}`, taskId: task.id, type: 'task.archived_with_business_day.v1', actorId, occurredAt,
      payload: { closedBusinessDate, previousStatus, archiveOutcome: task.archiveOutcome },
    })
    summary.serviceTasks += 1
  }

  for (const task of state.orderDomain.kdsTasks.filter((item) => !isKdsTaskOperationallyClosed(state.orderDomain, item))) {
    const existingReport = task.exceptionEvents?.find((event) => (
      event.type === 'reported'
      && !task.exceptionEvents?.some((candidate) => candidate.type === 'manager_disposition' && candidate.exceptionId === event.exceptionId)
    ))
    const exceptionId = existingReport?.exceptionId ?? `business_close_exception_${randomUUID()}`
    const originalOrderItemId = task.remakeOf?.orderItemId ?? task.orderItemId
    const originalKdsTaskId = task.remakeOf?.kdsTaskId ?? task.id
    task.exceptionEvents ??= []
    if (!existingReport) {
      task.exceptionEvents.push({
        id: `business_close_report_${randomUUID()}`, exceptionId, type: 'reported', exceptionKind: 'production_rejection',
        reasonCode: 'other', reasonNote: `营业日${closedBusinessDate}结束时未完成，系统归档`, orderId: task.orderId,
        orderItemId: task.orderItemId, kdsTaskId: task.id, originalOrderItemId, originalKdsTaskId,
        actorId, actorRoleId: 'manager', occurredAt, managerDisposition: null, remakeKdsTaskId: null,
      })
    }
    task.exceptionEvents.push({
      id: `business_close_disposition_${randomUUID()}`, exceptionId, type: 'manager_disposition', exceptionKind: existingReport?.exceptionKind ?? 'production_rejection',
      reasonCode: 'manager_cancelled', reasonNote: `营业日${closedBusinessDate}结束归档，未按送达统计`, orderId: task.orderId,
      orderItemId: task.orderItemId, kdsTaskId: task.id, originalOrderItemId, originalKdsTaskId,
      actorId, actorRoleId: 'manager', occurredAt, managerDisposition: 'cancelled', remakeKdsTaskId: null,
    })
    if (task.deliveryServiceTask && !['completed', 'confirmed', 'cancelled'].includes(task.deliveryServiceTask.status)) {
      task.deliveryServiceTask.status = 'cancelled'
    }
    summary.kdsTasks += 1
  }

  for (const request of state.songState.requests.filter((item) => ['pending_confirmation', 'pending_payment'].includes(item.status))) {
    cancelSongRequest(state.songState, {
      requestId: request.id,
      actor: { actorId, role: 'manager' },
      reason: `营业日${closedBusinessDate}结束，未确认点歌自动归档`,
      occurredAt,
      idempotencyKey: `business-close-song-${closedBusinessDate}-${request.id}`,
    })
    summary.songRequests += 1
  }

  for (const session of state.songState.tableSessions.filter((item) => item.status === 'open')) {
    session.status = 'closed'
    session.closedAt = occurredAt
    summary.tableSessions += 1
  }
  for (const table of state.tables) {
    if (!['occupied', 'reserved'].includes(table.status)) continue
    table.status = 'available'
    table.guestCount = 0
    table.openedAt = null
  }

  const reservationState = state.reservationState
  if (reservationState) {
    for (const reservation of reservationState.reservations.filter((item) => (
      ['requested', 'confirmed', 'arrived'].includes(item.status)
      && reservationBusinessDate(reservationState, item.scheduledAt) <= closedBusinessDate
    ))) {
      const previousStatus = reservation.status
      reservation.status = 'no_show'
      reservation.noShowAt = occurredAt
      reservation.cancellationReason = '营业日结束时未完成入座'
      reservation.holdStatus = 'released'
      reservation.holdUntil = null
      reservation.updatedAt = occurredAt
      reservation.revision += 1
      reservationState.auditEvents.push({
        tenantId: reservationState.tenantId, storeId: reservationState.storeId,
        id: `reservation-event:${reservation.id}:${reservationState.auditEvents.length + 1}`,
        reservationId: reservation.id, type: 'reservation.no_show.v1', actorId, fromStatus: previousStatus,
        toStatus: 'no_show', depositFromStatus: reservation.deposit.status, depositToStatus: reservation.deposit.status,
        occurredAt, reason: '营业日结束时未完成入座', details: { closedBusinessDate, automaticClosure: true },
      })
      summary.reservations += 1
    }
  }

  for (const entry of state.waitlistEntries.filter((item) => ['waiting', 'notified'].includes(item.status))) {
    const previousStatus = entry.status
    entry.status = 'expired'
    entry.closedAt = occurredAt
    entry.closeReason = `营业日结束自动归档，原状态${previousStatus}`
    entry.heldTableId = null
    entry.heldTableCode = null
    entry.responseExpiresAt = null
    entry.updatedAt = occurredAt
    entry.revision += 1
    summary.waitlistEntries += 1
  }

  const cancelledExecutionIds = new Set<string>()
  for (const execution of (state.sopExecutions ?? []).filter((item) => ['active', 'blocked'].includes(item.status))) {
    const previousStatus = execution.status
    execution.status = 'cancelled'
    execution.updatedAt = occurredAt
    execution.completedAt = occurredAt
    execution.stoppedReason = `business_day_closed:${closedBusinessDate}:from_${previousStatus}`
    cancelledExecutionIds.add(execution.id)
    summary.sopExecutions += 1
  }
  for (const record of (state.sopActionRecords ?? []).filter((item) => (
    cancelledExecutionIds.has(item.executionId) && item.status !== 'completed' && item.status !== 'cancelled'
  ))) {
    const previousStatus = record.status
    record.status = 'cancelled'
    record.completedAt = occurredAt
    record.completedBy = 'system'
    record.resolutionNote = `营业日${closedBusinessDate}结束归档，原状态${previousStatus}`
    record.leaseOwner = null
    record.leaseExpiresAt = null
    summary.sopActions += 1
  }

  for (const incident of (state.dutyManagerIncidents ?? []).filter((item) => item.status !== 'resolved')) {
    incident.status = 'resolved'
    incident.resolvedAt = occurredAt
    incident.resolvedBy = 'system'
    incident.resolution = 'source_cleared'
    summary.dutyIncidents += 1
  }

  for (const performance of state.songState.performanceSessions.filter((item) => (
    item.businessDate === closedBusinessDate && ['scheduled', 'live'].includes(item.status)
  ))) {
    performance.status = performance.status === 'live' ? 'completed' : 'cancelled'
  }
  return summary
}

function settlementView(state: RuntimeState, businessDate: string): PaymentSettlementView {
  const latestHandover = latestCashierHandover(state.paymentDomain, businessDate)
  const actualAmounts = latestHandover
    ? Object.fromEntries(latestHandover.channels.map((item) => [item.channel, item.confirmedActualAmount])) as Record<SettlementChannel, number>
    : undefined
  return {
    businessDate,
    channels: buildSettlementChannelSummaries(state.paymentDomain, businessDate, actualAmounts),
    latestHandover,
    canClose: Boolean(
      latestHandover?.status === 'approved'
      && handoverSnapshotMatches(state.paymentDomain, latestHandover),
    ),
  }
}

function audit(
  state: RuntimeState,
  actorId: string,
  action: string,
  objectId: string,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType: 'cashierHandover',
    objectId,
    occurredAt: new Date().toISOString(),
    details,
  })
  state.revision += 1
}

export function registerBusinessDayRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get<{ Params: { businessDate: string } }>('/api/business-days/:businessDate/payment-settlement', async (request) => {
    const state = await repository.read()
    const actor = requireRequestActor(request)
    const permissions = effectivePermissionIdsForEmployee(state, actor.actorId)
    const settlementPermissions: StaffPermissionId[] = ['finance.view', 'finance.manage', 'payment.collect']
    if (!settlementPermissions.some((permission) => permissions.includes(permission))) {
      throw new AuthorizationError(
        '当前账号没有收银结算查看权限；系统管理员权限不等于财务权限',
        'payment.settlement.view',
      )
    }
    if (request.params.businessDate > state.store.businessDate) throw new Error('不能查看未来营业日收银结算')
    return settlementView(state, request.params.businessDate)
  })

  app.post<{ Params: { businessDate: string } }>('/api/business-days/:businessDate/cashier-handovers', async (request, reply) => {
    const input = submitCashierHandoverSchema.parse(request.body)
    const handover = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'payment.intent.create')
      if (request.params.businessDate > state.store.businessDate) throw new Error('不能提交未来营业日交班')
      const isCurrentBusinessDate = request.params.businessDate === state.store.businessDate
      const shift = state.shiftAssignments.find((item) => (
        item.employeeId === actor.actorId
        && item.businessDate === request.params.businessDate
        && (isCurrentBusinessDate ? item.status === 'active' : item.status !== 'cancelled')
        && [item.roleId, ...(item.roleIds ?? [])].includes('cashier')
      ))
      if (!shift) throw new Error(isCurrentBusinessDate ? '只有当前营业日当班收银可以提交交班' : '只有该营业日的收银人员可以补交交班')
      for (const issue of input.issues) {
        const owner = state.employees.find((employee) => employee.id === issue.nextDayOwnerId && employee.status === 'active')
        if (!owner) throw new Error(`次日责任人 ${issue.nextDayOwnerId} 不存在或已停用`)
      }
      const channels = buildSettlementChannelSummaries(
        state.paymentDomain,
        request.params.businessDate,
        input.confirmedActualAmounts,
      )
      const before = state.paymentDomain.idempotencyRecords.length
      const occurredAt = new Date().toISOString()
      const result = submitCashierHandover(state.paymentDomain, {
        handoverId: `handover_${randomUUID()}`,
        businessDate: request.params.businessDate,
        shiftId: shift.id,
        submittedBy: actor.actorId,
        deviceId: input.deviceId,
        note: input.note,
        channels,
        issues: input.issues,
        occurredAt,
        idempotencyKey: input.idempotencyKey,
      })
      if (state.paymentDomain.idempotencyRecords.length !== before) {
        audit(state, actor.actorId, 'cashier_handover.submitted.v1', result.id, {
          businessDate: result.businessDate,
          shiftId: result.shiftId,
          channels: result.channels,
          issues: result.issues,
        })
      }
      return result
    })
    return reply.status(201).send(handover)
  })

  app.post<{ Params: { businessDate: string; handoverId: string } }>(
    '/api/business-days/:businessDate/cashier-handovers/:handoverId/review',
    async (request) => {
      const input = reviewCashierHandoverSchema.parse(request.body)
      return repository.mutate((state) => {
        const actor = requireConfiguredOperation(request, state, 'business-day.close')
        if (request.params.businessDate > state.store.businessDate) throw new Error('不能复核未来营业日交班')
        const handover = latestCashierHandover(state.paymentDomain, request.params.businessDate)
        if (!handover || handover.id !== request.params.handoverId) throw new Error('当前待复核交班不存在')
        if (input.decision === 'approve' && !handoverSnapshotMatches(state.paymentDomain, handover)) {
          throw new Error('交班后账务数据已变化，请收银重新提交')
        }
        const before = state.paymentDomain.idempotencyRecords.length
        const occurredAt = new Date().toISOString()
        const result = reviewCashierHandover(state.paymentDomain, {
          handoverId: handover.id,
          decision: input.decision,
          reviewedBy: actor.actorId,
          note: input.note,
          occurredAt,
          idempotencyKey: input.idempotencyKey,
        })
        const historicalClose = input.decision === 'approve'
          && request.params.businessDate < state.store.businessDate
          && result.status === 'approved'
        if (historicalClose) closeCashierHandover(result, occurredAt)
        if (state.paymentDomain.idempotencyRecords.length !== before) {
          audit(state, actor.actorId, `cashier_handover.${historicalClose ? 'approved_and_closed' : input.decision === 'approve' ? 'approved' : 'rejected'}.v1`, result.id, {
            businessDate: result.businessDate,
            submittedBy: result.submittedBy,
            reviewNote: result.reviewNote,
            historicalClose,
          })
        }
        return result
      })
    },
  )

  app.post<{ Params: { businessDate: string } }>('/api/business-days/:businessDate/close', async (request, reply) => {
    const input = closeSchema.parse(request.body)
    const result = await repository.mutate((working) => {
      const actor = requireConfiguredOperation(request, working, 'business-day.close')
      const previous = working.auditEntries.find((entry) =>
        entry.action === 'business_day.closed.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (previous) {
        if (previous.objectId !== request.params.businessDate || previous.details.nextBusinessDate !== input.nextBusinessDate) {
          throw new Error('幂等键已用于其他营业日关闭操作')
        }
        return {
          kind: 'closed' as const,
          status: 'closed' as const,
          businessDate: previous.objectId,
          nextBusinessDate: String(previous.details.nextBusinessDate),
          handoverId: String(previous.details.handoverId),
          shiftContinuity: previous.details.shiftContinuity as unknown as ShiftContinuityResult,
          blockers: [] as Blocker[],
        }
      }
      if (request.params.businessDate !== working.store.businessDate) throw new Error('只能关闭当前营业日')
      if (input.nextBusinessDate <= working.store.businessDate) throw new Error('下一营业日必须晚于当前营业日')
      const blockers = collectBlockers(working, actor.actorId).filter((blocker) => isFinancialCloseBlocker(working, blocker))
      if (blockers.length > 0) {
        return {
          kind: 'blocked' as const,
          code: 'NIGHT_CLOSE_BLOCKED' as const,
          message: `仍有${blockers.length}项未完成事项，禁止关闭营业日`,
          businessDate: working.store.businessDate,
          nextBusinessDate: input.nextBusinessDate,
          blockers,
        }
      }
      const occurredAt = new Date().toISOString()
      const closedBusinessDate = working.store.businessDate
      const approvedHandover = latestCashierHandover(working.paymentDomain, closedBusinessDate)
      if (!approvedHandover || approvedHandover.reviewedBy !== actor.actorId) throw new Error('收银交班复核状态已变化')
      const archiveSummary = archiveBusinessDayOperations(working, closedBusinessDate, occurredAt, actor.actorId)
      const shiftContinuity = prepareNextBusinessDayShifts(working, closedBusinessDate, input.nextBusinessDate)
      closeCashierHandover(approvedHandover, occurredAt)
      for (const shift of working.shiftAssignments) {
        if (shift.businessDate === closedBusinessDate && shift.status === 'active') shift.status = 'completed'
      }
      const endedPresenceSessionIds = clearPresenceLeases(working, Date.parse(occurredAt))
      for (const employee of working.employees) {
        employee.paused = false
      }
      working.store.businessDate = input.nextBusinessDate
      working.songState.businessDate = input.nextBusinessDate
      working.auditEntries.push({
        id: `audit_${randomUUID()}`, actorId: actor.actorId, action: 'business_day.shift_continuity_prepared.v1',
        objectType: 'businessDay', objectId: input.nextBusinessDate, occurredAt,
        details: { previousBusinessDate: closedBusinessDate, ...shiftContinuity },
      })
      working.auditEntries.push({
        id: `audit_${randomUUID()}`, actorId: actor.actorId, action: 'business_day.closed.v1',
        objectType: 'businessDay', objectId: closedBusinessDate, occurredAt,
        details: {
          nextBusinessDate: input.nextBusinessDate,
          idempotencyKey: input.idempotencyKey,
          handoverId: approvedHandover.id,
          shiftContinuity,
          endedPresenceSessionIds,
          archiveSummary,
        },
      })
      working.revision += 1
      return {
        kind: 'closed' as const,
        status: 'closed' as const,
        businessDate: closedBusinessDate,
        nextBusinessDate: input.nextBusinessDate,
        handoverId: approvedHandover.id,
        shiftContinuity,
        blockers: [] as Blocker[],
      }
    })
    if (result.kind === 'blocked') return reply.status(409).send(result)
    const { kind: _kind, ...response } = result
    return response
  })
}
