import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireConfiguredOperation } from './authorization.js'
import type { RuntimeRepository } from './repository.js'

const closeSchema = z.object({
  nextBusinessDate: z.iso.date(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

type Blocker = { kind: string; id: string; detail: string }

function collectBlockers(state: Awaited<ReturnType<RuntimeRepository['read']>>) {
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
  return blockers
}

export function registerBusinessDayRoutes(app: FastifyInstance, repository: RuntimeRepository) {
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
      return { status: 'closed', businessDate: previous.objectId, nextBusinessDate: previous.details.nextBusinessDate, blockers: [] }
    }
    if (request.params.businessDate !== state.store.businessDate) throw new Error('只能关闭当前营业日')
    if (input.nextBusinessDate <= state.store.businessDate) throw new Error('下一营业日必须晚于当前营业日')
    const blockers = collectBlockers(state)
    if (blockers.length > 0) {
      return reply.status(409).send({
        code: 'NIGHT_CLOSE_BLOCKED', message: `仍有${blockers.length}项未完成事项，禁止关闭营业日`,
        businessDate: state.store.businessDate, nextBusinessDate: input.nextBusinessDate, blockers,
      })
    }
    return repository.mutate((working) => {
      const occurredAt = new Date().toISOString()
      const closedBusinessDate = working.store.businessDate
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
        details: { nextBusinessDate: input.nextBusinessDate, idempotencyKey: input.idempotencyKey },
      })
      working.revision += 1
      return { status: 'closed', businessDate: closedBusinessDate, nextBusinessDate: input.nextBusinessDate, blockers: [] }
    })
  })
}
