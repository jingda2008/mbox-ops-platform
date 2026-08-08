import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { salesAttributionSchema, type RuntimeState } from '../src/shared/contracts.js'
import type { ReservationState, ReservationStatus } from '../src/shared/reservation-contracts.js'
import { AuthorizationError, requireApprovalAmount, requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import { BusinessRuleError } from './business-rule-error.js'
import { startAwaitingOrder } from './proactive-service.js'
import { createServiceTask } from './domain.js'
import { currentSalesEmployeeId, openTableSession, recordSalesAttribution } from './table-sessions.js'
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
  normalizeReservationConfig,
  recordReservationDepositIntent,
  seatReservation,
  startReservationDepositRefund,
  updateReservationConfig,
  updateReservationDetails,
  decideLateReservationHold,
  DEFAULT_RESERVATION_CONFIG,
  reservationDepositRule,
} from './reservation-domain.js'
import type { RuntimeRepository } from './repository.js'

type RuntimeStateWithReservations = RuntimeState & { reservationState?: ReservationState }

const idempotencyKeySchema = z.string().trim().min(8).max(128)
const timestampSchema = z.string().datetime({ offset: true })

function childIdempotencyKey(key: string, suffix: string) {
  return `${key.slice(0, Math.max(8, 118 - suffix.length))}:${suffix}`
}

const createSchema = z.object({
  customerReference: z.string().trim().min(1).max(128),
  customerName: z.string().trim().min(1).max(100),
  contactReference: z.string().trim().max(256).optional(),
  phone: z.string().trim().regex(/^1\d{10}$/, '手机号需为11位中国大陆号码').optional(),
  wechatId: z.string().trim().min(2).max(80).optional(),
  sourceCode: z.string().trim().min(1).max(64),
  partySize: z.number().int().positive(),
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: timestampSchema,
  depositRequiredAmount: z.number().int().nonnegative().optional(),
  depositCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  salesEmployeeId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (!value.contactReference && !value.phone && !value.wechatId) {
    context.addIssue({ code: 'custom', path: ['phone'], message: '手机号或微信号至少填写一项' })
  }
})

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

const updateDetailsSchema = z.object({
  partySize: z.number().int().positive(),
  scheduledAt: timestampSchema,
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(2).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const lateHoldSchema = z.object({
  decision: z.enum(['hold', 'release']),
  expectedArrivalAt: timestampSchema,
  contactReference: z.string().trim().min(2).max(256),
  reason: z.string().trim().min(2).max(500),
  idempotencyKey: idempotencyKeySchema,
}).strict()

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
  lateHoldMinutes: z.number().int().min(0).max(240).default(30),
  waitlistResponseMinutes: z.number().int().min(1).max(120).default(10),
  businessHours: z.object({
    timeZone: z.string().trim().min(1).max(80),
    openingTime: z.string().regex(/^\d{2}:\d{2}$/),
    closingTime: z.string().regex(/^\d{2}:\d{2}$/),
    slotMinutes: z.number().int().min(5).max(240),
    closedWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  }).strict().optional(),
  capacity: z.object({
    defaultDailyCapacity: z.number().int().min(1).max(10_000),
    defaultSlotCapacity: z.number().int().min(1).max(1_000),
    dateOverrides: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      enabled: z.boolean(),
      totalCapacity: z.number().int().min(0).max(10_000),
      slotCapacities: z.array(z.object({
        time: z.string().regex(/^\d{2}:\d{2}$/),
        capacity: z.number().int().min(0).max(1_000),
      }).strict()).max(100),
    }).strict()).max(366),
  }).strict().optional(),
  publicRules: z.object({
    minimumLeadMinutes: z.number().int().min(0).max(10_080),
    maximumAdvanceDays: z.number().int().min(1).max(730),
    duplicateWindowMinutes: z.number().int().min(0).max(1_440),
    acceptedContactMethods: z.array(z.enum(['phone', 'wechat'])).min(1).max(2),
    createRateLimit: z.object({
      limit: z.number().int().min(1).max(100),
      windowMinutes: z.number().int().min(1).max(1_440),
    }).strict(),
  }).strict().optional(),
  depositPolicy: z.object({
    enabled: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    defaultDepositAmount: z.number().int().nonnegative().max(100_000_000),
    defaultMinimumSpendAmount: z.number().int().nonnegative().max(100_000_000),
    defaultDeductibleRateBps: z.number().int().min(0).max(10_000),
    customerNotice: z.string().trim().min(2).max(300),
    areaRules: z.array(z.object({
      areaPreferenceCode: z.string().trim().min(1).max(64),
      depositAmount: z.number().int().nonnegative().max(100_000_000),
      minimumSpendAmount: z.number().int().nonnegative().max(100_000_000),
      deductibleRateBps: z.number().int().min(0).max(10_000),
      customerNotice: z.string().trim().max(300),
    }).strict()).max(100),
  }).strict().optional(),
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
        lateHoldMinutes: 30,
        waitlistResponseMinutes: 10,
        businessHours: structuredClone(DEFAULT_RESERVATION_CONFIG.businessHours),
        capacity: structuredClone(DEFAULT_RESERVATION_CONFIG.capacity),
        publicRules: structuredClone(DEFAULT_RESERVATION_CONFIG.publicRules),
      },
    )
  }
  state.reservationState.config = normalizeReservationConfig(state.reservationState.config)
  return state.reservationState
}

