import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { ReservationState, ReservationStatus } from '../src/shared/reservation-contracts.js'
import { requireRequestActor } from './auth-context.js'
import {
  cancelReservation,
  completeReservationDepositRefund,
  confirmReservation,
  confirmReservationDeposit,
  createReservation,
  createReservationState,
  failReservationDepositRefund,
  markReservationArrived,
  markReservationNoShow,
  recordReservationDepositIntent,
  seatReservation,
  startReservationDepositRefund,
  updateReservationConfig,
} from './reservation-domain.js'
import type { RuntimeRepository } from './repository.js'

type RuntimeStateWithReservations = RuntimeState & { reservationState?: ReservationState }

const idempotencyKeySchema = z.string().trim().min(8).max(128)
const timestampSchema = z.string().datetime({ offset: true })

const createSchema = z.object({
  customerReference: z.string().trim().min(1).max(128),
  customerName: z.string().trim().min(1).max(100),
  contactReference: z.string().trim().min(1).max(256),
  sourceCode: z.string().trim().min(1).max(64),
  partySize: z.number().int().positive(),
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: timestampSchema,
  depositRequiredAmount: z.number().int().nonnegative(),
  depositCurrency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const confirmActionSchema = z.object({
  action: z.literal('confirm'),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const arriveActionSchema = z.object({
  action: z.literal('arrive'),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const seatActionSchema = z.object({
  action: z.literal('seat'),
  tableId: z.string().trim().min(1).max(128),
  tableCode: z.string().trim().min(1).max(64),
  tableSessionId: z.string().trim().min(1).max(128),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const cancelActionSchema = z.object({
  action: z.literal('cancel'),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const noShowActionSchema = z.object({
  action: z.literal('no_show'),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const actionSchema = z.discriminatedUnion('action', [
  confirmActionSchema,
  arriveActionSchema,
  seatActionSchema,
  cancelActionSchema,
  noShowActionSchema,
])

const depositIntentSchema = z.object({
  paymentIntentReference: z.string().trim().min(1).max(256),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const depositConfirmationSchema = z.object({
  paymentIntentReference: z.string().trim().min(1).max(256),
  paymentConfirmationReference: z.string().trim().min(1).max(256),
  confirmedAmount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const refundStartSchema = z.object({
  refundRequestReference: z.string().trim().min(1).max(256),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const refundConfirmationSchema = z.object({
  refundRequestReference: z.string().trim().min(1).max(256),
  refundConfirmationReference: z.string().trim().min(1).max(256),
  refundedAmount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const refundFailureSchema = z.object({
  refundRequestReference: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const listQuerySchema = z.object({
  status: z.enum(['requested', 'confirmed', 'arrived', 'seated', 'cancelled', 'no_show']).optional(),
}).strict()

const reservationConfigSchema = z.object({
  minimumPartySize: z.number().int().min(1).max(100),
  maximumPartySize: z.number().int().min(1).max(100),
  sources: z.array(z.object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  }).strict()).min(1).max(50),
  areaPreferences: z.array(z.object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  }).strict()).max(100),
  occasions: z.array(z.object({
    code: z.enum(['birthday', 'anniversary', 'business', 'other']),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    serviceScript: z.array(z.string().trim().min(1).max(160)).max(20),
  }).strict()).min(1).max(4),
}).strict()

const configUpdateSchema = z.object({
  config: reservationConfigSchema,
  reason: z.string().trim().min(2).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export function reservationsFor(state: RuntimeStateWithReservations) {
  if (!state.reservationState) {
    state.reservationState = createReservationState(
      { tenantId: `runtime:${state.store.id}`, storeId: state.store.id },
      {
        version: state.config.version,
        minimumPartySize: 1,
        maximumPartySize: 100,
        sources: [
          { code: 'phone', name: '电话', enabled: true, sortOrder: 10 },
          { code: 'wechat', name: '微信', enabled: true, sortOrder: 20 },
          { code: 'walk_in', name: '现场', enabled: true, sortOrder: 30 },
        ],
        areaPreferences: state.areas.map((area, index) => ({
          code: area.id,
          name: area.name,
          enabled: true,
          sortOrder: index + 1,
        })),
        occasions: [
          { code: 'birthday', name: '生日', enabled: true, serviceScript: ['确认生日称呼与时间', '通知值班经理准备生日权益'] },
          { code: 'anniversary', name: '纪念日', enabled: true, serviceScript: [] },
          { code: 'business', name: '商务接待', enabled: true, serviceScript: [] },
          { code: 'other', name: '其他', enabled: true, serviceScript: [] },
        ],
      },
    )
  }
  return state.reservationState
}

export function mutateReservationState<T>(state: RuntimeStateWithReservations, operation: (domain: ReservationState) => T) {
  const domain = reservationsFor(state)
  const before = domain.idempotencyRecords.length
  const result = operation(domain)
  if (domain.idempotencyRecords.length !== before) state.revision += 1
  return result
}

export function registerReservationRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/reservations', async (request) => {
    requireRequestActor(request)
    const query = listQuerySchema.parse(request.query)
    const state = await repository.read() as RuntimeStateWithReservations
    const domain = reservationsFor(state)
    const reservations = domain.reservations
    return {
      config: domain.config,
      reservations: query.status ? reservations.filter((item) => item.status === query.status) : reservations,
    }
  })

  app.put('/api/reservations/config', async (request) => {
    const actor = requireRequestActor(request)
    if (actor.roleId !== 'manager') throw new Error('只有经理可以修改预约规则')
    const input = configUpdateSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const domain = reservationsFor(state)
      const existing = state.auditEntries.find((entry) =>
        entry.action === 'reservation.config.updated.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (existing) {
        if (JSON.stringify(existing.details.config) !== JSON.stringify(input.config)) {
          throw new Error('幂等键已用于不同预约配置')
        }
        return domain.config
      }
      const config = updateReservationConfig(domain, {
        ...input.config,
        version: domain.config.version + 1,
      })
      state.revision += 1
      state.auditEntries.push({
        id: randomUUID(),
        actorId: actor.actorId,
        action: 'reservation.config.updated.v1',
        objectType: 'reservationConfig',
        objectId: state.store.id,
        occurredAt: new Date().toISOString(),
        details: {
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          config: structuredClone(input.config),
          version: config.version,
        },
      })
      return config
    })
  })

  app.post('/api/reservations', async (request, reply) => {
    const actor = requireRequestActor(request)
    const input = createSchema.parse(request.body)
    const result = await repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const existing = domain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
      const reservationId = existing?.operation === 'reservation.create' ? existing.reservationId : randomUUID()
      return createReservation(domain, {
        ...input,
        reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    }))
    return reply.status(201).send(result)
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/actions', async (request) => {
    const actor = requireRequestActor(request)
    const input = actionSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const command = {
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      }
      if (input.action === 'confirm') return confirmReservation(domain, command)
      if (input.action === 'arrive') return markReservationArrived(domain, command)
      if (input.action === 'seat') return seatReservation(domain, { ...command, ...input })
      if (input.action === 'cancel') return cancelReservation(domain, { ...command, reason: input.reason })
      return markReservationNoShow(domain, { ...command, reason: input.reason })
    }))
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-intent', async (request) => {
    const actor = requireRequestActor(request)
    const input = depositIntentSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => (
      recordReservationDepositIntent(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    )))
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-confirmation', async (request) => {
    const actor = requireRequestActor(request)
    const input = depositConfirmationSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => (
      confirmReservationDeposit(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    )))
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refunds', async (request) => {
    const actor = requireRequestActor(request)
    const input = refundStartSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => (
      startReservationDepositRefund(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    )))
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refund-confirmation', async (request) => {
    const actor = requireRequestActor(request)
    const input = refundConfirmationSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => (
      completeReservationDepositRefund(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    )))
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refund-failure', async (request) => {
    const actor = requireRequestActor(request)
    const input = refundFailureSchema.parse(request.body)
    return repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => (
      failReservationDepositRefund(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      })
    )))
  })
}

export function reservationStatuses(): ReservationStatus[] {
  return ['requested', 'confirmed', 'arrived', 'seated', 'cancelled', 'no_show']
}
