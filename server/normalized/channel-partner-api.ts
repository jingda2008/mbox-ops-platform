import { authorizeChannelWeb, channelWebScope, channelWebToken, inviteChannelWeb } from './channel-web-auth.js'
import { readChannelReport,channelReportCsv } from './channel-report.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ChannelApiOptions } from './channel-distribution-api.js'
import { ChannelPartnerRepository } from './channel-partner-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { JsonCodec, JsonValue } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { renderChannelPoster } from './channel-poster.js'
import { WechatMiniProgramCodeError } from './wechat-mini-program-code.js'
import { channelRuleSchema, channelManagementSchemas } from '../../src/shared/channel-distribution.js'

const keySchema = z.string().regex(/^channel-[a-zA-Z0-9_-]{16,100}$/)
const codec: JsonCodec<unknown> = { encode: value => value as JsonValue, decode: value => value }
const schemas = {
  invite: channelManagementSchemas.invite,
  followup: channelManagementSchemas.followup,
}
export function registerChannelPartnerRoutes(app: FastifyInstance, options: ChannelApiOptions) {
  app.get('/cooperation/partner', async request => {
    const token = channelWebToken(request)
    return { data: await options.transactions.run(channelWebScope(options), async tx => {
      const promoter = await authorizeChannelWeb(tx, token)
      return new ChannelPartnerRepository(tx).webDashboard(promoter)
    }, { readOnly: true }) }
  })
  app.get('/cooperation/history', async request => {
    const token = channelWebToken(request)
    const query = z.object({ kind:z.enum(['batches','visits','statements']), cursor:z.string().uuid().optional(), limit:z.coerce.number().int().min(1).max(100).optional() }).strict().parse(request.query)
    const page = await options.transactions.run(channelWebScope(options), async tx => {
      const promoter = await authorizeChannelWeb(tx, token)
      return new ChannelPartnerRepository(tx).webHistory(promoter.id, query.kind, query.cursor, query.limit)
    }, { readOnly: true })
    return {data:page.items,meta:{nextCursor:page.nextCursor}}
  })
  for (const action of ['invite', 'followup'] as const) app.post(`/staff/channel/${action}`, { bodyLimit: action === 'followup' ? 16384 : 4096 }, async request => {
    const ctx = await options.resolveStaffContext(request), input = schemas[action].parse(request.body)
    const authorize = async (tx: ScopedTransaction) => { await new StaffAccessRepository(tx).assertPermission(ctx.employeeId, 'channel.manage') }
    const result = await options.commands.execute({ scope: ctx.scope, operationScope: `channel.partner.${action}`, idempotencyKey: keySchema.parse(request.headers['idempotency-key']),
      requestFingerprint: JSON.stringify({ input, employeeId: ctx.employeeId }), resultCodec: codec, retainReceipt: true, rejectExpiredReceipt: true,
      replayOnly: request.headers['x-channel-recovery'] === '1', authorizeReplay: authorize }, async tx => {
      const repo = new ChannelPartnerRepository(tx)
      const value = action === 'invite' ? await inviteChannelWeb(tx, input.promoterId, ctx.employeeId)
        : await repo.followup({ ...input as z.infer<typeof schemas.followup>, employeeId: ctx.employeeId, actorRef: `employee:${ctx.employeeId}` })
      return { result: value, auditEvents: [{ actor: { type: 'employee', employeeId: ctx.employeeId }, businessDate: ctx.businessDate,
        action: `channel.partner.${action}`, objectType: 'channel_promoter', objectId: input.promoterId, afterData: { recordId: String(value.id), operation: action } }], outboxMessages: [] }
    }, authorize)
    return { data: result.value, meta: { replayed: result.replayed } }
  })
  app.get('/staff/channel/report',async(request,reply)=>{
    const ctx=await options.resolveStaffContext(request),query=z.object({format:z.enum(['csv','csv-data']).optional()}).strict().parse(request.query)
    const rows=await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'channel.view');return readChannelReport(tx)},{readOnly:true})
    if(query.format==='csv-data')return{data:{csv:channelReportCsv(rows)}}
    if(query.format==='csv')return reply.header('content-type','text/csv; charset=utf-8').header('content-disposition','attachment; filename="channel-report.csv"').send(channelReportCsv(rows))
    return{data:rows}
  })
  app.get('/staff/channel/directory', async request => {
    const ctx = await options.resolveStaffContext(request)
    const data = await options.transactions.run(ctx.scope, async tx => {
      await new StaffAccessRepository(tx).assertPermission(ctx.employeeId, 'channel.view')
      const args = [ctx.scope.tenantId, ctx.scope.storeId]
      const partners = (await tx.query(`SELECT p.id,p.name,p.settlement_subject AS "settlementSubject",r.id AS "promoterId",r.name AS "promoterName",EXISTS(SELECT 1 FROM mbox.channel_web_accounts a WHERE (a.tenant_id,a.store_id,a.promoter_id)=(r.tenant_id,r.store_id,r.id)) AS linked,r.status
        FROM mbox.channel_partners p JOIN mbox.channel_promoters r ON (r.tenant_id,r.store_id,r.partner_id)=(p.tenant_id,p.store_id,p.id)
        WHERE p.tenant_id=$1 AND p.store_id=$2 ORDER BY p.created_at DESC,p.id LIMIT 100`, args)).rows
      const campaigns = (await tx.query(`SELECT id,title,claim_limit AS "claimLimit",capacity_limit AS "capacityLimit",cost_limit_minor::text AS "costLimitMinor",accepting_claims AS "acceptingClaims" FROM mbox.channel_campaigns WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id LIMIT 100`, args)).rows
      const batches = (await tx.query(`SELECT id,promoter_id AS "promoterId",campaign_id AS "campaignId",offer_code AS "offerCode",public_token AS "publicToken",rule_snapshot AS rule,accepting_claims AS "acceptingClaims" FROM mbox.channel_batches WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id LIMIT 100`, args)).rows
      const followups = (await tx.query(`SELECT id,promoter_id AS "promoterId",kind,note,next_contact_at::text AS "nextContactAt",created_at::text AS "createdAt" FROM mbox.channel_followups WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id LIMIT 100`, args)).rows
      const products = (await tx.query(`SELECT id,name FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status='active' ORDER BY name,id LIMIT 500`, args)).rows
      const claims=(await tx.query(`SELECT q.id,q.status,q.batch_id AS "batchId",b.rule_snapshot->>'title' AS title FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id) WHERE q.tenant_id=$1 AND q.store_id=$2 ORDER BY q.issued_at DESC LIMIT 200`,args)).rows
      const employees=(await tx.query(`SELECT id,display_name AS name FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND status='active' ORDER BY display_name,id`,args)).rows
      const limits=(await tx.query(`SELECT claim_limit AS "claimLimit",capacity_limit AS "capacityLimit",cost_limit_minor::text AS "costLimitMinor" FROM mbox.channel_store_limits WHERE tenant_id=$1 AND store_id=$2`,args)).rows[0]??null
      const access=await new StaffAccessRepository(tx).resolve(ctx.employeeId)
      const continuity=access.permissions.includes('channel.correct')&&access.permissions.includes('table.view_all')?(await tx.query(`SELECT DISTINCT s.id AS "tableSessionId",t.display_name AS "tableName",v.id AS "previousVisitId",mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id) AS "customerId" FROM mbox.channel_visits v JOIN mbox.channel_visit_tables old ON (old.tenant_id,old.store_id,old.visit_id)=(v.tenant_id,v.store_id,v.id) JOIN mbox.table_session_customer_participations history ON (history.tenant_id,history.store_id,history.table_session_id)=(old.tenant_id,old.store_id,old.table_session_id) JOIN mbox.table_session_customer_participations p ON p.tenant_id=history.tenant_id AND p.store_id=history.store_id AND p.left_at IS NULL AND mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id)=mbox.canonical_customer_id(history.tenant_id,history.store_id,history.customer_id) JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.table_session_id) AND s.status='open' JOIN mbox.tables t ON (t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id) WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.closed_at>clock_timestamp()-interval '30 minutes' AND s.id<>old.table_session_id LIMIT 100`,args)).rows:[]
      return { partners, campaigns, batches, followups, products,claims,employees,limits,continuity }
    }, { readOnly: true })
    return { data }
  })
  for (const who of ['staff', 'partner'] as const) app.get(`${who === 'staff' ? '/staff/channel' : '/cooperation'}/poster/:batchId`, async (request, reply) => {
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(request.params)
    const staff = who === 'staff' ? await options.resolveStaffContext(request) : null
    const token = who === 'partner' ? channelWebToken(request) : null
    const scope = staff?.scope ?? channelWebScope(options)
    const poster = await options.transactions.run(scope, async tx => {
      const repo = new ChannelPartnerRepository(tx)
      const promoter = token ? await authorizeChannelWeb(tx, token) : null
      if (staff) await new StaffAccessRepository(tx).assertPermission(staff.employeeId, 'channel.manage')
      const row = (await tx.query<{ promoter_id: string; code: string; token: string; rule: unknown; source: string; accepting: boolean }>(`
        SELECT b.promoter_id,b.offer_code AS code,b.public_token AS token,b.rule_snapshot AS rule,p.name AS source,
          b.accepting_claims AND c.accepting_claims AND r.status='active' AND p.status='active' AS accepting
        FROM mbox.channel_batches b JOIN mbox.channel_campaigns c ON (c.tenant_id,c.store_id,c.id)=(b.tenant_id,b.store_id,b.campaign_id)
        JOIN mbox.channel_partners p ON (p.tenant_id,p.store_id,p.id)=(b.tenant_id,b.store_id,b.partner_id)
        JOIN mbox.channel_promoters r ON (r.tenant_id,r.store_id,r.id)=(b.tenant_id,b.store_id,b.promoter_id)
        WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.id=$3`, [scope.tenantId, scope.storeId, batchId])).rows[0]
      if (!row || (promoter && row.promoter_id !== promoter.id)) throw new ChannelDistributionError('NOT_AUTHORIZED', 403)
      await repo.followup({ promoterId: row.promoter_id, batchId, employeeId: staff?.employeeId ?? null,
        actorRef: staff ? `employee:${staff.employeeId}` : `promoter:${promoter!.id}`, kind: 'download', note: '请求生成推广图；不代表已发送或已保存', nextContactAt: null })
      return { ...row, rule: channelRuleSchema.parse(row.rule) }
    })
    const provider = options.miniCode
    if (!provider) throw new WechatMiniProgramCodeError('尚未配置微信小程序码服务，暂不能生成直达领券推广图', 'WECHAT_MINI_CODE_CONFIGURATION_INVALID')
    const entry = { appId: provider.appId, page: 'pages/channel-coupons/index', scene: `CH_${poster.code}`, environment: 'release' as const }
    const snapshot = { template: 'channel-poster-official-v2', ...poster, entry }
    const artifactKey=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    const cached=await options.transactions.run(scope,async tx=>(await tx.query<{png:Buffer}>(`SELECT png FROM mbox.channel_poster_versions WHERE tenant_id=$1 AND store_id=$2 AND batch_id=$3 AND artifact_key=$4`,[scope.tenantId,scope.storeId,batchId,artifactKey])).rows[0],{readOnly:true})
    let png = cached?.png
    if (!png) {
      try { png = await renderChannelPoster(poster, await provider.render({ page: entry.page, scene: entry.scene, environment: entry.environment, width: 430 })) }
      catch (error) {
        if (error instanceof WechatMiniProgramCodeError) throw error
        throw new WechatMiniProgramCodeError('微信推广码生成失败，请稍后重试', 'WECHAT_MINI_CODE_PROVIDER_UNAVAILABLE')
      }
    }
    const sha256=createHash('sha256').update(png).digest('hex')
    await options.transactions.run(scope,async tx=>{
      if(staff)await new StaffAccessRepository(tx).assertPermission(staff.employeeId,'channel.manage')
      if(token&&(await authorizeChannelWeb(tx,token)).id!==poster.promoter_id)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
      if(!cached)await tx.query(`INSERT INTO mbox.channel_poster_versions(tenant_id,store_id,batch_id,artifact_key,sha256,png,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,[scope.tenantId,scope.storeId,batchId,artifactKey,sha256,png,JSON.stringify(snapshot)])
    })
    const query = z.object({ format: z.literal('data').optional() }).strict().parse(request.query)
    if (query.format === 'data') return { data: { artifactKey,sha256,mimeType: 'image/png', base64: png.toString('base64'), filename: `mbox-channel-${batchId}.png` } }
    return reply.header('content-type', 'image/png').header('content-disposition', `attachment; filename="mbox-channel-${batchId}.png"`).send(png)
  })
}