export function mutateReservationState<T>(state: RuntimeStateWithReservations, operation: (domain: ReservationState) => T) {
  const domain = reservationsFor(state)
  const before = domain.idempotencyRecords.length
  const result = operation(domain)
  if (domain.idempotencyRecords.length !== before) state.revision += 1
  return result
}

function staffContactReference(input: { contactReference?: string; phone?: string; wechatId?: string }) {
  if (input.phone || input.wechatId) {
    return [input.phone ? `phone:${input.phone}` : '', input.wechatId ? `wechat:${input.wechatId}` : ''].filter(Boolean).join('|')
  }
  return input.contactReference!.trim()
}

function requireSeparateRefundApprover(
  domain: ReservationState,
  reservationId: string,
  refundRequestReference: string,
  approverId: string,
) {
  const operation = 'reservation.deposit.refund.approve'
  for (let index = domain.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = domain.auditEvents[index]
    if (
      event?.type === 'reservation.deposit_refund_started.v1' &&
      event.reservationId === reservationId &&
      event.details.refundRequestReference === refundRequestReference
    ) {
      if (event.actorId === approverId) {
        throw new AuthorizationError('退款申请人与审批人必须由不同员工担任', operation)
      }
      return
    }
  }
  throw new AuthorizationError('无法核验退款申请人，禁止确认退款完成', operation)
}

