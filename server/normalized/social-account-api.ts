import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {FastifyPluginAsync} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonCodec,type JsonObject} from './command-executor.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import type {StoreScope} from './transaction-runner.js'
import {SocialAccountRepository,socialAccountInputSchema,xmlValue,processSocialEvent} from './social-account-repository.js'
import {WechatServiceAccountCallbackVerifier} from './wechat-service-account-callback.js'
import {BottleCustodyError} from './bottle-custody-policy.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>;protection:ActivityContactProtectionKeyring;scope:StoreScope}
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>value as JsonObject}
export const socialAccountApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.addContentTypeParser(['application/xml','text/xml'],{parseAs:'string',bodyLimit:65536},(_request,body,done)=>done(null,body))
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'SOCIAL_ACCOUNT_ACCESS_DENIED',message:'没有微信账号配置权限'}})
  if(error instanceof BottleCustodyError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'SOCIAL_ACCOUNT_INVALID',message:'账号配置或密钥字段不正确'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'SOCIAL_ACCOUNT_CONFLICT',message:'请求正在处理或内容已变化，请刷新核对'}})
  throw error
 })
 app.get('/staff/member-cards/product-options',async request=>{
  const ctx=await options.resolveStaffContext(request),query=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(request.query)
  return{data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   const rows=(await tx.query<{id:string;name:string}>(`SELECT id,name FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status='active' ORDER BY name,id LIMIT 101 OFFSET $3`,[ctx.scope.tenantId,ctx.scope.storeId,query.offset])).rows
   return{items:rows.slice(0,100),nextOffset:rows.length>100?query.offset+100:null}
  },{readOnly:true})}
 })
 app.get('/staff/social-accounts',async(request,reply)=>{reply.header('Cache-Control','private, no-store');const ctx=await options.resolveStaffContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');return new SocialAccountRepository(tx,options.protection).list()},{readOnly:true})}})
 app.get('/staff/social-accounts/events',async request=>{const ctx=await options.resolveStaffContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');return(await tx.query('SELECT e.id,a.name AS account_name,e.event_type,e.status,e.error_code,e.received_at::text FROM mbox.social_callback_events e JOIN mbox.social_accounts a ON a.tenant_id=e.tenant_id AND a.store_id=e.store_id AND a.id=e.account_id WHERE e.tenant_id=$1 AND e.store_id=$2 ORDER BY e.received_at DESC,e.id DESC LIMIT 100',[ctx.scope.tenantId,ctx.scope.storeId])).rows},{readOnly:true})}})
 app.post<{Params:{id:string}}>('/staff/social-accounts/events/:id/retry',async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key']);z.object({}).strict().parse(request.body)
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'social.callback.retry',idempotencyKey:key,requestFingerprint:JSON.stringify({id,employee:ctx.employeeId}),resultCodec:codec},async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');const changed=await tx.query("UPDATE mbox.social_callback_events SET status='pending',error_code=NULL WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='failed' RETURNING id",[ctx.scope.tenantId,ctx.scope.storeId,id]);if(!changed.rows.length)throw new BottleCustodyError('只有失败的回调事件可以重新处理');return{result:{id,status:'pending'},auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'social.callback.retry',objectType:'social_callback_event',objectId:id}],outboxMessages:[]}});return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.post('/staff/social-accounts',{bodyLimit:8192},async request=>{
  const ctx=await options.resolveStaffContext(request),input=socialAccountInputSchema.parse(request.body),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'social.account.configure',idempotencyKey:key,requestFingerprint:createHash('sha256').update(JSON.stringify({employee:ctx.employeeId,input})).digest('hex'),resultCodec:codec},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   const result=await new SocialAccountRepository(tx,options.protection).save(input,ctx.employeeId)
   return{result,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'social.account.configured',objectType:'social_account',objectId:result.id,afterData:{kind:input.kind,appId:input.appId,enabled:input.enabled,credentialsChanged:!!input.credentials}}],outboxMessages:[]}
  });return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.post<{Params:{id:string}}>('/staff/member-cards/projects/:id/social-policy',{bodyLimit:4096},async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id)
  const input=z.object({serviceAccountId:z.string().uuid(),wecomAccountId:z.string().uuid(),autoRestore:z.boolean(),artistName:z.string().trim().min(1).max(100),iconUrl:z.string().max(500).nullable()}).strict().parse(request.body)
  if(input.iconUrl&&!/^\/(?:assets|media)\/[A-Za-z0-9_./-]+$/.test(input.iconUrl))throw new BottleCustodyError('图标须选择站内图片')
  const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'member.card.social.configure',idempotencyKey:key,requestFingerprint:JSON.stringify({id,employee:ctx.employeeId,input}),resultCodec:codec},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   const project=(await tx.query<{status:string}>('SELECT status FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,id])).rows[0]
   if(project?.status!=='draft')throw new BottleCustodyError('加入门槛须在项目草稿阶段配置；已开放项目请新建版本，保留历史条款')
   const accounts=(await tx.query<{id:string;kind:string}>('SELECT id,kind FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[ctx.scope.tenantId,ctx.scope.storeId,[input.serviceAccountId,input.wecomAccountId]])).rows
   if(!accounts.some(a=>a.id===input.serviceAccountId&&a.kind==='service_account')||!accounts.some(a=>a.id===input.wecomAccountId&&a.kind==='wecom'))throw new BottleCustodyError('请选择对应的本店服务号和企业微信')
   await tx.query('UPDATE mbox.member_card_projects SET service_account_id=$4,wecom_account_id=$5,auto_restore=$6,artist_name=$7,icon_url=$8,require_social_conditions=true,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[ctx.scope.tenantId,ctx.scope.storeId,id,input.serviceAccountId,input.wecomAccountId,input.autoRestore,input.artistName,input.iconUrl])
   return{result:{projectId:id,configured:true},auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'member.card.social.configured',objectType:'member_card_project',objectId:id,afterData:input}],outboxMessages:[]}
  });return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.get<{Params:{id:string}}>('/staff/member-cards/projects/:id/menu',async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id)
  return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');return(await tx.query('SELECT mi.product_id,p.name,mi.exclusive,mi.active,mi.sort_order,mi.exclusive_price_minor::text FROM mbox.member_card_menu_items mi JOIN mbox.products p ON p.tenant_id=mi.tenant_id AND p.store_id=mi.store_id AND p.id=mi.product_id WHERE mi.tenant_id=$1 AND mi.store_id=$2 AND mi.project_id=$3 ORDER BY mi.sort_order,p.name',[ctx.scope.tenantId,ctx.scope.storeId,id])).rows},{readOnly:true})}
 })
 app.post<{Params:{id:string}}>('/staff/member-cards/projects/:id/menu',{bodyLimit:4096},async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id)
  const input=z.object({productId:z.string().uuid(),exclusive:z.boolean(),active:z.boolean(),sortOrder:z.number().int().min(0).max(10000),exclusivePriceMinor:z.number().int().min(0).max(100000000).nullable()}).strict().parse(request.body)
  const key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage'),{readOnly:true})

  const result=await options.commands.execute({scope:ctx.scope,operationScope:'member.card.menu.configure',idempotencyKey:key,requestFingerprint:JSON.stringify({id,employee:ctx.employeeId,input}),resultCodec:codec},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   const product=(await tx.query<{guest_visible:boolean}>('SELECT guest_visible FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR SHARE',[ctx.scope.tenantId,ctx.scope.storeId,input.productId])).rows[0]
   if(!product)throw new BottleCustodyError('商品不存在')
   if(input.exclusive&&product.guest_visible)throw new BottleCustodyError('公共商品继续对所有人可见；请先新建非公共商品作为专属增量')
   const project=await tx.query('SELECT id FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND require_social_conditions',[ctx.scope.tenantId,ctx.scope.storeId,id])
   if(!project.rows.length)throw new BottleCustodyError('请先为专属卡配置企微与服务号加入门槛')
   await tx.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive,active,sort_order,exclusive_price_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,store_id,project_id,product_id) DO UPDATE SET exclusive=EXCLUDED.exclusive,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,exclusive_price_minor=EXCLUDED.exclusive_price_minor,updated_at=clock_timestamp()',[ctx.scope.tenantId,ctx.scope.storeId,id,input.productId,input.exclusive,input.active,input.sortOrder,input.exclusivePriceMinor])
   return{result:{projectId:id,productId:input.productId,saved:true},auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'member.card.menu.configured',objectType:'member_card_project',objectId:id,afterData:input}],outboxMessages:[]}
  });return{data:result.value,meta:{replayed:result.replayed}}
 })
 app.post<{Params:{id:string}}>('/staff/member-cards/projects/:id/menu/remove',{bodyLimit:1024},async request=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id),input=z.object({productId:z.string().uuid()}).strict().parse(request.body),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'member.card.menu.remove',idempotencyKey:key,requestFingerprint:JSON.stringify({id,input,employee:ctx.employeeId}),resultCodec:codec},async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');const before=await tx.query('DELETE FROM mbox.member_card_menu_items WHERE tenant_id=$1 AND store_id=$2 AND project_id=$3 AND product_id=$4 RETURNING *',[ctx.scope.tenantId,ctx.scope.storeId,id,input.productId]);if(!before.rows.length)throw new BottleCustodyError('该卡没有此专属项，请刷新核对');return{result:{projectId:id,productId:input.productId,removed:true},auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'member.card.menu.removed',objectType:'member_card_project',objectId:id,beforeData:JSON.parse(JSON.stringify(before.rows[0])) as JsonObject}],outboxMessages:[]}});return{data:result.value,meta:{replayed:result.replayed}}
 })
 async function verifier(id:string){return options.transactions.run(options.scope,async tx=>{const {account,credentials}=await new SocialAccountRepository(tx,options.protection).account(id);return new WechatServiceAccountCallbackVerifier({appId:account.app_id,token:credentials.token,encodingAesKey:credentials.encodingAesKey,receiverKind:account.kind})},{readOnly:true})}
 app.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/social-accounts/:id/callback',async(request,reply)=>{
  try{const check=await verifier(z.string().uuid().parse(request.params.id));return reply.type('text/plain').send(check.verifyChallenge(request.query))}catch{return reply.code(403).type('text/plain').send('forbidden')}
 })
 app.post<{Params:{id:string};Querystring:Record<string,unknown>;Body:string}>('/social-accounts/:id/callback',{bodyLimit:65536},async(request,reply)=>{
  let xml:string,id:string
  try{id=z.string().uuid().parse(request.params.id);xml=(await verifier(id)).verifyMessage(request.query,request.body)}catch{return reply.code(403).type('text/plain').send('forbidden')}
  try{await options.transactions.run(options.scope,async tx=>{const repo=new SocialAccountRepository(tx,options.protection);await repo.ingestVerified(id,xml)
   // Revocation never waits for an external network call or the scheduler.
   const event=xmlValue(xml,'Event',false),change=xmlValue(xml,'ChangeType',false)
   if(event==='unsubscribe'||['del_external_contact','del_follow_user'].includes(change))await processSocialEvent(repo,id,xml)
  });return reply.type('text/plain').send('success')}catch{return reply.code(503).type('text/plain').send('event persistence unavailable')}
 })
}
