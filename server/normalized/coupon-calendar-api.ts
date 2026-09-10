import type { FastifyPluginAsync } from 'fastify'
import type { MembershipConfigurationApiOptions } from './membership-configuration-api.js'
import { CouponCalendarRepository, CouponCalendarConflictError } from './coupon-calendar-repository.js'
import { CouponCalendarError } from './coupon-calendar.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'

export const couponCalendarApiPlugin: FastifyPluginAsync<MembershipConfigurationApiOptions> = async (app, options) => {
  app.setErrorHandler((error, _request, reply) => {
    if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有对应的券规则操作权限' } })
    if (error instanceof CouponCalendarError) return reply.code(400).send({ error: { code: 'COUPON_CALENDAR_INVALID', message: error.message } })
    if (error instanceof CouponCalendarConflictError) return reply.code(409).send({ error: { code: 'COUPON_CALENDAR_CONFLICT', message: error.message } })
    throw error
  })
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store') })
  app.get('/staff/loyalty/coupon-calendar-versions', async request => {
    const context = await options.resolveStaffContext(request)
    const data = await options.transactions.run(context.scope, async transaction => {
      const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
      await access.assertPermission(context.employeeId, 'loyalty.configuration.view')
      return new CouponCalendarRepository(transaction).list()
    }, { readOnly: true })
    return { data }
  })
  app.post('/staff/loyalty/coupon-calendar-versions', { bodyLimit: 65_536 }, async (request, reply) => {
    const context = await options.resolveStaffContext(request)
    const body = readBody(request.body)
    const data = await options.transactions.run(context.scope, async transaction => {
      const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
      await access.assertPermission(context.employeeId, 'loyalty.configuration.edit')
      return new CouponCalendarRepository(transaction).save({ code: body.code as string, rule: body.rule, limits: body.limits,
        reason: body.reason as string, expectedVersion: body.expectedVersion as number, requestKey: request.headers['idempotency-key'] as string,
        employeeId: context.employeeId, businessDate: context.businessDate })
    })
    return reply.code(data.replayed ? 200 : 201).send({ data })
  })
  app.post<{ Params: { id: string } }>('/staff/loyalty/coupon-calendar-versions/:id/decisions', { bodyLimit: 4096 }, async request => {
    const context = await options.resolveStaffContext(request)
    const body = readBody(request.body)
    const data = await options.transactions.run(context.scope, transaction => new CouponCalendarRepository(transaction).decide({
      versionId: request.params.id, action: body.action as 'approve' | 'publish' | 'stop_issuing', reason: body.reason as string,
      employeeId: context.employeeId, businessDate: context.businessDate,
    }))
    return { data }
  })
}
function readBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CouponCalendarError('券规则请求内容无效')
  return value as Record<string, unknown>
}
