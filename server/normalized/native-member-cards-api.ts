import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {MemberCardRepository} from './member-card-repository.js'
import {MemberCardPolicyError} from './member-card-policy.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonCodec,type JsonObject} from './command-executor.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>v as JsonObject}
const uuid=z.string().uuid(),reason=z.string().trim().min(2).max(300),date=z.iso.datetime({offset:true}),expected=z.string().min(10).max(64)
const schemas={
 create:z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),name:z.string().trim().min(2).max(60),terms:z.string().trim().min(2).max(6000),kind:z.enum(['interest','cobrand']),availableFrom:date,availableUntil:date,cooperationConfirmed:z.boolean(),cooperationValidUntil:date.nullable(),cooperationReference:z.string().trim().min(2).max(500).nullable()}).strict(),
 state:z.object({projectId:uuid,expectedUpdatedAt:expected,state:z.enum(['open','paused','closed']),reason}).strict(),
 review:z.object({applicationId:uuid,decision:z.enum(['approve','reject']),reason}).strict(),
 holding:z.object({cardId:uuid,expectedUpdatedAt:expected,action:z.enum(['suspend','resume','revoke']),reason}).strict(),
 social:z.object({projectId:uuid,expectedUpdatedAt:expected,serviceAccountId:uuid,wecomAccountId:uuid,autoRestore:z.boolean(),artistName:z.string().trim().min(1).max(100),iconUrl:z.string().regex(/^\/(?:assets|media)\/[A-Za-z0-9_./-]+$/).nullable()}).strict(),
 menu:z.object({projectId:uuid,expectedMenu:z.string().regex(/^[a-f0-9]{64}$/),productId:uuid,exclusive:z.boolean(),active:z.boolean(),sortOrder:z.number().int().min(0).max(10000),exclusivePriceMinor:z.number().int().min(0).max(100000000).nullable()}).strict(),
 'menu-remove':z.object({projectId:uuid,expectedMenu:z.string().regex(/^[a-f0-9]{64}$/),productId:uuid}).strict(),
}
type Action=keyof typeof schemas
const snapshot=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const nativeMemberCardsApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_req,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'MEMBER_CARD_FORBIDDEN',message:'当前岗位没有此项会员卡权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof MemberCardPolicyError?error.original.message:'卡项目或申请已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof MemberCardPolicyError)return reply.code(400).send({error:{code:'MEMBER_CARD_INVALID',message:error instanceof MemberCardPolicyError?error.message:'请核对卡项目、原记录与必填字段'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MEMBER_CARD_REQUEST_CONFLICT',message:'原请求尚在处理或内容不一致，请恢复原请求'}})
  throw error
 })
 async function context(request:FastifyRequest,permission:string|string[]){const ctx=await options.resolveStaffContext(request);await options.transactions.run(ctx.scope,async tx=>{const rights=await new StaffAccessRepository(tx).resolve(ctx.employeeId);if(!(typeof permission==='string'?[permission]:permission).some(p=>rights.permissions.includes(p)))throw new StaffAccessDeniedError('无会员卡权限')},{readOnly:true});return ctx}
 app.get('/staff/native-member-cards',async request=>{
  const query=z.object({section:z.enum(['projects','applications','holdings']).default('projects'),cursor:uuid.optional()}).strict().parse(request.query)
  const ctx=await context(request,query.section==='applications'?'member.card.review':query.section==='projects'?['member.card.manage','loyalty.policy.publish']:'member.card.manage')
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const repo=new MemberCardRepository(tx);const page=query.section==='projects'?await repo.projects(ctx.employeeId,query.cursor??null,true):query.section==='applications'?await repo.reviewQueue(ctx.employeeId,query.cursor??null):await repo.holdings(ctx.employeeId,query.cursor??null)
   return{...page,section:query.section,employeeId:ctx.employeeId,durableCommands:true,protocol:1}
  },{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.get<{Params:{id:string}}>('/staff/native-member-cards/projects/:id/config',async request=>{
  const id=uuid.parse(request.params.id),ctx=await context(request,'member.card.manage')
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const args=[ctx.scope.tenantId,ctx.scope.storeId];const project=(await tx.query('SELECT id,status,updated_at::text FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...args,id])).rows[0];if(!project)throw new MemberCardPolicyError('项目不存在')
   const menu=(await tx.query('SELECT mi.product_id,p.name,mi.exclusive,mi.active,mi.sort_order,mi.exclusive_price_minor::text,mi.updated_at::text FROM mbox.member_card_menu_items mi JOIN mbox.products p ON p.tenant_id=mi.tenant_id AND p.store_id=mi.store_id AND p.id=mi.product_id WHERE mi.tenant_id=$1 AND mi.store_id=$2 AND mi.project_id=$3 ORDER BY mi.product_id',[...args,id])).rows
   const accounts=(await tx.query('SELECT id,kind,name,enabled FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 ORDER BY name,id',args)).rows
   return{project,menu,expectedMenu:snapshot(menu),accounts,employeeId:ctx.employeeId}
  },{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.get('/staff/native-member-cards/products',async request=>{
  const ctx=await context(request,'member.card.manage'),q=z.object({search:z.string().trim().max(120).default(''),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(request.query)
  const rows=await options.transactions.run(ctx.scope,async tx=>(await tx.query('SELECT id,name,guest_visible FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status=\'active\' AND ($3=\'\' OR strpos(lower(name),lower($3))>0) ORDER BY name,id LIMIT 101 OFFSET $4',[ctx.scope.tenantId,ctx.scope.storeId,q.search,q.offset])).rows,{readOnly:true});return{data:{items:rows.slice(0,100),nextOffset:rows.length>100?q.offset+100:null,employeeId:ctx.employeeId}}
 })
 app.post<{Params:{action:string}}>('/staff/native-member-cards/commands/:action',{bodyLimit:20000},async request=>{
  if(!Object.hasOwn(schemas,request.params.action))throw new MemberCardPolicyError('不支持的会员卡操作')
  const action=request.params.action as Action,input=schemas[action].parse(request.body),permission=action==='review'?'member.card.review':action==='state'&&'state'in input&&input.state==='open'?'loyalty.policy.publish':'member.card.manage'
  const ctx=await context(request,permission),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  const commands=nativeGuardedExecutor(options.commands,{fingerprint:{action,input,employeeId:ctx.employeeId},authorize:async tx=>{const fresh=await options.resolveStaffContext(request);if(fresh.employeeId!==ctx.employeeId||fresh.scope.tenantId!==ctx.scope.tenantId||fresh.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('账号已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)}})
  const result=await commands.execute({scope:ctx.scope,operationScope:'member.card.'+action,idempotencyKey:key,requestFingerprint:'',resultCodec:codec},async tx=>{
   const repo=new MemberCardRepository(tx),meta={employeeId:ctx.employeeId,businessDate:ctx.businessDate};let value:unknown
   if(action==='create')value=await repo.createProject({...schemas.create.parse(input),...meta,requireSocialConfiguration:true})
   else if(action==='state')value=await repo.setProjectState({...schemas.state.parse(input),...meta})
   else if(action==='review')value=await repo.review({...schemas.review.parse(input),...meta,expectedPending:true})
   else if(action==='holding')value=await repo.changeCard({...schemas.holding.parse(input),...meta})
   else {
    const config=action==='social'?schemas.social.parse(input):action==='menu'?schemas.menu.parse(input):schemas['menu-remove'].parse(input)
    const args=[ctx.scope.tenantId,ctx.scope.storeId,config.projectId]
    const project=(await tx.query<{status:string;updated_at:string;require_social_conditions:boolean}>('SELECT status,updated_at::text,require_social_conditions FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',args)).rows[0]
    if(!project)throw new MemberCardPolicyError('项目不存在')
    if('serviceAccountId'in config){
     if(project.status!=='draft'||project.updated_at!==config.expectedUpdatedAt)throw new MemberCardPolicyError('项目已变化，加入门槛只能在原草稿配置')
     const accounts=(await tx.query<{id:string;kind:string}>('SELECT id,kind FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[...args.slice(0,2),[config.serviceAccountId,config.wecomAccountId]])).rows
     if(!accounts.some(a=>a.id===config.serviceAccountId&&a.kind==='service_account')||!accounts.some(a=>a.id===config.wecomAccountId&&a.kind==='wecom'))throw new MemberCardPolicyError('请选择本店服务号和企业微信')
     await tx.query('UPDATE mbox.member_card_projects SET service_account_id=$4,wecom_account_id=$5,auto_restore=$6,artist_name=$7,icon_url=$8,require_social_conditions=true,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...args,config.serviceAccountId,config.wecomAccountId,config.autoRestore,config.artistName,config.iconUrl]);value={projectId:config.projectId,configured:true}
    } else {
     const menu=(await tx.query('SELECT mi.product_id,p.name,mi.exclusive,mi.active,mi.sort_order,mi.exclusive_price_minor::text,mi.updated_at::text FROM mbox.member_card_menu_items mi JOIN mbox.products p ON p.tenant_id=mi.tenant_id AND p.store_id=mi.store_id AND p.id=mi.product_id WHERE mi.tenant_id=$1 AND mi.store_id=$2 AND mi.project_id=$3 ORDER BY mi.product_id FOR UPDATE OF mi',args)).rows
     if(snapshot(menu)!==config.expectedMenu)throw new MemberCardPolicyError('专属菜单已变化，请刷新后核对')
     if(action==='menu'){
      const menuInput=schemas.menu.parse(config)
      if(!project.require_social_conditions)throw new MemberCardPolicyError('请先配置企微与服务号加入门槛')
      const product=(await tx.query<{guest_visible:boolean}>('SELECT guest_visible FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR SHARE',[...args.slice(0,2),config.productId])).rows[0]
      if(!product||menuInput.exclusive&&product.guest_visible)throw new MemberCardPolicyError('专属增量须选择非公共商品，不得遮挡公共商品')
      await tx.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive,active,sort_order,exclusive_price_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,store_id,project_id,product_id) DO UPDATE SET exclusive=EXCLUDED.exclusive,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,exclusive_price_minor=EXCLUDED.exclusive_price_minor,updated_at=clock_timestamp()',[...args,config.productId,menuInput.exclusive,menuInput.active,menuInput.sortOrder,menuInput.exclusivePriceMinor]);value={projectId:config.projectId,productId:config.productId,saved:true}
     }else{await tx.query('DELETE FROM mbox.member_card_menu_items WHERE tenant_id=$1 AND store_id=$2 AND project_id=$3 AND product_id=$4',[...args,config.productId]);value={projectId:config.projectId,productId:config.productId,removed:true}}
    }
   }
   return{result:JSON.parse(JSON.stringify(value)) as JsonObject,auditEvents:['social','menu','menu-remove'].includes(action)?[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'member.card.'+action,objectType:'member_card_project',objectId:'projectId'in input?input.projectId:'',afterData:JSON.parse(JSON.stringify(input))}]:[],outboxMessages:[]}
  })
  return{data:{action,employeeId:ctx.employeeId,requestKey:key,result:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
