import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { Reservation, ReservationState } from '../src/shared/reservation-contracts.js'
import { createReservation } from './reservation-domain.js'
import { mutateReservationState, reservationsFor } from './reservation-api.js'
import type { RuntimeRepository } from './repository.js'

type RuntimeStateWithReservations = RuntimeState & { reservationState?: ReservationState }

const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
const SESSION_ISSUE_LIMIT = 20
const SESSION_ISSUE_WINDOW_MS = 60 * 60_000

const createSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  partySize: z.number().int().positive(),
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(128),
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
  return {
    version: state.config.version,
    minimumPartySize: state.config.minimumPartySize,
    maximumPartySize: state.config.maximumPartySize,
    areaPreferences: state.config.areaPreferences
      .filter((item) => item.enabled)
      .toSorted((left, right) => left.sortOrder - right.sortOrder)
      .map(({ code, name }) => ({ code, name })),
    occasions: state.config.occasions
      .filter((item) => item.enabled)
      .map(({ code, name }) => ({ code, name })),
  }
}

function publicReservation(reservation: Reservation) {
  return {
    id: reservation.id,
    customerName: reservation.customerName,
    partySize: reservation.partySize,
    areaPreferenceCode: reservation.areaPreferenceCode,
    occasionCode: reservation.occasionCode,
    occasionNote: reservation.occasionNote,
    scheduledAt: reservation.scheduledAt,
    status: reservation.status,
    tableCode: reservation.tableCode,
    requestedAt: reservation.requestedAt,
    updatedAt: reservation.updatedAt,
  }
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
  options: { secret: string; now?: () => number },
) {
  const now = options.now ?? Date.now
  const issues = new Map<string, { startedAt: number; count: number }>()

  app.post('/api/public/reservation-session', async (request, reply) => {
    const current = now()
    const existing = issues.get(request.ip)
    const window = !existing || current - existing.startedAt >= SESSION_ISSUE_WINDOW_MS
      ? { startedAt: current, count: 0 }
      : existing
    if (window.count >= SESSION_ISSUE_LIMIT) {
      return reply.status(429).send({ code: 'PUBLIC_RESERVATION_RATE_LIMITED', message: '请求过于频繁，请稍后再试' })
    }
    window.count += 1
    issues.set(request.ip, window)
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
        .filter((item) => item.customerReference === reference)
        .toSorted((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))
        .map(publicReservation),
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
    const scheduledAt = Date.parse(input.scheduledAt)
    const current = now()
    if (scheduledAt < current + 15 * 60_000 || scheduledAt > current + 180 * 24 * 60 * 60_000) {
      return reply.status(400).send({ code: 'PUBLIC_RESERVATION_TIME_INVALID', message: '预约时间需提前15分钟且不超过未来180天' })
    }
    const reference = `public-reservation:${identity.customerId}`
    const result = await repository.mutate((runtime) => mutateReservationState(runtime as RuntimeStateWithReservations, (domain) => {
      const existing = domain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
      const replayed = existing?.operation === 'reservation.create'
      const reservationId = replayed ? existing.reservationId : randomUUID()
      const sourceCode = domain.config.sources.find((source) => source.code === 'wechat' && source.enabled)?.code
        ?? domain.config.sources.find((source) => source.enabled)?.code
      if (!sourceCode) throw new Error('当前没有可用预约来源')
      const reservation = createReservation(domain, {
        ...input,
        reservationId,
        customerReference: reference,
        contactReference: reference,
        sourceCode,
        depositRequiredAmount: 0,
        depositCurrency: 'CNY',
        actorId: reference,
        occurredAt: new Date(current).toISOString(),
      })
      return { reservation, replayed }
    }))
    if (result.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.status(result.replayed ? 200 : 201).send(publicReservation(result.reservation))
  })
}