export function registerReservationRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/reservations', async (request) => {
    const query = listQuerySchema.parse(request.query)
    const state = await repository.read() as RuntimeStateWithReservations
    requireConfiguredOperation(request, state, 'reservation.view')
    const domain = reservationsFor(state)
    const reservations = domain.reservations.filter((item) => item.sourceCode !== 'walk_in')
    return {
      config: domain.config,
      reservations: query.status ? reservations.filter((item) => item.status === query.status) : reservations,
    }
  })

  app.put('/api/reservations/config', async (request) => {
    const input = configUpdateSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.config.write')
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
      const config = updateReservationConfig(domain, normalizeReservationConfig({
        ...domain.config,
        ...input.config,
        businessHours: input.config.businessHours ?? domain.config.businessHours,
        capacity: input.config.capacity ?? domain.config.capacity,
        publicRules: input.config.publicRules ?? domain.config.publicRules,
        version: domain.config.version + 1,
      }))
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
    const input = createSchema.parse(request.body)
    if (input.sourceCode === 'walk_in') {
      throw new BusinessRuleError('现场到店请直接开台，不创建预约', 'WALK_IN_USES_TABLE_OPEN')
    }
    const result = await repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      const { salesEmployeeId, phone, wechatId, contactReference, depositRequiredAmount, depositCurrency, ...reservationInput } = input
      const reservation = mutateReservationState(state, (domain) => {
        const existing = domain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
        const reservationId = existing?.operation === 'reservation.create' ? existing.reservationId : randomUUID()
        const depositRule = reservationDepositRule(domain.config, input.areaPreferenceCode)
        return createReservation(domain, {
          ...reservationInput,
          contactReference: staffContactReference({ contactReference, phone, wechatId }),
          depositRequiredAmount: depositRule.enabled ? depositRule.depositAmount : depositRequiredAmount ?? 0,
          depositCurrency: depositRule.currency || depositCurrency || 'CNY',
          reservationId,
          actorId: actor.actorId,
          occurredAt: new Date().toISOString(),
        })
      })
      if (salesEmployeeId) {
        recordSalesAttribution(state, {
          subjectType: 'reservation', subjectId: reservation.id, salesEmployeeId,
          actorId: actor.actorId, reason: '创建预约时指定销售', occurredAt: reservation.requestedAt,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'sales'),
        })
      }
      return reservation
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/sales-attribution', async (request) => {
    const input = salesAttributionSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      if (!reservationsFor(state).reservations.some((reservation) => reservation.id === request.params.reservationId)) {
        throw new Error('预约不存在')
      }
      const before = state.salesAttributionRecords?.length ?? 0
      const record = recordSalesAttribution(state, {
        subjectType: 'reservation', subjectId: request.params.reservationId,
        salesEmployeeId: input.salesEmployeeId, actorId: actor.actorId, reason: input.reason,
        occurredAt: new Date().toISOString(), idempotencyKey: input.idempotencyKey,
      })
      if ((state.salesAttributionRecords?.length ?? 0) > before) state.revision += 1
      return record
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/actions', async (request) => {
    const input = actionSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      return mutateReservationState(state, (domain) => {
        const command = {
          reservationId: request.params.reservationId,
          actorId: actor.actorId,
          occurredAt: new Date().toISOString(),
          idempotencyKey: input.idempotencyKey,
        }
        if (input.action === 'confirm') return confirmReservation(domain, command)
        if (input.action === 'arrive') return markReservationArrived(domain, command)
        if (input.action === 'seat') {
          const reservation = domain.reservations.find((item) => item.id === request.params.reservationId)
          if (!reservation) throw new Error('预约不存在')
          const isReplay = domain.idempotencyRecords.some((record) =>
            record.key === input.idempotencyKey && record.operation === 'reservation.seat',
          )
          let table = state.tables.find((item) => item.id === input.tableId)
          let tableSessionId = reservation.tableSessionId
          if (!isReplay) {
            if (!table) throw new Error('入座桌台不存在')
            requireTableDataScope(request, state, table.id, 'reservation.manage')
            if (!['available', 'reserved'].includes(table.status)) throw new Error('入座桌台当前不可用')
            const activeWaitlistHold = state.waitlistEntries.find((entry) => (
              entry.heldTableId === table.id
              && entry.status === 'notified'
              && (!entry.responseExpiresAt || Date.parse(entry.responseExpiresAt) >= Date.parse(command.occurredAt))
            ))
            if (activeWaitlistHold) throw new Error(`该桌已锁给候补客人${activeWaitlistHold.customerName}，请先释放候补锁桌`)
            const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId && employee.status === 'active')
            if (!primary) throw new Error('桌台没有有效主服务员，不能安排入座')
            const activeShift = state.shiftAssignments.find((shift) =>
              shift.employeeId === primary.id && shift.businessDate === state.store.businessDate && shift.status === 'active',
            )
            if (!primary.online || primary.paused || !activeShift || !activeShift.areaIds.includes(table.areaId)) {
              throw new Error('桌台主服务员当前不可接待，请先完成员工调度')
            }
            tableSessionId = openTableSession(state, table, command.occurredAt, {
              source: 'reservation', sourceId: reservation.id, guestCount: reservation.partySize,
            }).id
          }
          if (!table || !tableSessionId) throw new Error('预约入座桌次不完整')
          const result = seatReservation(domain, {
            ...command, tableId: table.id, tableCode: table.code, tableSessionId,
          })
          if (!isReplay) {
            table.status = 'occupied'
            table.guestCount = reservation.partySize
            table.openedAt = command.occurredAt
            state.auditEntries.push({
              id: randomUUID(), actorId: actor.actorId, action: 'table.opened_from_reservation.v1',
              objectType: 'table', objectId: table.id, occurredAt: command.occurredAt,
              details: {
                reservationId: reservation.id,
                tableSessionId,
                guestCount: reservation.partySize,
                tableCapacity: table.capacity,
                extraSeatCount: Math.max(0, reservation.partySize - table.capacity),
              },
            })
            state.revision += 1
            const salesEmployeeId = currentSalesEmployeeId(state, 'reservation', reservation.id)
            if (salesEmployeeId) {
              recordSalesAttribution(state, {
                subjectType: 'table_session', subjectId: tableSessionId, salesEmployeeId,
                actorId: actor.actorId, reason: '预约入座继承销售归属', occurredAt: command.occurredAt,
                idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'sales'),
              })
            }
            if (state.config.proactiveOrderCare.enabled) {
              startAwaitingOrder(state, table.id, actor.actorId, `reservation-seat:${reservation.id}`, new Date(command.occurredAt))
            }
            if (reservation.occasionCode === 'birthday') {
              createServiceTask(state, {
                tableCode: table.code,
                serviceTypeId: 'birthday',
                source: 'system',
                triggerId: reservation.id,
                note: `${reservation.customerName}生日到店：${reservation.occasionNote || '请到桌确认称呼、公开互动意愿和庆祝时间'}`,
                idempotencyKey: `reservation-birthday:${reservation.id}`,
                requestedBy: actor.actorId,
              })
            }
          }
          return result
        }
        if (input.action === 'cancel') return cancelReservation(domain, { ...command, reason: input.reason })
        return markReservationNoShow(domain, { ...command, reason: input.reason })
      })
    })
  })

  app.put<{ Params: { reservationId: string } }>('/api/reservations/:reservationId', async (request) => {
    const input = updateDetailsSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      return mutateReservationState(state, (domain) => updateReservationDetails(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/late-hold', async (request) => {
    const input = lateHoldSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      return mutateReservationState(state, (domain) => decideLateReservationHold(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-intent', async (request) => {
    const input = depositIntentSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      return mutateReservationState(state, (domain) => recordReservationDepositIntent(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-confirmation', async (request) => {
    const input = depositConfirmationSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.deposit.confirm')
      return mutateReservationState(state, (domain) => confirmReservationDeposit(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refunds', async (request) => {
    const input = refundStartSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.deposit.refund.request')
      const reservation = state.reservationState?.reservations.find((item) => item.id === request.params.reservationId)
      if (!reservation) throw new Error('预约不存在')
      requireApprovalAmount(request, state, 'refundRequest', reservation.deposit.requiredAmount, 'reservation.deposit.refund.request')
      return mutateReservationState(state, (domain) => startReservationDepositRefund(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refund-confirmation', async (request) => {
    const input = refundConfirmationSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.deposit.refund.approve')
      requireApprovalAmount(request, state, 'refundApprove', input.refundedAmount, 'reservation.deposit.refund.approve')
      return mutateReservationState(state, (domain) => {
        requireSeparateRefundApprover(domain, request.params.reservationId, input.refundRequestReference, actor.actorId)
        return completeReservationDepositRefund(domain, {
          ...input,
          reservationId: request.params.reservationId,
          actorId: actor.actorId,
          occurredAt: new Date().toISOString(),
        })
      })
    })
  })

  app.post<{ Params: { reservationId: string } }>('/api/reservations/:reservationId/deposit-refund-failure', async (request) => {
    const input = refundFailureSchema.parse(request.body)
    return repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      const actor = requireConfiguredOperation(request, state, 'reservation.deposit.refund.request')
      return mutateReservationState(state, (domain) => failReservationDepositRefund(domain, {
        ...input,
        reservationId: request.params.reservationId,
        actorId: actor.actorId,
        occurredAt: new Date().toISOString(),
      }))
    })
  })
}

export function reservationStatuses(): ReservationStatus[] {
  return ['requested', 'confirmed', 'arrived', 'seated', 'cancelled', 'no_show']
}
