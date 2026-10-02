import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {MembershipRecoveryService,type MembershipRecoveryPhoneProtector} from './membership-recovery-service.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {hashRequestFingerprint,NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;phones:MembershipRecoveryPhoneProtector;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-membership-recovery',verify='customer.membership.recovery.verify',approve='customer.membership.merge.approve',ref=z.string().regex(/^[A-Za-z0-9_-]{3,128}$/),reason=z.string().trim().min(2).max(500),fingerprint=z.string().regex(/^[a-f0-9]{64}$/)
const contact=z.object({memberNo:z.string().trim().min(1).max(64),phone:z.string().regex(/^\+[1-9][0-9]{7,14}$/),reason}).strict(),decision=z.object({casePublicId:ref,expectedVersion:fingerprint,candidatePublicId:ref.optional(),reason}).strict()
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as JsonObject
const stamp=(r:Record<string,unknown>):Record<string,unknown>&{nativeVersion:string}=>({...r,nativeVersion:createHash('sha256').update(JSON.stringify(r)).digest('hex')})
async function cases(tx:ScopedTransaction,q:{id?:string;cursor?:string;history?:boolean}){
 const rows=(await tx.query<Record<string,unknown>>(`SELECT m.public_id AS "casePublicId",m.status,c.candidate_count AS "candidateCount",contact.masked_value AS "maskedPhone",candidate.public_id AS "selectedCandidatePublicId",
 CASE WHEN membership.member_no IS NULL THEN NULL ELSE left(membership.member_no,4)||repeat('*',GREATEST(length(membership.member_no)-6,2))||right(membership.member_no,2) END AS "maskedMemberNo",
 m.selected_by_employee_id AS "selectedByEmployeeId",m.approved_by_employee_id AS "approvedByEmployeeId",m.created_at::text AS "createdAt",m.updated_at::text AS "updatedAt"
 FROM mbox.membership_merge_cases m JOIN mbox.membership_recovery_challenges c ON(c.tenant_id,c.store_id,c.id)=(m.tenant_id,m.store_id,m.challenge_id)
 JOIN mbox.customer_verified_contacts contact ON(contact.tenant_id,contact.store_id,contact.id)=(c.tenant_id,c.store_id,c.verified_contact_id)
 LEFT JOIN mbox.membership_recovery_candidates candidate ON(candidate.tenant_id,candidate.store_id,candidate.id)=(m.tenant_id,m.store_id,m.selected_candidate_id)
 LEFT JOIN mbox.customer_memberships membership ON(membership.tenant_id,membership.store_id,membership.id)=(m.tenant_id,m.store_id,m.source_membership_id)
 WHERE m.tenant_id=$1 AND m.store_id=$2 AND ($3::text IS NULL OR m.public_id=$3) AND ($4::text IS NULL OR m.public_id>$4)
 AND ($3::text IS NOT NULL OR $5::boolean OR m.status IN('manual_review','pending_review')) ORDER BY m.public_id LIMIT 51`,[tx.scope.tenantId,tx.scope.storeId,q.id??null,q.cursor??null,q.history??false])).rows
 return rows.map(stamp)
}
async function find(tx:ScopedTransaction,id:string){const row=(await cases(tx,{id}))[0];if(!row)throw new CustomerExperienceRequestError('原找回申请不存在或不属于本店');return row}
export const nativeMembershipRecoveryApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((e,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(e))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'MEMBERSHIP_RECOVERY_FORBIDDEN',message:'当前员工无此会员找回权限'}})
  if(e instanceof NativeCommandNotCommittedError&&!(e.original instanceof IdempotencyConflictError)&&!(e.original instanceof IdempotencyInProgressError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:e.original instanceof CustomerExperienceRequestError?e.original.message:'原申请或会员状态已变化，请重新核对',commitDisposition:'not_committed'}})
  if(e instanceof z.ZodError||e instanceof CustomerExperienceRequestError)return reply.code(400).send({error:{code:'MEMBERSHIP_RECOVERY_INVALID',message:e instanceof CustomerExperienceRequestError?e.message:'请核对会员号、国际格式手机号、原申请和核验依据'}})
  if(e instanceof NativeCommandNotCommittedError||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MEMBERSHIP_RECOVERY_UNCONFIRMED',message:'请保留原请求核对，不能重复合并'}})
  throw e
 })
 app.get(root,async request=>{const q=z.object({cursor:ref.optional(),history:z.enum(['true','false']).default('false')}).strict().parse(request.query),ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{const a=await new StaffAccessRepository(tx).resolve(ctx.employeeId);if(!a||![verify,approve].some(p=>a.permissions.includes(p)))throw new StaffAccessDeniedError('会员找回');const rows=await cases(tx,{cursor:q.cursor,history:q.history==='true'});return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,history:q.history==='true',rows:rows.slice(0,50),next:rows.length>50?String(rows[49]!.casePublicId):null}},{readOnly:true,isolation:'repeatable-read'})}})
 app.get(root+'/candidates',async request=>{const q=z.object({casePublicId:ref,expectedVersion:fingerprint,cursor:ref.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,verify);const row=await find(tx,q.casePublicId);if(row.nativeVersion!==q.expectedVersion||row.status!=='manual_review')throw new CustomerExperienceRequestError('原申请已变化，请刷新');const items=(await tx.query<Record<string,unknown>>(`SELECT candidate.public_id AS "candidatePublicId",left(m.member_no,4)||repeat('*',GREATEST(length(m.member_no)-6,2))||right(m.member_no,2) AS "maskedMemberNo",m.joined_at::date::text AS "joinedDate",contact.masked_value AS "maskedPhone"
 FROM mbox.membership_merge_cases c JOIN mbox.membership_recovery_candidates candidate ON(candidate.tenant_id,candidate.store_id,candidate.challenge_id)=(c.tenant_id,c.store_id,c.challenge_id)
 JOIN mbox.customer_memberships m ON(m.tenant_id,m.store_id,m.id)=(candidate.tenant_id,candidate.store_id,candidate.candidate_membership_id)
 JOIN mbox.customer_verified_contacts contact ON(contact.tenant_id,contact.store_id,contact.id)=(candidate.tenant_id,candidate.store_id,candidate.matched_contact_id)
 WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.public_id=$3 AND ($4::text IS NULL OR candidate.public_id>$4) ORDER BY candidate.public_id LIMIT 51`,[ctx.scope.tenantId,ctx.scope.storeId,q.casePublicId,q.cursor??null])).rows;return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,casePublicId:q.casePublicId,caseVersion:row.nativeVersion,rows:items.slice(0,50),next:items.length>50?String(items[49]!.candidatePublicId):null}},{readOnly:true,isolation:'repeatable-read'})}})
 app.post<{Params:{action:string}}>(root+'/:action',{bodyLimit:4096},async request=>{
  const action=z.enum(['contact','select','approve','reject']).parse(request.params.action),b=action==='contact'?contact.parse(request.body):decision.parse(request.body),ctx=await options.resolveContext(request),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);z.string().uuid().parse(key.slice(16));const permission=action==='contact'||action==='select'?verify:approve
  if(action==='select')ref.parse(decision.parse(b).candidatePublicId)
  const authorize=async(tx:ScopedTransaction)=>{const fresh=await options.resolveContext(request);if(fresh.employeeId!==ctx.employeeId||fresh.scope.tenantId!==ctx.scope.tenantId||fresh.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)}
  const accepted=json(b);delete (accepted as Record<string,unknown>).phone
  const result=await nativePhysicalExecutor(options.commands,ctx,authorize).execute({scope:ctx.scope,operationScope:'membership.recovery.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:hashRequestFingerprint(JSON.stringify({employeeId:ctx.employeeId,action,b})),resultCodec:{encode:json,decode:v=>v as JsonObject}},async tx=>{
   const service=new MembershipRecoveryService({run:(_scope,fn)=>fn(tx)},options.phones)
   let row:unknown
   if(action==='contact'){const c=contact.parse(b);row=await service.recordStaffVerifiedContact(ctx,{memberNo:c.memberNo,e164Phone:c.phone,reason:c.reason,idempotencyKey:key})}
   else{const d=decision.parse(b);await tx.query('SELECT id FROM mbox.membership_merge_cases WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,d.casePublicId]);const original=await find(tx,d.casePublicId);if(original.nativeVersion!==d.expectedVersion)throw new CustomerExperienceRequestError('原找回申请的状态或核验对象已变化，请重新读取');const common={casePublicId:d.casePublicId,reason:d.reason,idempotencyKey:key};if(action==='select')await service.selectCandidate(ctx,{...common,candidatePublicId:ref.parse(d.candidatePublicId)});else if(action==='approve')await service.approve(ctx,common);else await service.reject(ctx,common);row=await find(tx,d.casePublicId)}
   return{result:json(row),auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},action:'membership.recovery.native_'+action,objectType:'native_membership_recovery',objectId:ctx.scope.storeId,businessDate:ctx.businessDate,reason:b.reason,metadata:{requestKey:key}}],outboxMessages:[]}
  })
  return{data:{employeeId:ctx.employeeId,requestKey:key,action,accepted,row:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
