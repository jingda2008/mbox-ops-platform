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

const closeSchema = z.object({
  nextBusinessDate: z.iso.date(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

type RuntimeState = Awaited<ReturnType<RuntimeRepository['read']>>
type Blocker = { kind: string; id: string; detail: string }

function collectBlockers(state: RuntimeState, closingActorId: string) {
  const blockers: Blocker[] = []
  for (const task of state.tasks.filter((item) => !['confirmed', 'cancelled'].includes(item.status))) {
    blockers.push({ kind: 'open_service_task', id: task.id, detail: `${task.serviceTypeId}:${task.status}` })
  }
  for (const task of state.orderDomain.kdsTasks.filter((item) => item.status !== 'delivered')) {
    blockers.push({ kind: 'undelivered_kds', id: task.id, detail: `${task.stationId}:${task.status}` })
  }
  for (const session of state.songState.tableSessions.filter((item) => item.status === 'open')) {
    blockers.push({ kind: 'open_table_session', id: session.id, detail: session.tableCode })
  }
  for (const intent of state.paymentDomain.paymentIntents.filter((item) => ['pending', 'processing'].includes(item.status))) {
    blockers.push({ kind: 'unresolved_payment', id: intent.id, detail: intent.status })
  }
  for (const refund of state.paymentDomain.refunds.filter((item) => ['requested', 'approved', 'processing'].includes(item.status))) {
    blockers.push({ kind: 'unresolved_refund', id: refund.id, detail: refund.status })
  }
  for (const redemption of state.benefitRedemptions.filter((item) => item.status === 'locked')) {
    blockers.push({ kind: 'locked_benefit', id: redemption.id, detail: redemption.tableSessionId })
  }
  for (const reservation of state.reservationState?.reservations ?? []) {
    if (['payment_required', 'payment_intent_recorded', 'refund_required', 'refund_processing', 'refund_failed'].includes(reservation.deposit.status)) {
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
    requireConfiguredOperation(request, state, 'payment.intent.create')
    if (request.params.businessDate !== state.store.businessDate) throw new Error('只能查看当前营业日收银结算')
    return settlementView(state, request.params.businessDate)
  })

  app.post<{ Params: { businessDate: string } }>('/api/business-days/:businessDate/cashier-handovers', async (request, reply) => {
    const input = submitCashierHandoverSchema.parse(request.body)
    const handover = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'payment.intent.create')
      if (request.params.businessDate !== state.store.businessDate) throw new Error('只能提交当前营业日交班')
      const shift = state.shiftAssignments.find((item) => (
        item.employeeId === actor.actorId
        && item.businessDate === state.store.businessDate
        && item.status === 'active'
        && [item.roleId, ...(item.roleIds ?? [])].includes('cashier')
      ))
      if (!shift) throw new Error('只有当前营业日当班收银可以提交交班')
      for (const issue of input.issues) {
        const owner = state.employees.find((employee) => employee.id === issue.nextDayOwnerId && employee.status === 'active')
        if (!owner) throw new Error(`次日责任人 ${issue.nextDayOwnerId} 不存在或已停用`)
      }
      const channels = buildSettlementChannelSummaries(
        state.paymentDomain,
        state.store.businessDate,
        input.confirmedActualAmounts,
      )
      const before = state.paymentDomain.idempotencyRecords.length
      const occurredAt = new Date().toISOString()
      const result = submitCashierHandover(state.paymentDomain, {
        handoverId: `handover_${randomUUID()}`,
        businessDate: state.store.businessDate,
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
        if (request.params.businessDate !== state.store.businessDate) throw new Error('只能复核当前营业日交班')
        const handover = latestCashierHandover(state.paymentDomain, state.store.businessDate)
        if (!handover || handover.id !== request.params.handoverId) throw new Error('当前待复核交班不存在')
        if (input.decision === 'approve' && !handoverSnapshotMatches(state.paymentDomain, handover)) {
          throw new Error('交班后账务数据已变化，请收银重新提交')
        }
        const before = state.paymentDomain.idempotencyRecords.length
        const result = reviewCashierHandover(state.paymentDomain, {
          handoverId: handover.id,
          decision: input.decision,
          reviewedBy: actor.actorId,
          note: input.note,
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        })
        if (state.paymentDomain.idempotencyRecords.length !== before) {
          audit(state, actor.actorId, `cashier_handover.${input.decision === 'approve' ? 'approved' : 'rejected'}.v1`, result.id, {
            businessDate: result.businessDate,
            submittedBy: result.submittedBy,
            reviewNote: result.reviewNote,
          })
        }
        return result
      })
    },
  )

  app.post<{ Params: { businessDate: string } }>('/api/business-days/:businessDate/close', async (request, reply) => {
    const input = closeSchema.parse(request.body)
    const state = await repository.read()
    const actor = requireConfiguredOperation(request, state, 'business-day.close')
    const previous = state.auditEntries.find((entry) =>
      entry.action === 'business_day.closed.v1' && entry.details.idempotencyKey === input.idempotencyKey,
    )
    if (previous) {
      if (previous.objectId !== request.params.businessDate || previous.details.nextBusinessDate !== input.nextBusinessDate) {
        throw new Error('幂等键已用于其他营业日关闭操作')
      }
      return {
        status: 'closed',
        businessDate: previous.objectId,
        nextBusinessDate: previous.details.nextBusinessDate,
        handoverId: previous.details.handoverId,
        blockers: [],
      }
    }
    if (request.params.businessDate !== state.store.businessDate) throw new Error('只能关闭当前营业日')
    if (input.nextBusinessDate <= state.store.businessDate) throw new Error('下一营业日必须晚于当前营业日')
    const blockers = collectBlockers(state, actor.actorId)
    if (blockers.length > 0) {
      return reply.status(409).send({
        code: 'NIGHT_CLOSE_BLOCKED', message: `仍有${blockers.length}项未完成事项，禁止关闭营业日`,
        businessDate: state.store.businessDate, nextBusinessDate: input.nextBusinessDate, blockers,
      })
    }
    return repository.mutate((working) => {
      const occurredAt = new Date().toISOString()
      const closedBusinessDate = working.store.businessDate
      const approvedHandover = latestCashierHandover(working.paymentDomain, closedBusinessDate)
      if (!approvedHandover || approvedHandover.reviewedBy !== actor.actorId) throw new Error('收银交班复核状态已变化')
      closeCashierHandover(approvedHandover, occurredAt)
      for (const shift of working.shiftAssignments) {
        if (shift.businessDate === closedBusinessDate && shift.status === 'active') shift.status = 'completed'
      }
      for (const employee of working.employees) {
        employee.online = false
        employee.paused = false
      }
      working.store.businessDate = input.nextBusinessDate
      working.auditEntries.push({
        id: `audit_${randomUUID()}`, actorId: actor.actorId, action: 'business_day.closed.v1',
        objectType: 'businessDay', objectId: closedBusinessDate, occurredAt,
        details: { nextBusinessDate: input.nextBusinessDate, idempotencyKey: input.idempotencyKey, handoverId: approvedHandover.id },
      })
      working.revision += 1
      return { status: 'closed', businessDate: closedBusinessDate, nextBusinessDate: input.nextBusinessDate, handoverId: approvedHandover.id, blockers: [] }
    })
  })
}
