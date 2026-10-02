import { z } from 'zod'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {NativeCommandNotCommittedError} from './command-executor.js'
import type { FastifyPluginAsync } from 'fastify'
import type { CustomerBenefitApiOptions } from './customer-benefit-api.js'
import type { NormalizedCommandExecutor, JsonCodec, JsonObject } from './command-executor.js'
import { IdempotencyConflictError, IdempotencyInProgressError } from './command-executor.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { defaultMemberNumberPolicy, memberNumberAt, memberNumberPolicySchema } from './member-number-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

type Options = Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'> & {commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>value as JsonObject}
export async function readMemberNumberPolicy(tx:ScopedTransaction) {
 const row=(await tx.query<{width:number;start_number:string;pad_zero:boolean;alphabet:string;maximum_prefix_length:number;version:number;next_ordinal:string}>(
  'SELECT width,start_number::text,pad_zero,alphabet,maximum_prefix_length,version,next_ordinal::text FROM mbox.member_number_policies WHERE tenant_id=$1 AND store_id=$2',[tx.scope.tenantId,tx.scope.storeId])).rows[0]
 const policy=row?{width:row.width,startNumber:Number(row.start_number),padZero:row.pad_zero,alphabet:row.alphabet,maximumPrefixLength:row.maximum_prefix_length}:defaultMemberNumberPolicy
 let nextCandidate:string|null=null
 try{nextCandidate=memberNumberAt(policy,BigInt(row?.next_ordinal??0))}catch{/* Exhaustion is displayed without hiding editable configuration. */}
 return {policy,version:row?.version??0,nextCandidate}
}
export const memberNumberApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'MEMBER_NUMBER_ACCESS_DENIED',message:'没有会员号配置权限'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'MEMBER_NUMBER_INVALID',message:'请检查号段参数、版本及变更原因'}})
  if(error instanceof NativeCommandNotCommittedError&&!(error.original instanceof IdempotencyConflictError)&&!(error.original instanceof IdempotencyInProgressError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:'号段配置已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof NativeCommandNotCommittedError||error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||(error instanceof Error&&error.message==='MEMBER_NUMBER_VERSION_CONFLICT'))return reply.code(409).send({error:{code:'MEMBER_NUMBER_CONFLICT',message:'配置已变化或正在处理，请刷新后核对'}})
  throw error
 })
 for(const native of [false,true])app.get(native?'/staff/native-member-number-policy':'/staff/member-number-policy',async request=>{
  const context=await options.resolveStaffContext(request)
  return {data:await options.transactions.run(context.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(context.employeeId,'member.card.manage');const row=await readMemberNumberPolicy(tx);return native?{employeeId:context.employeeId,protocol:1,durableCommands:true,row}:row},{readOnly:true})}
 })
 for(const native of [false,true])app.post(native?'/staff/native-member-number-policy':'/staff/member-number-policy',{bodyLimit:4096},async request=>{
  const context=await options.resolveStaffContext(request)
  const input=z.object({policy:memberNumberPolicySchema,version:z.number().int().min(0),reason:z.string().trim().min(2).max(300)}).strict().parse(request.body)
  const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  if(native)z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(key)
  const authorize=async(tx:ScopedTransaction)=>{const fresh=await options.resolveStaffContext(request);if(fresh.employeeId!==context.employeeId||fresh.scope.tenantId!==context.scope.tenantId||fresh.scope.storeId!==context.scope.storeId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(context.employeeId,'member.card.manage')}
  await options.transactions.run(context.scope,tx=>new StaffAccessRepository(tx).assertPermission(context.employeeId,'member.card.manage'),{readOnly:true})
  const executor=native?nativePhysicalExecutor(options.commands,context,authorize):options.commands
  const result=await executor.execute({retainReceipt:native,scope:context.scope,operationScope:'member.number.configure',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:context.employeeId,...input}),resultCodec:codec},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(context.employeeId,'member.card.manage')
   const scope=[tx.scope.tenantId,tx.scope.storeId]
   const inserted=await tx.query('INSERT INTO mbox.member_number_policies(tenant_id,store_id,version) VALUES($1,$2,1) ON CONFLICT DO NOTHING RETURNING store_id',scope)
   await tx.query('SELECT store_id FROM mbox.member_number_policies WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE',scope)
   const before=await readMemberNumberPolicy(tx)
   if((inserted.rows.length?0:before.version)!==input.version)throw new Error('MEMBER_NUMBER_VERSION_CONFLICT')
   const p=input.policy
   await tx.query('UPDATE mbox.member_number_policies SET width=$3,start_number=$4,pad_zero=$5,alphabet=$6,maximum_prefix_length=$7,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2',[...scope,p.width,p.startNumber,p.padZero,p.alphabet,p.maximumPrefixLength])
   const result=await readMemberNumberPolicy(tx)
   return {result:JSON.parse(JSON.stringify(result)) as JsonObject,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},businessDate:context.businessDate,action:'member.number.configured',objectType:'member_number_policy',objectId:tx.scope.storeId,reason:input.reason,beforeData:before.policy,afterData:result.policy}],outboxMessages:[]}
  })
  return native?{data:{employeeId:context.employeeId,requestKey:key,accepted:input,row:result.value},meta:{protocol:1,replayed:result.replayed}}:{data:result.value,meta:{replayed:result.replayed}}
 })
}
