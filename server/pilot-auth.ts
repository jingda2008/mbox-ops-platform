import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { PilotEmployeeOption } from '../src/shared/auth-contracts.js'
import type { RuntimeRepository } from './repository.js'
import { signStaffSession, signStoreAccessPass, verifyStoreAccessPass } from './auth-context.js'
import { DEFAULT_PRESENCE_LEASE_TTL_MS, endPresenceLease, establishPresenceLease } from './presence.js'
import type { RateLimitStore } from './rate-limit.js'
import type { PresenceLeaseStore } from './presence-store.js'
import { chinaDateKey, chinaStartOfDay, shiftDateKey } from '../src/shared/china-time.js'

const pilotLoginSchema = z.object({
  accessCode: z.string().min(1).max(256).optional(),
  storeAccessToken: z.string().min(20).max(4096).optional(),
  actorId: z.string().min(1).max(128).optional(),
  employeePin: z.string().regex(/^\d{4}$/).optional(),
}).strict().refine((input) => Boolean(input.accessCode || input.storeAccessToken), {
  message: '需要门店验证口令或当日凭证',
})

const pilotPinVerificationSchema = z.object({
  employeePin: z.string().regex(/^\d{4}$/),
}).strict()

interface PilotAuthOptions {
  accessCode: string
  employeePins: Record<string, string>
  sessionSecret: string
  sessionHours: number
  presenceLeaseTtlMs?: number
  rateLimitStore?: RateLimitStore
  presenceLeaseStore?: PresenceLeaseStore
  now?: () => number
}

const PILOT_LOGIN_RATE_LIMIT = { scope: 'pilot.login', limit: 5, windowMs: 15 * 60_000 } as const
const PILOT_PIN_VERIFICATION_RATE_LIMIT = { scope: 'pilot.pin-verification', limit: 5, windowMs: 15 * 60_000 } as const

