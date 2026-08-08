import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { Reservation, ReservationConfig, ReservationState } from '../src/shared/reservation-contracts.js'
import {
  assertPublicReservationAvailability,
  cancelReservation,
  createReservation,
  normalizeReservationConfig,
  reservationDepositRule,
  updateReservationDetails,
} from './reservation-domain.js'
import {
  assertPublicRequestedTableAvailable,
  publicTableAvailability,
} from './public-reservation-availability.js'
import { mutateReservationState, reservationsFor } from './reservation-api.js'
import type { RuntimeRepository } from './repository.js'
import type { RateLimitStore } from './rate-limit.js'

type RuntimeStateWithReservations = RuntimeState & { reservationState?: ReservationState }

const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
const SESSION_ISSUE_LIMIT = 20
const SESSION_ISSUE_WINDOW_MS = 60 * 60_000
const SESSION_ISSUE_SCOPE = 'public.reservation-session'
const CREATE_IP_SCOPE = 'public.reservation-create.ip'
const CREATE_CONTACT_SCOPE = 'public.reservation-create.contact'

const contactFields = {
  phone: z.string().trim().min(7).max(24).optional(),
  wechatId: z.string().trim().min(4).max(128).optional(),
}

const assignmentFields = {
  assignmentMode: z.enum(['direct', 'self_select']).optional(),
  requestedTableCode: z.string().trim().min(1).max(32).optional(),
}

const createSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  ...contactFields,
  partySize: z.number().int().positive(),
  ...assignmentFields,
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

const updateSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  ...contactFields,
  partySize: z.number().int().positive(),
  ...assignmentFields,
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).nullable().optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

const cancelSchema = z.object({
  reason: z.string().trim().min(2).max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

const reservationParamsSchema = z.object({ reservationId: z.string().uuid() }).strict()
const availabilityQuerySchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  partySize: z.coerce.number().int().positive().max(100),
}).strict()

interface PublicReservationClaims {
  version: 1
  tokenType: 'public_reservation'
  storeId: string
  customerId: string
  issuedAt: number
  expiresAt: number
}

export class PublicReservationAccessError extends Error {
  constructor(message: string, readonly code = 'PUBLIC_RESERVATION_SESSION_INVALID') {
    super(message)
  }
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signPublicReservationSession(
  claims: Omit<PublicReservationClaims, 'version' | 'tokenType'>,
  secret: string,
) {
  if (secret.length < 32) throw new Error('预约会话签名密钥至少需要32个字符')
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > SESSION_TTL_MS) {
    throw new Error('预约会话有效期无效')
  }
  const payload = Buffer.from(JSON.stringify({ version: 1, tokenType: 'public_reservation', ...claims })).toString('base64url')
  return `${payload}.${signature(payload, secret)}`
}

export function verifyPublicReservationSession(token: string, secret: string, now = Date.now()) {
  const [payload, suppliedSignature, extra] = token.split('.')
  if (!payload || !suppliedSignature || extra) throw new PublicReservationAccessError('预约会话格式无效')
  const expected = Buffer.from(signature(payload, secret))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new PublicReservationAccessError('预约会话签名无效')
  }
  let claims: PublicReservationClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PublicReservationClaims
  } catch {
    throw new PublicReservationAccessError('预约会话载荷无效')
  }
  if (
    claims.version !== 1 || claims.tokenType !== 'public_reservation' || !claims.storeId || !claims.customerId
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.issuedAt > now + 60_000 || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > SESSION_TTL_MS
  ) throw new PublicReservationAccessError('预约会话声明无效')
  if (claims.expiresAt <= now) throw new PublicReservationAccessError('预约会话已过期，请刷新页面')
  return claims
}

function publicConfig(state: ReservationState) {
  const config = normalizeReservationConfig(state.config)
  return {
    version: config.version,
    minimumPartySize: config.minimumPartySize,
    maximumPartySize: config.maximumPartySize,
    areaPreferences: config.areaPreferences
      .filter((item) => item.enabled)
      .toSorted((left, right) => left.sortOrder - right.sortOrder)
      .map(({ code, name }) => ({ code, name })),
    occasions: config.occasions
      .filter((item) => item.enabled)
      .map(({ code, name }) => ({ code, name })),
    businessHours: structuredClone(config.businessHours),
    capacity: structuredClone(config.capacity),
    publicRules: {
      minimumLeadMinutes: config.publicRules.minimumLeadMinutes,
      maximumAdvanceDays: config.publicRules.maximumAdvanceDays,
      acceptedContactMethods: [...config.publicRules.acceptedContactMethods],
    },
    depositPolicy: structuredClone(config.depositPolicy),
  }
}

