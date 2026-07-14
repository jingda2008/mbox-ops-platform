import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RuntimeState } from '../src/shared/contracts.js'
import type {
  Reservation,
  ReservationConfig,
  ReservationState,
} from '../src/shared/reservation-contracts.js'
import { createReservation } from './reservation-domain.js'
import { mutateReservationState, reservationsFor } from './reservation-api.js'
import type { RuntimeRepository } from './repository.js'
import type { WechatApiIdentityRepository, WechatApiSessionRecord } from './wechat-api.js'

type RuntimeStateWithReservations = RuntimeState & { reservationState?: ReservationState }

const idempotencyKeySchema = z.string().trim().min(8).max(128)
const createSchema = z.object({
  customerName: z.string().trim().min(1).max(100),
  partySize: z.number().int().positive(),
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  occasionCode: z.enum(['birthday', 'anniversary', 'business', 'other']).optional(),
  occasionNote: z.string().trim().max(500).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  idempotencyKey: idempotencyKeySchema,
}).strict()

interface WechatReservationIdentityRepository {
  findSession(accessTokenHash: string): ReturnType<WechatApiIdentityRepository['findSession']>
}

export interface WechatReservationOptions {
  identityRepository: WechatReservationIdentityRepository
  tenantId: string
  storeId: string
  appId?: string
  now?: () => number
}

interface AuthenticatedSession {
  session: WechatApiSessionRecord
  principalReference: string
  memberReference: string | null
}

function hashAccessToken(value: string) {
  return createHash('sha256').update(value).digest('base64url')
}

function publicConfig(config: ReservationConfig) {
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
    depositStatus: reservation.deposit.status,
    tableCode: reservation.tableCode,
    requestedAt: reservation.requestedAt,
    updatedAt: reservation.updatedAt,
  }
}

function sendIdentityFailure(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.status(statusCode).send({ code, message })
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  options: WechatReservationOptions,
): Promise<AuthenticatedSession | null> {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    sendIdentityFailure(reply, 401, 'WECHAT_SESSION_REQUIRED', '缺少微信身份会话')
    return null
  }
  const accessToken = authorization.slice(7).trim()
  if (accessToken.length < 32 || accessToken.length > 512 || accessToken.includes(' ')) {
    sendIdentityFailure(reply, 401, 'WECHAT_SESSION_INVALID', '微信身份会话格式无效')
    return null
  }

  let session: WechatApiSessionRecord | null
  try {
    session = await options.identityRepository.findSession(hashAccessToken(accessToken))
  } catch {
    sendIdentityFailure(reply, 503, 'IDENTITY_STORE_UNAVAILABLE', '微信身份存储暂不可用')
    return null
  }
  if (!session || session.revokedAt !== null || session.expiresAt <= (options.now ?? Date.now)()) {
    sendIdentityFailure(reply, 401, 'WECHAT_SESSION_INVALID', '微信身份会话无效、已退出或已过期')
    return null
  }
  const principal = session.principal
  if (
    principal.tenantId !== options.tenantId
    || principal.storeId !== options.storeId
    || (options.appId && principal.appId !== options.appId)
  ) {
    sendIdentityFailure(reply, 403, 'WECHAT_RESERVATION_SCOPE_FORBIDDEN', '微信身份不属于当前预约门店')
    return null
  }
  return {
    session,
    principalReference: `wechat-principal:${principal.principalId}`,
    memberReference: principal.memberId ? `member:${principal.memberId}` : null,
  }
}

function ownsReservation(reservation: Reservation, identity: AuthenticatedSession) {
  const references = new Set([
    identity.principalReference,
    ...(identity.memberReference ? [identity.memberReference] : []),
  ])
  return references.has(reservation.customerReference) || references.has(reservation.contactReference)
}

export function registerWechatReservationRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: WechatReservationOptions,
) {
  app.get('/api/wechat/reservations', async (request, reply) => {
    const identity = await authenticate(request, reply, options)
    if (!identity) return
    const state = await repository.read() as RuntimeStateWithReservations
    const domain = reservationsFor(state)
    return {
      config: publicConfig(domain.config),
      reservations: domain.reservations
        .filter((reservation) => ownsReservation(reservation, identity))
        .toSorted((left, right) => right.scheduledAt.localeCompare(left.scheduledAt))
        .map(publicReservation),
    }
  })

  app.post('/api/wechat/reservations', async (request, reply) => {
    const identity = await authenticate(request, reply, options)
    if (!identity) return
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        code: 'WECHAT_RESERVATION_INPUT_INVALID',
        message: parsed.error.issues[0]?.message ?? '预约信息无效',
      })
    }
    const input = parsed.data
    const scheduledAt = Date.parse(input.scheduledAt)
    const currentTime = (options.now ?? Date.now)()
    if (scheduledAt < currentTime + 15 * 60_000) {
      return reply.status(400).send({
        code: 'WECHAT_RESERVATION_TIME_INVALID',
        message: '预约时间至少需要提前15分钟',
      })
    }
    if (scheduledAt > currentTime + 180 * 24 * 60 * 60_000) {
      return reply.status(400).send({
        code: 'WECHAT_RESERVATION_TIME_INVALID',
        message: '最多可预约未来180天',
      })
    }
    const actorId = `wechat:${identity.session.principal.principalId}`
    const customerReference = identity.memberReference ?? identity.principalReference
    const result = await repository.mutate((runtime) => {
      const state = runtime as RuntimeStateWithReservations
      return mutateReservationState(state, (domain) => {
        const existing = domain.idempotencyRecords.find((record) => record.key === input.idempotencyKey)
        const replayed = existing?.operation === 'reservation.create'
        const reservationId = replayed ? existing.reservationId : randomUUID()
        const reservation = createReservation(domain, {
          ...input,
          reservationId,
          customerReference,
          contactReference: identity.principalReference,
          sourceCode: 'wechat',
          depositRequiredAmount: 0,
          depositCurrency: 'CNY',
          actorId,
          occurredAt: new Date((options.now ?? Date.now)()).toISOString(),
        })
        return { reservation, replayed }
      })
    })
    if (result.replayed) reply.header('Idempotent-Replayed', 'true')
    return reply.status(result.replayed ? 200 : 201).send(publicReservation(result.reservation))
  })
}
