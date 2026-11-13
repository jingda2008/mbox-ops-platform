import { channelManagementSchemas } from '../../src/shared/channel-distribution.js'
import { createHash } from 'node:crypto'
import { WechatMiniProgramCodeError, type WechatMiniProgramCodeInput } from './wechat-mini-program-code.js'
import { PricingAuthorizationDeniedError } from './pricing-authorization-policy.js'
import { registerChannelOperationsRoutes } from './channel-operations-api.js'
import { registerChannelFinanceRoutes } from './channel-finance-api.js'
import { fulfillChannelGift } from './channel-gift-service.js'
import type { CommerceCommandService } from './commerce-command-service.js'
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyReceiptUnavailableError, NativeCommandNotCommittedError, type JsonCodec, type JsonValue, type NormalizedCommandExecutor } from './command-executor.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { assertEmployeeTableSessionAccess, assertEmployeeTableSessionReadAccess, EmployeeTableAccessDeniedError } from './employee-table-access.js'
import { readMemberScanCode, resolveMemberScanCustomer } from './member-participation-query.js'
import { CustomerNotFoundError } from './customer-repository.js'
import { guestSessionIdFromActorRef } from './guest-table-authority.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { registerChannelPartnerRoutes } from './channel-partner-api.js'

export type ChannelApiOptions = Pick<CustomerBenefitApiOptions, 'transactions' | 'resolveSelfContext' | 'resolveGuestContext' | 'resolveStaffContext'> & { commands: Pick<NormalizedCommandExecutor, 'execute'>; commerce?: Pick<CommerceCommandService,'submitOrderInTransaction'>; miniCode?: { appId: string; render(input: Readonly<WechatMiniProgramCodeInput>): Promise<Buffer> } }
const uuid = z.string().uuid()
const code = z.string().trim().min(8).max(100).transform(v => {
  const normalized = v.replace(/^MBOX_CHANNEL_V1:/, '')
  return /^[A-Za-z2-9]{8,16}$/.test(normalized) ? normalized.toUpperCase() : normalized
})
const keySchema = z.string().regex(/^channel-[a-zA-Z0-9_-]{16,100}$/)
const reason = z.string().trim().min(2).max(500)
const codec: JsonCodec<unknown> = { encode: value => value as JsonValue, decode: value => value }
const schemas = {
  claim: z.object({ code }).strict(),
  activate: z.object({ claimId: uuid }).strict(),
  staff: z.object({ code, memberCode: z.string().min(1).max(160).transform(readMemberScanCode).optional(), customerId: uuid.optional(), tableSessionId: uuid, claimId: uuid.optional(), issueNew: z.boolean().optional() }).strict()
    .refine(v => Boolean(v.memberCode) !== Boolean(v.customerId), '请选择一位本桌顾客或扫描会员码')
    .refine(v => !(v.claimId && v.issueNew), '已有券使用和新增领取不能同时选择'),
  partner: channelManagementSchemas.partner,
  campaign: channelManagementSchemas.campaign,
  batch: channelManagementSchemas.batch,
}

