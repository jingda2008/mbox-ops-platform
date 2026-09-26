import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import { IdempotencyConflictError, IdempotencyInProgressError, type NormalizedCommandExecutor, type JsonCodec, type JsonValue } from './command-executor.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { CustomerNotFoundError } from './customer-repository.js'
import { MemberVisitRewardRepository, MemberVisitRewardError } from './member-visit-reward-repository.js'
import { readMemberScanCode } from './member-participation-query.js'
import { MemberVisitRepository, MemberVisitError } from './member-visit-repository.js'
import type { MemberVisit } from '../../src/shared/member-visit.js'

type Options = Pick<CustomerBenefitApiOptions, 'transactions' | 'resolveStaffContext'> & { commands: Pick<NormalizedCommandExecutor, 'execute'> }
const member = z.string().trim().min(1).max(160).transform(readMemberScanCode)
const codec: JsonCodec<MemberVisit> = { encode: value => value as unknown as JsonValue, decode: value => value as unknown as MemberVisit }
const commandBody = z.object({ code: member, businessDate: z.iso.date(), visitId: z.uuid().optional(), reason: z.string().trim().min(2).max(300).optional() }).strict()

export const memberVisitApiPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'private, no-store') })
  app.setErrorHandler((error, _request, reply) => {
    if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'MEMBER_VISIT_FORBIDDEN', message: '当前账号没有会员到店签到权限，请由有权限员工办理' } })
    if (error instanceof CustomerNotFoundError) return reply.code(404).send({ error: { code: 'MEMBER_VISIT_MEMBER_NOT_FOUND', message: '会员不存在、已停用或不属于当前门店' } })
    if (error instanceof z.ZodError || error instanceof TypeError) return reply.code(400).send({ error: { code: 'MEMBER_VISIT_INVALID', message: '请重新扫码并核对签到信息' } })
    if (error instanceof MemberVisitRewardError) return reply.code(409).send({ error: { code: 'MEMBER_VISIT_REWARD_BUSY', message: error.message } })
    if (error instanceof MemberVisitError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) return reply.code(409).send({ error: { code: 'MEMBER_VISIT_RETRY', message: '原签到操作正在处理或已变化，请读取状态后重试' } })
    throw error
  })
  app.post('/staff/member-visits/lookup', { bodyLimit: 2048 }, async request => {
    const context = await options.resolveStaffContext(request)
    const { code } = z.object({ code: member }).strict().parse(request.body)
    return { data: await options.transactions.run(context.scope, async tx => {
      const access = await new StaffAccessRepository(tx).assertPermission(context.employeeId, 'loyalty.account.view')
      return { memberNo: code, businessDate: context.businessDate, canCheckIn: access.permissions.includes('customer.relationship.manage'),
        visit: await new MemberVisitRepository(tx).current(code, context.businessDate),
        rewards: await new MemberVisitRewardRepository(tx).progressForMember(code) }
    }, { readOnly: true }) }
  })
  for (const action of ['check-in', 'cancel'] as const) app.post(`/staff/member-visits/${action}`, { bodyLimit: 2048 }, async request => {
    const context = await options.resolveStaffContext(request)
    const input = commandBody.parse(request.body)
    if (action === 'cancel' && (!input.visitId || !input.reason)) throw new TypeError('撤回需要原签到与原因')
    if (action === 'check-in' && (input.visitId || input.reason)) throw new TypeError('签到参数不正确')
    const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
    const authorize = async (tx: import('./transaction-runner.js').ScopedTransaction) => {
      await new StaffAccessRepository(tx).assertPermission(context.employeeId, 'loyalty.account.view')
      await new StaffAccessRepository(tx).assertPermission(context.employeeId, 'customer.relationship.manage')
    }
    await options.transactions.run(context.scope, authorize, { readOnly: true })
    const result = await options.commands.execute({ scope: context.scope, operationScope: `member.visit.${action}`, idempotencyKey,
      requestFingerprint: JSON.stringify({ employeeId: context.employeeId, ...input }), resultCodec: codec }, async tx => {
      await authorize(tx)
      if (context.businessDate !== input.businessDate) throw new MemberVisitError('已切换营业日，请重新读取后签到', 'MEMBER_VISIT_DAY_CHANGED')
      const repo = new MemberVisitRepository(tx)
      const { visit, changed } = action === 'check-in' ? await repo.checkIn(input.code, input.businessDate, context.employeeId)
        : await repo.cancel(input.code, input.businessDate, input.visitId!, context.employeeId, input.reason!)
      return { result: visit, auditEvents: changed ? [{ actor: { type: 'employee' as const, employeeId: context.employeeId },
        businessDate: input.businessDate, action: `member.visit.${action}`, objectType: 'member_visit_checkin', objectId: visit.id,
        reason: action === 'check-in' ? '员工现场确认会员到店' : input.reason!, afterData: { status: visit.status, businessDate: visit.businessDate } }] : [], outboxMessages: [] }
    })
    return { data: result.value, meta: { replayed: result.replayed } }
  })
}