function reservationContacts(reference: string) {
  const values = reference.split('|')
  return {
    phone: values.find((item) => item.startsWith('phone:'))?.slice('phone:'.length) ?? null,
    wechatId: values.find((item) => item.startsWith('wechat:'))?.slice('wechat:'.length) ?? null,
  }
}

function publicReservation(reservation: Reservation) {
  const contacts = reservationContacts(reservation.contactReference)
  return {
    id: reservation.id,
    customerName: reservation.customerName,
    partySize: reservation.partySize,
    assignmentMode: reservation.assignmentMode,
    requestedTableCode: reservation.requestedTableCode,
    areaPreferenceCode: reservation.areaPreferenceCode,
    occasionCode: reservation.occasionCode,
    occasionNote: reservation.occasionNote,
    scheduledAt: reservation.scheduledAt,
    status: reservation.status,
    tableCode: reservation.tableCode,
    requestedAt: reservation.requestedAt,
    updatedAt: reservation.updatedAt,
    ...contacts,
  }
}

function normalizePhone(value: string) {
  const trimmed = value.trim()
  const digits = trimmed.replace(/[^\d]/g, '')
  let normalized = ''
  if (trimmed.startsWith('+')) normalized = `+${digits}`
  else if (trimmed.startsWith('00')) normalized = `+${digits.slice(2)}`
  else if (/^86(1[3-9]\d{9})$/.test(digits)) normalized = `+${digits}`
  else if (/^1[3-9]\d{9}$/.test(digits)) normalized = `+86${digits}`
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new Error('请填写有效手机号；国际号码请带国家或地区代码')
  }
  return normalized
}

function contactReference(
  input: { phone?: string; wechatId?: string },
  config: ReservationConfig,
) {
  const methods = new Set(config.publicRules.acceptedContactMethods)
  const phone = input.phone?.trim() ? normalizePhone(input.phone) : ''
  const wechatId = input.wechatId?.trim() ?? ''
  if (phone && !methods.has('phone')) throw new Error('当前门店暂不接受手机号预约，请填写微信联系方式')
  if (wechatId && !methods.has('wechat')) throw new Error('当前门店暂不接受微信号预约，请填写手机号')
  if (!phone && !wechatId) throw new Error('请至少填写手机号或微信号，方便门店确认预约')
  return [phone ? `phone:${phone}` : '', wechatId ? `wechat:${wechatId.toLocaleLowerCase('en-US')}` : ''].filter(Boolean).join('|')
}

function ownsReservation(reservation: Reservation, actorReference: string) {
  return reservation.customerReference === actorReference || reservation.createdBy === actorReference
}

function publicMutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof PublicReservationAccessError) {
    return reply.status(403).send({ code: error.code, message: error.message })
  }
  return reply.status(400).send({
    code: 'PUBLIC_RESERVATION_RULE_REJECTED',
    message: error instanceof Error ? error.message : '这次预约暂时无法处理，请换个时间再试',
  })
}

function bearerToken(request: FastifyRequest, reply: FastifyReply) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    reply.status(401).send({ code: 'PUBLIC_RESERVATION_SESSION_REQUIRED', message: '缺少预约会话' })
    return null
  }
  return authorization.slice(7).trim()
}

