import {createHash} from 'node:crypto'
import {depositEvidenceSchema} from './custody-deposit-evidence.js'
import {custodyReport,custodyReportFilters} from './custody-report.js'
import {custodyPrintHtml,custodyWorkbook} from './custody-document.js'
import type {CustodyOrder} from './bottle-custody-repository.js'
import {z} from 'zod'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {NormalizedCommandExecutor,JsonCodec,JsonObject} from './command-executor.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError} from './command-executor.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {BottleCustodyRepository,custodyCreateSchema} from './bottle-custody-repository.js'
import {BottleCustodyError,custodyPolicySchema,quantitySchema} from './bottle-custody-policy.js'

type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>;protection:ActivityContactProtectionKeyring;nativeReceipts?:boolean}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>value as JsonObject}
const reason=z.string().trim().min(2).max(300),uuid=z.string().uuid()
const filters=z.object({memberNo:z.string().min(1).max(64).optional(),categoryId:uuid.optional(),status:z.enum(['stored','collected','archived','voided']).optional(),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),query:z.string().max(100).optional(),cursor:uuid.optional()}).strict()
export const bottleCustodyApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'CUSTODY_ACCESS_DENIED',message:'没有此项存酒操作权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof BottleCustodyError?error.original.message:'本次存酒操作未提交，请刷新核对后重试',commitDisposition:'not_committed'}})
  if(error instanceof BottleCustodyError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'CUSTODY_INVALID',message:'输入不符合要求，请检查数量、日期及必填字段'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'CUSTODY_COMMAND_CONFLICT',message:'请求正在处理或内容已变化，请刷新核对'}})
  throw error
 })
 async function context(request:FastifyRequest,permission='bottle.manage.all'){
  const ctx=await options.resolveStaffContext(request)
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission),{readOnly:true});return ctx
 }
 async function write(request:FastifyRequest,operation:string,input:unknown,action:(repo:BottleCustodyRepository,employeeId:string)=>Promise<unknown>,permission='bottle.manage.all'){
  const ctx=await context(request,permission),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  const native=options.nativeReceipts===true
  if(native)z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(key)
  const guarded= native && ['request_code','verify','collect','resolve_collection','archive','expiry','print_prepared'].includes(operation)
  const expectedVersion=guarded?z.coerce.number().int().min(1).parse(request.headers['x-custody-version']):null
  const categoryExpected=native&&operation==='category'&&(input as {id?:string}).id?z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers['x-custody-category']):null
  const fingerprint=options.protection.protect(JSON.stringify({employeeId:ctx.employeeId,input,...(native?{expectedVersion,categoryExpected}:{})})).hash
  const result=await options.commands.execute({scope:ctx.scope,operationScope:`bottle.custody.${operation}${native?'.native':''}`,idempotencyKey:key,requestFingerprint:fingerprint,resultCodec:codec,...(native?{retainReceipt:true}:{})},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)
   if(['export','report_export'].includes(operation))await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'bottle.manage.all')
   if(guarded){
    const row=(await tx.query<{version:number}>('SELECT version FROM mbox.bottle_custody_orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,(input as {id:string}).id])).rows[0]
    if(!row||row.version!==expectedVersion)throw new BottleCustodyError('原存酒单已变化，请刷新核对','CUSTODY_VERSION_CONFLICT',409)
   }
   if(categoryExpected){
    const row=(await tx.query('SELECT id,code,name,default_days,active,sort_order FROM mbox.bottle_custody_categories WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,(input as {id:string}).id])).rows[0]
    if(!row||custodyCategoryFingerprint(row)!==categoryExpected)throw new BottleCustodyError('品类已变化，请刷新核对','CUSTODY_VERSION_CONFLICT',409)
   }
   const value=await action(new BottleCustodyRepository(tx,options.protection),ctx.employeeId)
   const result=native?{operation,employeeId:ctx.employeeId,requestKey:key,result:value}:value
   return{result:JSON.parse(JSON.stringify(result)) as JsonObject,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:`bottle.custody.${operation}`,objectType:'bottle_custody',objectId:ctx.scope.storeId,afterData:{requestFingerprint:fingerprint}}],outboxMessages:[]}
  },native?async tx=>{
   const current=await options.resolveStaffContext(request)
   if(current.employeeId!==ctx.employeeId||current.scope.tenantId!==ctx.scope.tenantId||current.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('Account changed')
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)
   if(['export','report_export'].includes(operation))await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'bottle.manage.all')
  }:undefined);return{data:result.value,meta:{replayed:result.replayed,...(native?{protocol:1}:{})}}
 }
 app.get('/staff/bottle-custody/native-capabilities',async request=>{const ctx=await context(request);return{data:{durableCommands:options.nativeReceipts===true,employeeId:ctx.employeeId}}})
 app.get('/staff/bottle-custody/report',async request=>{
  const input=custodyReportFilters.parse(request.query),ctx=await context(request)
  return{data:await options.transactions.run(ctx.scope,async tx=>{if(input.scope!=='custody')await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'order.history.all');return custodyReport(tx,input)},{readOnly:true})}
 })
 app.post('/staff/bottle-custody/report-export',{bodyLimit:4096},async request=>{
  const input=custodyReportFilters.omit({offset:true}).parse(request.body),ctx=await context(request,'bottle.custody.export')
  return write(request,options.nativeReceipts?'report_export':'export',input,async repo=>repo.exportReport(input,ctx.employeeId),'bottle.custody.export')
 })
 if(options.nativeReceipts)app.get('/staff/bottle-custody/source-order',async request=>{
  const input=z.object({memberNo:z.string().trim().min(1).max(64),publicId:z.string().trim().min(8).max(128)}).strict().parse(request.query),ctx=await context(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const row=(await tx.query(`SELECT o.id,o.public_id AS "publicId",o.created_at::text AS "createdAt" FROM mbox.orders o
    JOIN mbox.customer_memberships m ON m.tenant_id=o.tenant_id AND m.store_id=o.store_id
      AND mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)=mbox.canonical_customer_id(o.tenant_id,o.store_id,o.created_by_customer_id)
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.public_id=$3 AND m.member_no=$4 AND m.status='active' LIMIT 1`,[ctx.scope.tenantId,ctx.scope.storeId,input.publicId,input.memberNo])).rows[0]
   if(!row)throw new BottleCustodyError('未找到该会员的原消费订单，请核对单号','CUSTODY_SOURCE_NOT_FOUND',404)
   return row
  },{readOnly:true});return{data}
 })
 app.get('/staff/bottle-custody/member-contact',async request=>{const {memberNo}=z.object({memberNo:z.string().trim().min(1).max(64)}).strict().parse(request.query),ctx=await context(request);return{data:await options.transactions.run(ctx.scope,tx=>new BottleCustodyRepository(tx).memberContact(memberNo),{readOnly:true})}})
 app.get<{Params:{id:string;depositId:string}}>('/staff/bottle-custody/:id/photos/:depositId',async(request,reply)=>{const id=uuid.parse(request.params.id),depositId=uuid.parse(request.params.depositId),ctx=await context(request);const photo=await options.transactions.run(ctx.scope,tx=>new BottleCustodyRepository(tx).photo(id,depositId),{readOnly:true});return reply.header('X-Content-Type-Options','nosniff').send({data:{base64:photo.toString('base64')}})})
 app.get('/staff/bottle-custody/policy',async request=>{const ctx=await context(request);return{data:await options.transactions.run(ctx.scope,async tx=>{const repo=new BottleCustodyRepository(tx);return{...await repo.policy(),categories:(await repo.categories()).map(row=>({...row,configurationFingerprint:custodyCategoryFingerprint(row)})),accounts:(await tx.query("SELECT id,name FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND kind='service_account'",[ctx.scope.tenantId,ctx.scope.storeId])).rows}},{readOnly:true})}})
 app.post('/staff/bottle-custody/policy',{bodyLimit:8192},async request=>{const input=z.object({policy:custodyPolicySchema,version:z.number().int().min(0),reason}).strict().parse(request.body);return write(request,'policy',input,repo=>repo.savePolicy(input.policy,input.version),'member.card.manage')})
 app.post('/staff/bottle-custody/categories',{bodyLimit:4096},async request=>{const input=z.object({id:uuid.optional(),code:z.string().trim().min(1).max(40),name:z.string().trim().min(1).max(60),defaultDays:z.number().int().min(1).max(3660),active:z.boolean(),sortOrder:z.number().int().min(0).max(10000)}).strict().parse(request.body);return write(request,'category',input,repo=>repo.saveCategory(input),'member.card.manage')})
 app.post('/staff/bottle-custody/export',{bodyLimit:4096},async request=>{
  const input=filters.omit({cursor:true}).parse(request.body)
  await context(request,'bottle.manage.all')
  return write(request,'export',input,async repo=>{
   const items:CustodyOrder[]=[];let cursor:string|null=null
   do{const page=await repo.list({...input,...(cursor?{cursor}:{})});items.push(...page.items);cursor=page.nextCursor;if(items.length>10000)throw new BottleCustodyError('结果超过一万笔，请缩小日期范围后导出')}while(cursor)
   return{filename:'MBOX-存酒明细.xlsx',base64:custodyWorkbook(items).toString('base64'),count:items.length,amountStatus:'declared_value_not_revenue'}
  },'bottle.custody.export')
 })
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/print',{bodyLimit:1024},async request=>{
  const id=uuid.parse(request.params.id);z.object({}).strict().parse(request.body)
  return write(request,'print_prepared',{id},async(repo,employee)=>{const {order}=await repo.detail(id),{policy}=await repo.policy();await repo.event(id,'printed',employee,null,null,null,'生成打印内容；不代表实体出纸');return{html:custodyPrintHtml(order,policy.printTitle,policy),publicId:order.public_id,...(options.nativeReceipts?{document:{order,policy}}:{})}})
 })
 app.get('/staff/bottle-custody',async request=>{const input=filters.parse(request.query),ctx=await context(request);return{data:await options.transactions.run(ctx.scope,tx=>new BottleCustodyRepository(tx).list(input),{readOnly:true})}})
 app.post('/staff/bottle-custody',{bodyLimit:1500000},async request=>{const input=custodyCreateSchema.parse(request.body);return write(request,'create',input,(repo,id)=>repo.create(input,id))})
 app.get<{Params:{id:string}}>('/staff/bottle-custody/:id',async request=>{const id=uuid.parse(request.params.id),ctx=await context(request);return{data:await options.transactions.run(ctx.scope,tx=>new BottleCustodyRepository(tx).detail(id),{readOnly:true})}})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/request-code',{bodyLimit:1024},async request=>{const id=uuid.parse(request.params.id),input=z.object({quantity:quantitySchema}).strict().parse(request.body);return write(request,'request_code',{id,...input},(repo,employee)=>repo.requestCode(id,input.quantity,employee))})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/verify',{bodyLimit:1024},async request=>{const id=uuid.parse(request.params.id),input=z.object({challengeId:uuid,code:z.string().regex(/^[0-9]{4,8}$/)}).strict().parse(request.body);return write(request,'verify',{id,...input},(repo,employee)=>repo.verify(id,input.challengeId,input.code,employee))})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/collect',{bodyLimit:1024},async request=>{const id=uuid.parse(request.params.id),input=z.object({challengeId:uuid}).strict().parse(request.body);return write(request,'collect',{id,...input},(repo,employee)=>repo.collect(id,input.challengeId,employee))})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/resolve-collection',{bodyLimit:1500000},async request=>{const id=uuid.parse(request.params.id),input=z.object({evidence:depositEvidenceSchema.optional(),collectionId:uuid,quantity:quantitySchema.nullable(),restorageMode:z.enum(['original','new']).default('original'),reason}).strict().parse(request.body);return write(request,'resolve_collection',{id,...input},(repo,employee)=>repo.resolveCollection(id,input.collectionId,input.quantity,employee,input.reason,input.restorageMode,input.evidence))})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/archive',{bodyLimit:2048},async request=>{const id=uuid.parse(request.params.id),input=z.object({reason}).strict().parse(request.body);return write(request,'archive',{id,...input},(repo,employee)=>repo.archive(id,employee,input.reason))})
 app.post<{Params:{id:string}}>('/staff/bottle-custody/:id/expiry',{bodyLimit:2048},async request=>{const id=uuid.parse(request.params.id),input=z.object({expiresAt:z.iso.datetime({offset:true}),reason}).strict().parse(request.body);return write(request,'expiry',{id,...input},(repo,employee)=>repo.changeExpiry(id,input.expiresAt,employee,input.reason))})
}

function custodyCategoryFingerprint(row:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(['id','code','name','default_days','active','sort_order'].map(key=>row[key]??null))).digest('hex')}