function sameSecret(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function employeeOptions(state: Awaited<ReturnType<RuntimeRepository['read']>>): PilotEmployeeOption[] {
  const roleNames = new Map(state.config.roles.map((role) => [role.id, role.name]))
  return state.employees
    .filter((employee) => employee.status === 'active')
    .map((employee) => ({
      id: employee.id,
      displayName: employee.displayName,
      roleName: roleNames.get(employee.roleId) ?? employee.roleId,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
}

export async function registerPilotAuthRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: PilotAuthOptions,
) {
  if (!options.rateLimitStore) throw new Error('Pilot auth requires a persistent rateLimitStore')
  const rateLimitStore = options.rateLimitStore

  app.post('/api/auth/pilot-login', async (request, reply) => {
    const now = options.now?.() ?? Date.now()
    const key = request.ip
    const rejectFailedLogin = async (statusCode: 401 | 403, code: string, message: string) => {
      const decision = await rateLimitStore.consume({ ...PILOT_LOGIN_RATE_LIMIT, key })
      if (!decision.allowed) {
        return reply.status(429).send({ code: 'PILOT_LOGIN_RATE_LIMITED', message: '验证失败次数过多，请15分钟后重试' })
      }
      return reply.status(statusCode).send({ code, message })
    }

    const input = pilotLoginSchema.parse(request.body)
    const state = await repository.read()
    let storeAccessToken = input.storeAccessToken ?? ''
    let storeAccessExpiresAt = 0
    if (input.storeAccessToken) {
      try {
        const claims = verifyStoreAccessPass(input.storeAccessToken, options.sessionSecret, now)
        if (claims.storeId !== state.store.id || claims.chinaDate !== chinaDateKey(now)) {
          return rejectFailedLogin(401, 'STORE_ACCESS_PASS_INVALID', '今天需要重新验证门店口令')
        }
        storeAccessExpiresAt = claims.expiresAt
      } catch {
        return rejectFailedLogin(401, 'STORE_ACCESS_PASS_INVALID', '今天需要重新验证门店口令')
      }
    } else {
      if (!input.accessCode || !sameSecret(input.accessCode, options.accessCode)) {
        return rejectFailedLogin(401, 'PILOT_ACCESS_DENIED', '门店验证口令错误')
      }
      storeAccessExpiresAt = chinaStartOfDay(shiftDateKey(chinaDateKey(now), 1)).getTime()
      storeAccessToken = signStoreAccessPass({
        storeId: state.store.id,
        chinaDate: chinaDateKey(now),
        issuedAt: now,
        expiresAt: storeAccessExpiresAt,
      }, options.sessionSecret)
    }
    const employees = employeeOptions(state)
    if (!input.actorId) {
      await rateLimitStore.clear({ scope: PILOT_LOGIN_RATE_LIMIT.scope, key })
      return { employees, storeAccessToken, storeAccessExpiresAt }
    }

    const employee = employees.find((item) => item.id === input.actorId)
    if (!employee) return rejectFailedLogin(403, 'PILOT_ACTOR_FORBIDDEN', '员工不存在或已停用')
    const expectedPin = options.employeePins[employee.id]
    if (!input.employeePin || !expectedPin || !sameSecret(input.employeePin, expectedPin)) {
      return rejectFailedLogin(401, 'PILOT_EMPLOYEE_PIN_DENIED', '员工PIN错误')
    }
    const expiresAt = now + options.sessionHours * 60 * 60_000
    const sessionId = randomUUID()
    const leaseTtlMs = options.presenceLeaseTtlMs ?? DEFAULT_PRESENCE_LEASE_TTL_MS
    const loggedIn = await repository.mutate((working) => {
      const currentEmployee = employeeOptions(working).find((item) => item.id === input.actorId)
      if (!currentEmployee) throw new Error('员工在登录期间已停用')
      const lease = establishPresenceLease(working, {
        sessionId,
        actorId: currentEmployee.id,
        storeId: working.store.id,
        businessDate: working.store.businessDate,
        now,
        leaseTtlMs,
        sessionExpiresAt: expiresAt,
      })
      return { employee: currentEmployee, storeId: working.store.id, lease }
    })
    if (options.presenceLeaseStore) {
      try {
        await options.presenceLeaseStore.upsert(loggedIn.lease)
      } catch (error) {
        const compensated = await repository.mutate((working) => {
          endPresenceLease(working, sessionId, loggedIn.employee.id, now)
          return true
        }).catch((compensationError: unknown) => {
          app.log.error({ error: compensationError, sessionId, actorId: loggedIn.employee.id }, 'failed to compensate partial presence login')
          return false
        })
        if (!compensated) {
          throw new AggregateError([error], '在线租约写入失败，登录未生效且补偿需要后台核查')
        }
        throw error
      }
    }
    await rateLimitStore.clear({ scope: PILOT_LOGIN_RATE_LIMIT.scope, key })
    return {
      token: signStaffSession({ sessionId, actorId: loggedIn.employee.id, storeId: loggedIn.storeId, issuedAt: now, expiresAt }, options.sessionSecret),
      expiresAt,
      sessionId,
      presenceExpiresAt: loggedIn.lease.expiresAt,
      employee: loggedIn.employee,
      storeAccessToken,
      storeAccessExpiresAt,
    }
  })

  app.post('/api/auth/verify-pin', async (request, reply) => {
    const actor = request.mboxActor
    if (!actor) return reply.status(401).send({ code: 'AUTHENTICATION_REQUIRED', message: '请先登录员工账号' })
    const input = pilotPinVerificationSchema.parse(request.body)
    const key = `${request.ip}:${actor.actorId}`
    const expectedPin = options.employeePins[actor.actorId]
    if (!expectedPin || !sameSecret(input.employeePin, expectedPin)) {
      const decision = await rateLimitStore.consume({ ...PILOT_PIN_VERIFICATION_RATE_LIMIT, key })
      if (!decision.allowed) {
        return reply.status(429).send({ code: 'PILOT_PIN_VERIFICATION_RATE_LIMITED', message: 'PIN错误次数过多，请15分钟后再试' })
      }
      return reply.status(401).send({ code: 'PILOT_EMPLOYEE_PIN_DENIED', message: '员工PIN错误，请输入当前登录员工的PIN' })
    }
    await rateLimitStore.clear({ scope: PILOT_PIN_VERIFICATION_RATE_LIMIT.scope, key })
    return { verified: true, actorId: actor.actorId }
  })
}