export function registerPublicReservationRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: { secret: string; now?: () => number; rateLimitStore?: RateLimitStore },
) {
  if (!options.rateLimitStore) throw new Error('Public reservation API requires a persistent rateLimitStore')
  const now = options.now ?? Date.now
  const rateLimitStore = options.rateLimitStore

  app.post('/api/public/reservation-session', async (request, reply) => {
    const current = now()
    const decision = await rateLimitStore.consume({
      scope: SESSION_ISSUE_SCOPE,
      key: request.ip,
      limit: SESSION_ISSUE_LIMIT,
      windowMs: SESSION_ISSUE_WINDOW_MS,
    })
    if (!decision.allowed) {
      return reply.status(429).send({ code: 'PUBLIC_RESERVATION_RATE_LIMITED', message: '请求过于频繁，请稍后再试' })
    }
    const state = await repository.read()
    const expiresAt = current + SESSION_TTL_MS
    return {
      accessToken: signPublicReservationSession({
        storeId: state.store.id,
        customerId: randomUUID(),
        issuedAt: current,
        expiresAt,
      }, options.secret),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  })

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = bearerToken(request, reply)
    if (!token) return null
    try {
      const claims = verifyPublicReservationSession(token, options.secret, now())
      const state = await repository.read()
      if (claims.storeId !== state.store.id) {
        reply.status(403).send({ code: 'PUBLIC_RESERVATION_STORE_FORBIDDEN', message: '预约会话不属于当前门店' })
        return null
      }
      return claims
    } catch (error) {
      const accessError = error instanceof PublicReservationAccessError ? error : new PublicReservationAccessError('预约会话无效')
      reply.status(401).send({ code: accessError.code, message: accessError.message })
      return null
    }
  }

  app.get('/api/public/reservations', async (request, reply) => {
    const identity = await authenticate(request, reply)
    if (!identity) return
    const state = await repository.read() as RuntimeStateWithReservations
    const domain = reservationsFor(state)
    const reference = `public-reservation:${identity.customerId}`
    return {
      config: publicConfig(domain),
      reservations: domain.reservations
        .filter((item) => item.sourceCode !== 'walk_in')
        .filter((item) => ownsReservation(item, reference))
        .toSorted((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))
        .map(publicReservation),
    }
  })

  app.get('/api/public/reservation-availability', async (request, reply) => {
    const identity = await authenticate(request, reply)
    if (!identity) return
    const parsed = availabilityQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_AVAILABILITY_INPUT_INVALID', message: '请选择有效的日期、时间和人数' })
    }
    const runtime = await repository.read() as RuntimeStateWithReservations
    const domain = reservationsFor(runtime)
    try {
      assertPublicReservationAvailability(domain, {
        scheduledAt: parsed.data.scheduledAt,
        occurredAt: new Date(now()).toISOString(),
        contactReference: `availability:${identity.customerId}`,
      })
      return {
        scheduledAt: parsed.data.scheduledAt,
        partySize: parsed.data.partySize,
        tables: publicTableAvailability(runtime, domain, parsed.data.scheduledAt),
      }
    } catch (error) {
      return publicMutationError(reply, error)
    }
  })

  app.post('/api/public/reservations', async (request, reply) => {
    const identity = await authenticate(request, reply)
    if (!identity) return
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_INPUT_INVALID', message: parsed.error.issues[0]?.message ?? '预约信息无效' })
    }
    const input = parsed.data
    const current = now()
    const reference = `public-reservation:${identity.customerId}`
    const currentState = await repository.read() as RuntimeStateWithReservations
    const currentDomain = reservationsFor(currentState)
    let contact: string
    try {
      contact = contactReference(input, currentDomain.config)
    } catch (error) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_CONTACT_INVALID', message: error instanceof Error ? error.message : '联系方式无效' })
    }
    const replay = currentDomain.idempotencyRecords.some((record) => record.key === input.idempotencyKey)
    if (!replay) {
      const limit = currentDomain.config.publicRules.createRateLimit
      const rateInput = { limit: limit.limit, windowMs: limit.windowMinutes * 60_000 }
      const ipDecision = await rateLimitStore.consume({ scope: CREATE_IP_SCOPE, key: request.ip, ...rateInput })
      if (!ipDecision.allowed) {
        return reply.status(429).send({ code: 'PUBLIC_RESERVATION_CREATE_RATE_LIMITED', message: '刚刚已经提交过几次啦，先看看“我的预约”，稍后再试' })
      }
      const contactDecision = await rateLimitStore.consume({ scope: CREATE_CONTACT_SCOPE, key: contact, ...rateInput })
      if (!contactDecision.allowed) {
        return reply.status(429).send({ code: 'PUBLIC_RESERVATION_CREATE_RATE_LIMITED', message: '这个联系方式刚刚提交过多次，请先查看已有预约' })
      }
    }
    let result: { reservation: Reservation; replayed: boolean }
    try {
      result = await repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const existing = domain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
      const replayed = existing?.operation === 'reservation.create'
      const reservationId = replayed ? existing.reservationId : randomUUID()
      const sourceCode = domain.config.sources.find((source) => source.code === 'wechat' && source.enabled)?.code
        ?? domain.config.sources.find((source) => source.enabled)?.code
      if (!sourceCode) throw new Error('当前没有可用预约来源')
      if (!existing) {
        assertPublicReservationAvailability(domain, {
          scheduledAt: input.scheduledAt,
          occurredAt: new Date(current).toISOString(),
          contactReference: contact,
        })
      }
      const requestedTable = input.assignmentMode === 'self_select'
        ? assertPublicRequestedTableAvailable(runtime, domain, input.scheduledAt, input.requestedTableCode ?? '')
        : null
      const reservation = createReservation(domain, {
        ...input,
        reservationId,
        customerReference: reference,
        contactReference: contact,
        sourceCode,
        requestedTableId: requestedTable?.id,
        requestedTableCode: requestedTable?.code,
        areaPreferenceCode: requestedTable?.areaPreferenceCode ?? input.areaPreferenceCode,
        depositRequiredAmount: reservationDepositRule(domain.config, requestedTable?.areaPreferenceCode ?? input.areaPreferenceCode).depositAmount,
        depositCurrency: reservationDepositRule(domain.config, requestedTable?.areaPreferenceCode ?? input.areaPreferenceCode).currency,
        actorId: reference,
        occurredAt: new Date(current).toISOString(),
      })
      return { reservation, replayed }
      }))
    } catch (error) {
      return publicMutationError(reply, error)
    }
    if (result.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.status(result.replayed ? 200 : 201).send(publicReservation(result.reservation))
  })

  app.put('/api/public/reservations/:reservationId', async (request, reply) => {
    const identity = await authenticate(request, reply)
    if (!identity) return
    const params = reservationParamsSchema.safeParse(request.params)
    const parsed = updateSchema.safeParse(request.body)
    if (!params.success || !parsed.success) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_INPUT_INVALID', message: '请检查要修改的预约信息' })
    }
    const current = new Date(now()).toISOString()
    const actorReference = `public-reservation:${identity.customerId}`
    let reservation: Reservation
    try {
      reservation = await repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const existing = domain.reservations.find((item) => item.id === params.data.reservationId)
      if (!existing || !ownsReservation(existing, actorReference)) throw new PublicReservationAccessError('只能修改自己提交的预约', 'PUBLIC_RESERVATION_FORBIDDEN')
      if (!['requested', 'confirmed'].includes(existing.status)) throw new Error('预约已到店或结束，需要调整请联系现场工作人员')
      const contact = contactReference(parsed.data, domain.config)
      const replay = domain.idempotencyRecords.some((record) => record.key === parsed.data.idempotencyKey)
      if (!replay) {
        assertPublicReservationAvailability(domain, {
          scheduledAt: parsed.data.scheduledAt,
          occurredAt: current,
          contactReference: contact,
          excludeReservationId: existing.id,
        })
      }
      const requestedTable = parsed.data.assignmentMode === 'self_select'
        ? assertPublicRequestedTableAvailable(runtime, domain, parsed.data.scheduledAt, parsed.data.requestedTableCode ?? '', existing.id)
        : null
      return updateReservationDetails(domain, {
        reservationId: existing.id,
        actorId: actorReference,
        occurredAt: current,
        idempotencyKey: parsed.data.idempotencyKey,
        customerName: parsed.data.customerName,
        contactReference: contact,
        partySize: parsed.data.partySize,
        assignmentMode: parsed.data.assignmentMode,
        requestedTableId: requestedTable?.id,
        requestedTableCode: requestedTable?.code,
        scheduledAt: parsed.data.scheduledAt,
        areaPreferenceCode: requestedTable?.areaPreferenceCode ?? parsed.data.areaPreferenceCode,
        occasionCode: parsed.data.occasionCode,
        occasionNote: parsed.data.occasionNote,
        reason: '客人在线修改预约',
      })
      }))
    } catch (error) {
      return publicMutationError(reply, error)
    }
    return publicReservation(reservation)
  })

  app.delete('/api/public/reservations/:reservationId', async (request, reply) => {
    const identity = await authenticate(request, reply)
    if (!identity) return
    const params = reservationParamsSchema.safeParse(request.params)
    const parsed = cancelSchema.safeParse(request.body)
    if (!params.success || !parsed.success) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_INPUT_INVALID', message: '取消预约信息无效' })
    }
    const current = new Date(now()).toISOString()
    const actorReference = `public-reservation:${identity.customerId}`
    let reservation: Reservation
    try {
      reservation = await repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const existing = domain.reservations.find((item) => item.id === params.data.reservationId)
      if (!existing || !ownsReservation(existing, actorReference)) throw new PublicReservationAccessError('只能取消自己提交的预约', 'PUBLIC_RESERVATION_FORBIDDEN')
      const replay = domain.idempotencyRecords.some((record) => record.key === parsed.data.idempotencyKey)
      if (!replay && !['requested', 'confirmed'].includes(existing.status)) throw new Error('当前预约已经到店或结束，请联系现场工作人员处理')
      return cancelReservation(domain, {
        reservationId: existing.id,
        actorId: actorReference,
        occurredAt: current,
        idempotencyKey: parsed.data.idempotencyKey,
        reason: parsed.data.reason?.trim() || '客人在线取消预约',
      })
      }))
    } catch (error) {
      return publicMutationError(reply, error)
    }
    return publicReservation(reservation)
  })
}
