import {searchGuestCatalog,publicCatalogProduct} from './guest-commerce-service-api.js'
import {z} from 'zod'
import type {FastifyPluginAsync} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonCodec,type JsonObject} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {ReservationGuestSessionInvalidError} from './reservation-guest-session.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'|'resolveSelfContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>v as JsonObject}
const schema=z.object({enabled:z.boolean(),title:z.string().trim().min(1).max(80),content:z.string().max(1000),frequency:z.enum(['daily','session','always']),productIds:z.array(z.string().uuid()).max(8).refine(ids=>new Set(ids).size===ids.length),version:z.number().int().min(0)}).strict()
export async function readLaunchPopup(tx:ScopedTransaction,publicOnly=false,customerId:string|null=null){
 const s=[tx.scope.tenantId,tx.scope.storeId],row=(await tx.query<{enabled:boolean;title:string;content:string;frequency:string;version:number}>('SELECT enabled,title,content,frequency,version FROM mbox.launch_popup_policies WHERE tenant_id=$1 AND store_id=$2',s)).rows[0]??{enabled:false,title:'今日推荐',content:'',frequency:'daily',version:0}
 let products: Array<{id:string;name:string;imageUrl?:string|null;amountMinor?:number|null;currency?:string|null;available?:boolean}>=(await tx.query<{id:string;name:string}>(`SELECT p.id,p.name FROM mbox.launch_popup_products pp JOIN mbox.products p ON p.tenant_id=pp.tenant_id AND p.store_id=pp.store_id AND p.id=pp.product_id WHERE pp.tenant_id=$1 AND pp.store_id=$2 ${publicOnly?"AND p.status='active' AND p.guest_visible AND 'guest_qr'=ANY(p.allowed_channels)":''} ORDER BY pp.sort_order,p.id`,s)).rows
 if(publicOnly&&products.length){
  const catalog=await searchGuestCatalog(tx,null,{search:'',categoryCode:null,limit:products.length,offset:0,productIds:products.map(p=>p.id)},customerId)
  const byId=new Map(catalog.map(row=>{const p=publicCatalogProduct(row);return[row.id,{id:row.id,name:row.name,imageUrl:p.imageUrl,amountMinor:p.amountMinor,currency:p.currency,available:p.available}]}))
  products=products.flatMap(p=>{const visible=byId.get(p.id);return visible?[visible]:[]})
 }
 return{...row,productIds:products.map(p=>p.id),products}
}
export const launchPopupApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_req,reply)=>{
  if(isStaffAuthenticationRequiredError(error)||error instanceof ReservationGuestSessionInvalidError)return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'POPUP_ACCESS_DENIED',message:'没有首页弹窗配置权限'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'POPUP_INVALID',message:'请核对标题、频次和推荐商品'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||(error instanceof Error&&error.message==='POPUP_CONFLICT'))return reply.code(409).send({error:{code:'POPUP_CONFLICT',message:'配置已变化，请刷新后重新编辑'}})
  throw error
 })
 app.get('/public/mini/launch-popup',async request=>{const ctx=await options.resolveSelfContext(request);return{data:await options.transactions.run(ctx.scope,tx=>readLaunchPopup(tx,true,ctx.customerId),{readOnly:true})}})
 app.get('/staff/launch-popup',async request=>{const ctx=await options.resolveStaffContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');return readLaunchPopup(tx)},{readOnly:true})}})
 app.post('/staff/launch-popup',{bodyLimit:8192},async request=>{
  const ctx=await options.resolveStaffContext(request),input=schema.parse(request.body),key=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).parse(request.headers['idempotency-key'])
  await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage'),{readOnly:true})
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'launch.popup.configure',idempotencyKey:key,requestFingerprint:JSON.stringify({employeeId:ctx.employeeId,input}),resultCodec:codec},async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage')
   const s=[ctx.scope.tenantId,ctx.scope.storeId],inserted=await tx.query('INSERT INTO mbox.launch_popup_policies(tenant_id,store_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING store_id',s)
   const row=(await tx.query<{version:number}>('SELECT version FROM mbox.launch_popup_policies WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE',s)).rows[0]!
   if((inserted.rows.length?0:row.version)!==input.version)throw new Error('POPUP_CONFLICT')
   const valid=await tx.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND status='active' AND guest_visible",[...s,input.productIds])
   if(valid.rows.length!==input.productIds.length)throw new z.ZodError([])
   await tx.query('UPDATE mbox.launch_popup_policies SET enabled=$3,title=$4,content=$5,frequency=$6,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2', [...s,input.enabled,input.title,input.content,input.frequency])
   await tx.query('DELETE FROM mbox.launch_popup_products WHERE tenant_id=$1 AND store_id=$2',s)
   for(const [index,id] of input.productIds.entries())await tx.query('INSERT INTO mbox.launch_popup_products(tenant_id,store_id,product_id,sort_order) VALUES($1,$2,$3,$4)',[...s,id,index])
   return{result:JSON.parse(JSON.stringify(await readLaunchPopup(tx))) as JsonObject,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'launch.popup.configured',objectType:'launch_popup_policy',objectId:ctx.scope.storeId,afterData:input}],outboxMessages:[]}
  });return{data:result.value,meta:{replayed:result.replayed}}
 })
}
