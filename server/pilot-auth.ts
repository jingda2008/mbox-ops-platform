import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { PilotEmployeeOption } from '../src/shared/auth-contracts.js'
import type { RuntimeRepository } from './repository.js'
import { signStaffSession } from './auth-context.js'
import { DEFAULT_PRESENCE_LEASE_TTL_MS, establishPresenceLease } from './presence.js'
import type { RateLimitStore } from './rate-limit.js'

const pilotLoginSchema = z.object({
  accessCode: z.string().min(1).max(256),
  actorId: z.string().min(1).max(128).optional(),
  employeePin: z.string().regex(/^\d{6,12}$/).optional(),
}).strict()

interface PilotAuthOptions {
  accessCode: string
  employeePins: Record<string, string>
  sessionSecret: string
  sessionHours: number
  presenceLeaseTtlMs?: number
  rateLimitStore?: RateLimitStore
}

const PILOT_LOGIN_RATE_LIMIT = { scope: 'pilot.login', limit: 5, windowMs: 10 * 60_000 } as const

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
    const now = Date.now()
    const key = request.ip
    const rejectFailedLogin = async (statusCode: 401 | 403, code: string, message: string) => {
      const decision = await rateLimitStore.consume({ ...PILOT_LOGIN_RATE_LIMIT, key })
      if (!decision.allowed) {
        return reply.status(429).send({ code: 'PILOT_LOGIN_RATE_LIMITED', message: '验证失败次数过多，请10分钟后重试' })
      }
      return reply.status(statusCode).send({ code, message })
    }

    const input = pilotLoginSchema.parse(request.body)
    if (!sameSecret(input.accessCode, options.accessCode)) {
      return rejectFailedLogin(401, 'PILOT_ACCESS_DENIED', '门店验证口令错误')
    }
    const state = await repository.read()
    const employees = employeeOptions(state)
    if (!input.actorId) {
      return { employees }
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
      return { employee: currentEmployee, storeId: working.store.id, presenceExpiresAt: lease.expiresAt }
    })
    await rateLimitStore.clear({ scope: PILOT_LOGIN_RATE_LIMIT.scope, key })
    return {
      token: signStaffSession({ sessionId, actorId: loggedIn.employee.id, storeId: loggedIn.storeId, issuedAt: now, expiresAt }, options.sessionSecret),
      expiresAt,
      sessionId,
      presenceExpiresAt: loggedIn.presenceExpiresAt,
      employee: loggedIn.employee,
    }
  })
}
