import type { FastifyInstance } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { PilotEmployeeOption } from '../src/shared/auth-contracts.js'
import type { RuntimeRepository } from './repository.js'
import { signStaffSession } from './auth-context.js'

const pilotLoginSchema = z.object({
  accessCode: z.string().min(1).max(256),
  actorId: z.string().min(1).max(128).optional(),
  employeePin: z.string().regex(/^\d{6,12}$/).optional(),
}).strict()

interface AttemptWindow {
  count: number
  resetAt: number
}

interface PilotAuthOptions {
  accessCode: string
  employeePins: Record<string, string>
  sessionSecret: string
  sessionHours: number
}

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
  const attempts = new Map<string, AttemptWindow>()

  app.post('/api/auth/pilot-login', async (request, reply) => {
    const now = Date.now()
    const key = request.ip
    const previous = attempts.get(key)
    const window = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + 10 * 60_000 } : previous
    if (window.count >= 5) {
      return reply.status(429).send({ code: 'PILOT_LOGIN_RATE_LIMITED', message: '验证失败次数过多，请10分钟后重试' })
    }

    const input = pilotLoginSchema.parse(request.body)
    if (!sameSecret(input.accessCode, options.accessCode)) {
      window.count += 1
      attempts.set(key, window)
      return reply.status(401).send({ code: 'PILOT_ACCESS_DENIED', message: '门店验证口令错误' })
    }
    const state = await repository.read()
    const employees = employeeOptions(state)
    if (!input.actorId) {
      attempts.delete(key)
      return { employees }
    }

    const employee = employees.find((item) => item.id === input.actorId)
    if (!employee) return reply.status(403).send({ code: 'PILOT_ACTOR_FORBIDDEN', message: '员工不存在或已停用' })
    const expectedPin = options.employeePins[employee.id]
    if (!input.employeePin || !expectedPin || !sameSecret(input.employeePin, expectedPin)) {
      window.count += 1
      attempts.set(key, window)
      return reply.status(401).send({ code: 'PILOT_EMPLOYEE_PIN_DENIED', message: '员工PIN错误' })
    }
    attempts.delete(key)
    const expiresAt = now + options.sessionHours * 60 * 60_000
    return {
      token: signStaffSession({ actorId: employee.id, storeId: state.store.id, issuedAt: now, expiresAt }, options.sessionSecret),
      expiresAt,
      employee,
    }
  })
}