export const channelDistributionApiPlugin: FastifyPluginAsync<ChannelApiOptions> = async (app, options) => {
  registerChannelPartnerRoutes(app, options)
  registerChannelFinanceRoutes(app, options)
  registerChannelOperationsRoutes(app, options)
  app.addHook('preHandler',async request=>{
    // Classify the registered route; query text must never choose an identity resolver.
    const route=request.routeOptions.url??''
    if(!route.includes('/public/mini/channel/')&&!route.includes('/guest/channel/'))return
    const ctx=route.includes('/guest/channel/')?await options.resolveGuestContext(request):await options.resolveSelfContext(request)
    const n=await options.transactions.run(ctx.scope,async tx=>(await tx.query<{count:number}>(`INSERT INTO mbox.channel_request_buckets(tenant_id,store_id,actor_hash,minute,count) VALUES($1,$2,$3,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(tenant_id,store_id,actor_hash,minute) DO UPDATE SET count=channel_request_buckets.count+1 RETURNING count`,[ctx.scope.tenantId,ctx.scope.storeId,createHash('sha256').update(ctx.customerId).digest('hex')])).rows[0]!.count)
    if(n>60)throw new ChannelDistributionError('RATE_LIMIT',429)
  })
  app.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'private, no-store') })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WechatMiniProgramCodeError) return reply.code(503).send({ error: { code: error.code, message: error.message } })
    if (error instanceof NativeCommandNotCommittedError) {
      const original = error.original
      return reply.code(original instanceof ChannelDistributionError ? original.statusCode : 409).send({ error: {
        code: original instanceof ChannelDistributionError ? original.code : 'CHANNEL_NOT_COMMITTED',
        message: original instanceof ChannelDistributionError || original instanceof PricingAuthorizationDeniedError ? original.message : '操作未提交，请刷新核对', commitDisposition: 'not_committed',
      } })
    }
    if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    if (error instanceof ChannelDistributionError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    if (error instanceof StaffAccessDeniedError || error instanceof EmployeeTableAccessDeniedError) return reply.code(403).send({ error: { code: 'CHANNEL_FORBIDDEN', message: '没有此操作或此桌权限' } })
    if (error instanceof CustomerNotFoundError) return reply.code(404).send({ error: { code: 'CHANNEL_CUSTOMER_NOT_FOUND', message: '请确认顾客有效身份' } })
    if (error instanceof z.ZodError || error instanceof TypeError) return reply.code(400).send({ error: { code: 'CHANNEL_INVALID', message: '请核对优惠号码、顾客和本次桌号' } })
    if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError || error instanceof IdempotencyReceiptUnavailableError) return reply.code(409).send({ error: { code: 'CHANNEL_RECEIPT', message: '请恢复原操作并核对结果，不能换编号重做' } })
    if (error instanceof Error && 'code' in error && ['23503', '23505', '23514'].includes(String(error.code))) return reply.code(409).send({ error: { code: 'CHANNEL_CONFLICT', message: '关联记录或状态已变化，请重新读取核对' } })
    throw error
  })

  app.get('/public/mini/channel/wallet', async request => {
    const ctx = await options.resolveSelfContext(request)
    const input=z.object({limit:z.coerce.number().int().min(1).max(100).optional(),cursor:uuid.optional(),
      status:z.enum(['all','available','active','fulfilled','expired','revoked']).optional(),code:code.optional()}).strict().parse(request.query)
    const page=await options.transactions.run(ctx.scope, tx => new ChannelDistributionRepository(tx).walletPage(ctx.customerId,input), { readOnly: true })
    return {data:page.items,meta:{nextCursor:page.nextCursor}}

  })

  app.get('/public/mini/channel/offer', async request => {
    const ctx = await options.resolveSelfContext(request), input = z.object({ code }).strict().parse(request.query)
    return { data: await options.transactions.run(ctx.scope, tx => new ChannelDistributionRepository(tx).customerOffer(input.code, ctx.customerId), { readOnly: true }) }
  })

  for (const action of ['claim', 'activate'] as const) app.post(action === 'claim' ? '/public/mini/channel/claim' : '/guest/channel/activate', { bodyLimit: 2048 }, async request => {
    const ctx = action === 'claim' ? await options.resolveSelfContext(request) : await options.resolveGuestContext(request)
    const input = schemas[action].parse(request.body), idempotencyKey = keySchema.parse(request.headers['idempotency-key'])
    const authorize = async (tx: ScopedTransaction) => {
      const repo = new ChannelDistributionRepository(tx)
      await repo.lockIdentity()
      await repo.verifiedCustomer(ctx.customerId)
      if (action === 'activate') {
        const guestSessionId = guestSessionIdFromActorRef(ctx.actorRef)
        if (!ctx.tableSessionId || !guestSessionId) throw new ChannelDistributionError('OWNERSHIP', 403)
        const table = await tx.query(`SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='open' FOR UPDATE`, [ctx.scope.tenantId, ctx.scope.storeId, ctx.tableSessionId])
        if (!table.rows[0]) throw new ChannelDistributionError('OWNERSHIP', 403)
        const locked = await tx.query<{ id: string | null }>('SELECT mbox.lock_active_table_guest_session_position($1::uuid,$2::uuid,$3::uuid) AS id', [ctx.tableSessionId, ctx.customerId, guestSessionId])
        if (!locked.rows[0]?.id) throw new ChannelDistributionError('OWNERSHIP', 403)
      }
    }
    const result = await options.commands.execute({ scope: ctx.scope, operationScope: `channel.self.${action}`, idempotencyKey,
      requestFingerprint: JSON.stringify({ input, customerId: ctx.customerId, tableSessionId: ctx.tableSessionId }), resultCodec: codec,
      retainReceipt: true, rejectExpiredReceipt: true, replayOnly: request.headers['x-channel-recovery'] === '1', authorizeReplay: authorize }, async tx => {
      const repo = new ChannelDistributionRepository(tx)
      const value = action === 'claim' ? await repo.issue((input as z.infer<typeof schemas.claim>).code, ctx.customerId, 'self', false, ctx.actorRef)
        : await repo.activate((input as z.infer<typeof schemas.activate>).claimId, ctx.customerId, ctx.tableSessionId!, ctx.actorRef)
      return { result: value, auditEvents: [{ actor: { type: 'guest', ref: ctx.actorRef }, businessDate: ctx.businessDate,
        action: `channel.${action}`, objectType: 'channel_claim', objectId: value.claimId, afterData: { status: value.status } }], outboxMessages: [] }
    }, authorize)
    return { data: result.value, meta: { replayed: result.replayed } }
  })

  app.post('/staff/channel/preview', { bodyLimit: 2048 }, async request => {
    const ctx = await options.resolveStaffContext(request), input = schemas.staff.parse(request.body)
    return { data: await options.transactions.run(ctx.scope, async tx => {
      await assertEmployeeTableSessionReadAccess(tx, { employeeId: ctx.employeeId, tableSessionId: input.tableSessionId, requiredPermissionCodes: ['channel.activate'] })
      const repo = new ChannelDistributionRepository(tx)
      const customer = input.memberCode ? await resolveMemberScanCustomer(tx, input.memberCode) : await repo.verifiedCustomer(input.customerId!)
      return repo.staffPreview(input.code, customer.id, input.tableSessionId)
    }, { readOnly: true }) }
  })

  app.post('/staff/channel/activate', { bodyLimit: 2048 }, async request => {
    const ctx = await options.resolveStaffContext(request), input = schemas.staff.parse(request.body)
    const idempotencyKey = keySchema.parse(request.headers['idempotency-key'])
    const authorize = async (tx: ScopedTransaction) => {
      await new ChannelDistributionRepository(tx).lockIdentity()
      await assertEmployeeTableSessionAccess(tx, { employeeId: ctx.employeeId, tableSessionId: input.tableSessionId, requiredPermissionCodes: ['channel.activate'], lockTableSession: true })
    }
    const result = await options.commands.execute({ scope: ctx.scope, operationScope: 'channel.staff.activate', idempotencyKey,
      requestFingerprint: JSON.stringify({ input, employeeId: ctx.employeeId }), resultCodec: codec, retainReceipt: true,
      rejectExpiredReceipt: true, replayOnly: request.headers['x-channel-recovery'] === '1', authorizeReplay: authorize }, async tx => {
      const repo = new ChannelDistributionRepository(tx)
      const customer = input.memberCode ? await resolveMemberScanCustomer(tx, input.memberCode) : await repo.verifiedCustomer(input.customerId!)
      const coupon = input.claimId ? await repo.selectClaim(input.code, input.claimId, customer.id)
        : await repo.issue(input.code, customer.id, 'staff', !input.issueNew, `employee:${ctx.employeeId}`)
      const activated = await repo.activate(coupon.claimId, customer.id, input.tableSessionId, `employee:${ctx.employeeId}`)
      return { result: activated, auditEvents: [{ actor: { type: 'employee', employeeId: ctx.employeeId }, businessDate: ctx.businessDate,
        action: 'channel.staff.activate', objectType: 'channel_claim', objectId: coupon.claimId, afterData: { visitId: activated.visitId!, tableSessionId: input.tableSessionId } }], outboxMessages: [] }
    }, authorize)
    return { data: result.value, meta: { replayed: result.replayed } }
  })

  app.get('/staff/channel/table/:tableSessionId', async request => {
    const ctx = await options.resolveStaffContext(request), { tableSessionId } = z.object({ tableSessionId: uuid }).parse(request.params)
    return { data: await options.transactions.run(ctx.scope, async tx => {
      await assertEmployeeTableSessionAccess(tx, { employeeId: ctx.employeeId, tableSessionId, requiredPermissionCodes: ['channel.activate'] })
      const rows = (await tx.query<{ id: string }>(`SELECT DISTINCT mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id) AS id
        FROM mbox.table_session_customer_participations p WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND left_at IS NULL`, [ctx.scope.tenantId, ctx.scope.storeId, tableSessionId])).rows
      const customers = []
      for (const row of rows) {
        try { const customer = await new ChannelDistributionRepository(tx).verifiedCustomer(row.id); customers.push({ id: customer.id, label: `${customer.displayName ?? '本桌顾客'} · ${customer.id.slice(-8)}` }) }
        catch (error) { if (!(error instanceof ChannelDistributionError && error.code === 'AUTH_REQUIRED')) throw error }
      }
      const activations = (await tx.query(`SELECT a.id,q.id AS "claimId",q.status,EXISTS(SELECT 1 FROM mbox.channel_visits v WHERE (v.tenant_id,v.store_id,v.id)=(a.tenant_id,a.store_id,a.visit_id) AND v.arrival_confirmed_at IS NOT NULL) AS "arrivalConfirmed",b.rule_snapshot->'offer' AS offer,(SELECT g.order_id FROM mbox.channel_gift_promises g WHERE (g.tenant_id,g.store_id,g.claim_id)=(q.tenant_id,q.store_id,q.id)) AS "giftOrderId",b.rule_snapshot->>'title' AS title,p.name AS "sourceLabel",v.stacking_allowed AS "allowStacking",v.discount_cap_minor::integer AS "visitDiscountCapMinor",(SELECT COALESCE(sum(used.applied_discount_minor),0)::bigint::text FROM mbox.channel_activations used WHERE (used.tenant_id,used.store_id,used.visit_id)=(v.tenant_id,v.store_id,v.id)) AS "usedDiscountMinor"
        FROM mbox.channel_visit_tables t JOIN mbox.channel_activations a ON (a.tenant_id,a.store_id,a.visit_id)=(t.tenant_id,t.store_id,t.visit_id)
        JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(a.tenant_id,a.store_id,a.visit_id)
        JOIN mbox.channel_claims q ON (q.tenant_id,q.store_id,q.id)=(a.tenant_id,a.store_id,a.claim_id)
        JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
        JOIN mbox.channel_partners p ON (p.tenant_id,p.store_id,p.id)=(b.tenant_id,b.store_id,b.partner_id)
        WHERE t.tenant_id=$1 AND t.store_id=$2 AND t.table_session_id=$3 AND t.detached_at IS NULL AND a.status IN('active','fulfilled') ORDER BY a.created_at,a.id`, [ctx.scope.tenantId, ctx.scope.storeId, tableSessionId])).rows
      return { customers, activations }
    }) }
  })
  app.post('/staff/channel/fulfill-gift',{bodyLimit:2048},async request=>{
    const ctx=await options.resolveStaffContext(request),input=z.object({claimId:uuid,tableSessionId:uuid}).strict().parse(request.body)
    if(!options.commerce)throw new ChannelDistributionError('PAUSED')
    const authorize=async(tx:ScopedTransaction)=>{await new ChannelDistributionRepository(tx).lockIdentity();await assertEmployeeTableSessionAccess(tx,{employeeId:ctx.employeeId,tableSessionId:input.tableSessionId,requiredPermissionCodes:['channel.activate','order.create'],lockTableSession:true})}
    const result=await options.commands.execute({scope:ctx.scope,operationScope:'channel.gift.fulfill',idempotencyKey:keySchema.parse(request.headers['idempotency-key']),requestFingerprint:JSON.stringify({...input,employeeId:ctx.employeeId}),resultCodec:codec,
      retainReceipt:true,rejectExpiredReceipt:true,replayOnly:request.headers['x-channel-recovery']==='1',authorizeReplay:authorize},tx=>fulfillChannelGift(tx,options.commerce!,{...input,employeeId:ctx.employeeId,businessDate:ctx.businessDate}),authorize)
    return{data:result.value,meta:{replayed:result.replayed}}
  })

  app.post('/staff/channel/cancel-activation', { bodyLimit: 2048 }, async request => {
    const ctx = await options.resolveStaffContext(request), input = z.object({ activationId: uuid, tableSessionId: uuid, reason }).strict().parse(request.body)
    const authorize = async (tx: ScopedTransaction) => {
      await new ChannelDistributionRepository(tx).lockIdentity()
      await assertEmployeeTableSessionAccess(tx, { employeeId: ctx.employeeId, tableSessionId: input.tableSessionId, requiredPermissionCodes: ['channel.correct'], lockTableSession: true })
    }
    const result = await options.commands.execute({ scope: ctx.scope, operationScope: 'channel.activation.cancel', idempotencyKey: keySchema.parse(request.headers['idempotency-key']), requestFingerprint: JSON.stringify({ input, employeeId: ctx.employeeId }),
      resultCodec: codec, retainReceipt: true, rejectExpiredReceipt: true, replayOnly: request.headers['x-channel-recovery'] === '1', authorizeReplay: authorize }, async tx => ({
      result: await new ChannelDistributionRepository(tx).cancelActivation(input.activationId, input.tableSessionId, ctx.employeeId, input.reason),
      auditEvents: [{ actor: { type: 'employee', employeeId: ctx.employeeId }, businessDate: ctx.businessDate, action: 'channel.activation.cancel', objectType: 'channel_activation', objectId: input.activationId, reason: input.reason }], outboxMessages: [],
    }), authorize)
    return { data: result.value, meta: { replayed: result.replayed } }
  })

  for (const action of ['partner', 'campaign', 'batch'] as const) app.post(`/staff/channel/${action}`, { bodyLimit: action === 'batch' ? 512 * 1024 : 16384 }, async request => {
    const ctx = await options.resolveStaffContext(request), input = schemas[action].parse(request.body), idempotencyKey = keySchema.parse(request.headers['idempotency-key'])
    const authorize = async (tx: ScopedTransaction) => { await new StaffAccessRepository(tx).assertPermission(ctx.employeeId, 'channel.manage') }
    const result = await options.commands.execute({ scope: ctx.scope, operationScope: `channel.manage.${action}`, idempotencyKey,
      requestFingerprint: JSON.stringify({ input, employeeId: ctx.employeeId }), resultCodec: codec, retainReceipt: true,
      rejectExpiredReceipt: true, replayOnly: request.headers['x-channel-recovery'] === '1', authorizeReplay: authorize }, async tx => {
      const args = [ctx.scope.tenantId, ctx.scope.storeId], repo = new ChannelDistributionRepository(tx)
      let value: Record<string, unknown>
      if (action === 'partner') {
        const p = input as z.infer<typeof schemas.partner>
        const partner = (await tx.query<{ id: string }>(`INSERT INTO mbox.channel_partners(tenant_id,store_id,name,settlement_subject) VALUES($1,$2,$3,$4) RETURNING id`, [...args, p.name, p.settlementSubject])).rows[0]!
        const promoter = (await tx.query<{ id: string }>(`INSERT INTO mbox.channel_promoters(tenant_id,store_id,partner_id,name) VALUES($1,$2,$3,$4) RETURNING id`, [...args, partner.id, p.promoterName])).rows[0]!
        value = { id: partner.id, promoterId: promoter.id }
      } else if (action === 'campaign') {
        const p = input as z.infer<typeof schemas.campaign>
        value = (await tx.query(`INSERT INTO mbox.channel_campaigns(tenant_id,store_id,title,claim_limit,capacity_limit,cost_limit_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [...args, p.title, p.claimLimit, p.capacityLimit, p.costLimitMinor])).rows[0]!
      } else { value = await repo.createBatch(input as z.infer<typeof schemas.batch>); await tx.query(`UPDATE mbox.channel_batches SET created_by=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...args,value.id,ctx.employeeId]) }
      await repo.event(String(value.id), `manage.${action}`, `employee:${ctx.employeeId}`, { reason: input.reason }, input.reason)
      return { result: value, auditEvents: [{ actor: { type: 'employee', employeeId: ctx.employeeId }, businessDate: ctx.businessDate,
        action: `channel.manage.${action}`, objectType: `channel_${action}`, objectId: String(value.id), reason: input.reason }], outboxMessages: [] }
    }, authorize)
    return { data: result.value, meta: { replayed: result.replayed } }
  })
}
