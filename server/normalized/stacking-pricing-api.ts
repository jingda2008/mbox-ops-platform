import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { calculateStackingPrice, StackingPricingError } from './stacking-pricing.js'
import type { MembershipConfigurationApiOptions } from './membership-configuration-api.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StackingDraftConflictError, StackingPricingDraftRepository } from './stacking-pricing-draft-repository.js'
import { CouponCalendarError, previewCouponCalendar, parseCouponCalendarRule, couponIssuanceValidity } from './coupon-calendar.js'

// Preview cannot authorize a discount. Published typed versions are selected by
// the independent coupon issuance/checkout authority, never by client prices.
export const stackingPricingApiPlugin: FastifyPluginAsync<MembershipConfigurationApiOptions> = async (app, options) => {
  app.post('/staff/loyalty/coupon-calendar-preview', { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try {
      const context = await options.resolveStaffContext(request)
      await options.transactions.run(context.scope, async transaction => {
        const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
        await access.assertPermission(context.employeeId, 'loyalty.configuration.preview')
      }, { readOnly: true })
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new CouponCalendarError('日历预览内容无效')
      const body = request.body as Record<string, unknown>
      const now = new Date()
      let rule = parseCouponCalendarRule(body.rule)
      if(rule.relativeValidity){
        if(typeof body.issuedAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(body.issuedAt))throw new CouponCalendarError('相对有效期预览须填写明确的模拟发放时间')
        rule={...rule,...couponIssuanceValidity(rule,new Date(body.issuedAt))}
      }
      const data = previewCouponCalendar(rule, now, body.previewFrom as string | undefined, body.days as number | undefined)
      return reply.send({ data: { ...data, asOf: now.toISOString(), mode: 'simulation', redemptionAuthorization: false } })
    } catch (error) { return handleError(reply, error) }
  })
  async function authorized(request: FastifyRequest, permission: string) {
    const context = await options.resolveStaffContext(request)
    return { context, permission }
  }
  app.get('/staff/loyalty/stacking-price-drafts', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { context, permission } = await authorized(request, 'loyalty.configuration.view')
      const data = await options.transactions.run(context.scope, async transaction => {
        const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
        await access.assertPermission(context.employeeId, permission)
        return new StackingPricingDraftRepository(transaction).list()
      }, { readOnly: true })
      return reply.send({ data })
    } catch (error) { return handleError(reply, error) }
  })
  app.post('/staff/loyalty/stacking-price-drafts', { bodyLimit: 16_384 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { context, permission } = await authorized(request, 'loyalty.configuration.edit')
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new StackingPricingError('草稿内容无效')
      const body = request.body as Record<string, unknown>
      const data = await options.transactions.run(context.scope, async transaction => {
        const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
        await access.assertPermission(context.employeeId, permission)
        return new StackingPricingDraftRepository(transaction).save({ code: body.code as string, policy: body.policy,
          reason: body.reason as string, expectedVersion: body.expectedVersion as number, requestKey: request.headers['idempotency-key'] as string,
          employeeId: context.employeeId, businessDate: context.businessDate })
      })
      return reply.code(data.replayed ? 200 : 201).send({ data })
    } catch (error) { return handleError(reply, error) }
  })
  app.post('/staff/loyalty/stacking-price-preview', { bodyLimit: 65_536 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try {
      const context = await options.resolveStaffContext(request)
      await options.transactions.run(context.scope, async transaction => {
        const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
        await access.assertPermission(context.employeeId, 'loyalty.configuration.preview')
      }, { readOnly: true })
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new StackingPricingError('试算内容无效')
      const body = request.body as Record<string, unknown>
      const result = calculateStackingPrice(body.policy, body.scenario)
      return reply.send({ data: { ...result, mode: 'simulation', orderAuthorization: false, currency: 'CNY' } })
    } catch (error) {
      return handleError(reply, error)
    }
  })
  app.post<{Params:{id:string}}>('/staff/loyalty/stacking-price-drafts/:id/decisions',{bodyLimit:4096},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store')
    try{
      const context=await options.resolveStaffContext(request)
      const body=request.body
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['action','reason'].includes(key)))throw new StackingPricingError('规则操作字段无效')
      const input=body as {action:'approve'|'publish'|'stop_issuing';reason:string}
      const data=await options.transactions.run(context.scope,transaction=>new StackingPricingDraftRepository(transaction).decide({versionId:request.params.id,...input,employeeId:context.employeeId,businessDate:context.businessDate}))
      return reply.send({data})
    }catch(error){return handleError(reply,error)}
  })
}
function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof CouponCalendarError) return reply.code(400).send({ error: { code: 'COUPON_CALENDAR_INVALID', message: error.message } })
  if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
  if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有对应的经营配置权限' } })
  if (error instanceof StackingPricingError) return reply.code(400).send({ error: { code: 'STACKING_PRICING_INVALID', message: error.message } })
  if (error instanceof StackingDraftConflictError) return reply.code(409).send({ error: { code: 'STACKING_DRAFT_CONFLICT', message: error.message } })
  throw error
}
