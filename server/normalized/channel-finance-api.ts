import { authorizeChannelWeb, channelWebScope, channelWebToken, requireChannelWebOrigin } from './channel-web-auth.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ChannelApiOptions } from './channel-distribution-api.js'
import { ChannelFinanceRepository } from './channel-finance-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import type { JsonCodec,JsonValue } from './command-executor.js'
const uuid=z.string().uuid(),reason=z.string().trim().min(2).max(500),reference=z.string().trim().min(4).max(200)
const money=z.number().int().min(1).max(1e10),key=z.string().regex(/^channel-[a-zA-Z0-9_-]{16,100}$/)
const codec:JsonCodec<unknown>={encode:v=>v as JsonValue,decode:v=>v}
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('account'),partnerId:uuid,reference,reason}).strict(),
 z.object({action:z.literal('verify-account'),id:uuid,reason}).strict(),
 z.object({action:z.literal('statement'),promoterId:uuid,accountId:uuid,reason}).strict(),
 z.object({action:z.literal('approve'),id:uuid,reason}).strict(),z.object({action:z.literal('cancel'),id:uuid,reason}).strict(),
 z.object({action:z.literal('start-payment'),id:uuid,amountMinor:money,reference,reason}).strict(),
 z.object({action:z.literal('confirm-payment'),id:uuid,success:z.boolean(),reference,reason}).strict(),
 z.object({action:z.literal('return-payment'),id:uuid,amountMinor:money,reference,reason}).strict(),
 z.object({action:z.literal('reissue-account'),id:uuid,accountId:uuid,reason}).strict(),
 z.object({action:z.literal('reconcile'),promoterId:uuid,reason}).strict(),
])
export function registerChannelFinanceRoutes(app:FastifyInstance,options:ChannelApiOptions){
 for(const who of ['staff','partner'] as const)app.get(`${who==='staff'?'/staff/channel':'/cooperation'}/statement/:id`,async request=>{
  const {id}=z.object({id:uuid}).parse(request.params),staff=who==='staff'?await options.resolveStaffContext(request):null,token=who==='partner'?channelWebToken(request):null
  return{data:await options.transactions.run(staff?.scope??channelWebScope(options),async tx=>{
   if(staff)await new StaffAccessRepository(tx).assertPermission(staff.employeeId,'channel.settle')
   const promoter=token?await authorizeChannelWeb(tx,token):null
   return new ChannelFinanceRepository(tx).statementDetail(id,promoter?.id)
  },{readOnly:true})}
 })
 app.get('/staff/channel/finance',async request=>{
  const ctx=await options.resolveStaffContext(request)
  return{data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'channel.settle')
   const data=await new ChannelFinanceRepository(tx).overview()
   const accounts=(await tx.query(`SELECT id,partner_id AS "partnerId",subject,account_reference AS reference,verified_at::text AS "verifiedAt",revoked_at::text AS "revokedAt" FROM mbox.channel_settlement_accounts WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 500`,[ctx.scope.tenantId,ctx.scope.storeId])).rows
   return{...data,accounts}
  },{readOnly:true})}
 })
 app.post('/staff/channel/finance',{bodyLimit:4096},async request=>{
  const ctx=await options.resolveStaffContext(request),input=command.parse(request.body)
  const authorize=async(tx:ScopedTransaction)=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'channel.settle')}
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'channel.finance',idempotencyKey:key.parse(request.headers['idempotency-key']),requestFingerprint:JSON.stringify({input,employeeId:ctx.employeeId}),resultCodec:codec,retainReceipt:true,rejectExpiredReceipt:true,replayOnly:request.headers['x-channel-recovery']==='1',authorizeReplay:authorize},async tx=>{
   const repo=new ChannelFinanceRepository(tx);let value:unknown
   switch(input.action){
    case'account':value=await repo.account(input.partnerId,input.reference,ctx.employeeId,input.reason);break
    case'verify-account':value=await repo.verifyAccount(input.id,ctx.employeeId,input.reason);break
    case'statement':value=await repo.statement(input.promoterId,input.accountId,ctx.employeeId,input.reason);break
    case'approve':value=await repo.approve(input.id,ctx.employeeId,input.reason);break
    case'cancel':value=await repo.cancel(input.id,ctx.employeeId,input.reason);break
    case'start-payment':value=await repo.startPayment(input.id,input.amountMinor,input.reference,ctx.employeeId,input.reason);break
    case'confirm-payment':value=await repo.confirmPayment(input.id,input.success,input.reference,ctx.employeeId,input.reason);break
    case'return-payment':value=await repo.returnPayment(input.id,input.amountMinor,input.reference,ctx.employeeId,input.reason);break
    case'reissue-account':value=await repo.reissueAccount(input.id,input.accountId,ctx.employeeId,input.reason);break
    case'reconcile':await repo.reconcilePromoter(input.promoterId);value={promoterId:input.promoterId};break
   }
   return{result:value,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:`channel.finance.${input.action}`,objectType:'channel_finance',objectId:'id'in input?input.id:'promoterId'in input?input.promoterId:input.partnerId,reason:input.reason}],outboxMessages:[]}
  },authorize)
  return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.post('/cooperation/statement-response',{bodyLimit:2048},async request=>{
  requireChannelWebOrigin(request)
  const token=channelWebToken(request),ctx={scope:channelWebScope(options)},input=z.object({id:uuid,dispute:z.boolean(),reason}).strict().parse(request.body)
  const identity=await options.transactions.run(ctx.scope,tx=>authorizeChannelWeb(tx,token),{readOnly:true})
  const authorize=async(tx:ScopedTransaction)=>{
   const p=await authorizeChannelWeb(tx,token)
   if(p.id!==identity.id)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
   const match=await tx.query(`SELECT id FROM mbox.channel_statements WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND promoter_id=$4`,[ctx.scope.tenantId,ctx.scope.storeId,input.id,p.id]);if(!p.can_confirm_statement||!match.rows[0])throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  }
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'channel.web.statement.response',idempotencyKey:key.parse(request.headers['idempotency-key']),requestFingerprint:JSON.stringify({input,promoterId:identity.id}),resultCodec:codec,retainReceipt:true,rejectExpiredReceipt:true,replayOnly:request.headers['x-channel-recovery']==='1',authorizeReplay:authorize},async tx=>({result:await new ChannelFinanceRepository(tx).respondForWeb(input.id,(await authorizeChannelWeb(tx,token)).id,input.dispute,input.reason),auditEvents:[],outboxMessages:[]}),authorize)
  return{data:result.value,meta:{replayed:result.replayed}}
 })
}
