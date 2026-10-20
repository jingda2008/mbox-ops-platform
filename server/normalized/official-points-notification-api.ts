import {z} from 'zod'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {PublicCustomerExperienceContext} from './customer-experience-service.js'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {SocialAccountRepository} from './social-account-repository.js'
import {OfficialSocialAccountAdapter} from './social-account-adapter.js'
import {officialPointsSettingsSchema,type OfficialPointsAdapterFactory} from './official-points-notification-worker.js'
import {appendAuditEvent} from './command-executor.js'
interface Options extends Pick<CustomerBenefitApiOptions,'resolveStaffContext'>{transactions:ScopedPostgresTransactionRunner;protection:ActivityContactProtectionKeyring;factory?:OfficialPointsAdapterFactory;resolvePublicContext:(request:FastifyRequest)=>Promise<PublicCustomerExperienceContext>}
export const officialPointsNotificationApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 const factory=options.factory??(({account,credentials})=>new OfficialSocialAccountAdapter(account,credentials))
 app.addHook('onRequest',async(_r,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_r,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'POINTS_NOTICE_FORBIDDEN',message:'没有公众号配置权限'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'POINTS_NOTICE_INVALID',message:'请完整填写模板字段、认证有效期和核验依据'}})
  throw error
 })
 app.get('/staff/loyalty/official-notifications',async request=>{
  const ctx=await options.resolveStaffContext(request)
  return {data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   const args=[ctx.scope.tenantId,ctx.scope.storeId]
   return {settings:(await tx.query('SELECT * FROM mbox.official_points_settings WHERE tenant_id=$1 AND store_id=$2',args)).rows[0]??null,
    counts:(await tx.query('SELECT status,error_code,count(*)::int AS count FROM mbox.official_points_notifications WHERE tenant_id=$1 AND store_id=$2 GROUP BY status,error_code',args)).rows,
    items:(await tx.query('SELECT id,event_type,points_delta,balance_after,reason,status,error_code,occurred_at,completed_at FROM mbox.official_points_notifications WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id LIMIT 100',args)).rows}
  },{readOnly:true})}
 })
 app.get<{Params:{id:string}}>('/staff/loyalty/official-notifications/accounts/:id/templates',async(request,reply)=>{
  const ctx=await options.resolveStaffContext(request),id=z.string().uuid().parse(request.params.id)
  const account=await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');return new SocialAccountRepository(tx,options.protection).account(id)},{readOnly:true})
  try{return {data:{templates:await factory(account).templates(),certificationStatus:'requires_platform_evidence',checkedAt:new Date().toISOString()}}}catch{return reply.code(503).send({error:{code:'POINTS_TEMPLATE_UNAVAILABLE',message:'无法读取公众号模板权限；请核对认证、模板权限及服务器 IP 白名单'}})}
 })
 app.post('/staff/loyalty/official-notifications/settings',async(request,reply)=>{
  const ctx=await options.resolveStaffContext(request),input=officialPointsSettingsSchema.parse(request.body)
  const account=await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage');return new SocialAccountRepository(tx,options.protection).account(input.accountId)},{readOnly:true})
  if(account.account.kind!=='service_account')return reply.code(400).send({error:{code:'POINTS_ACCOUNT_KIND',message:'请选择公众号服务号'}})
  if(input.enabled){
   if(!account.account.enabled||Date.parse(input.certificationExpiresAt)<=Date.now())return reply.code(409).send({error:{code:'POINTS_ACCOUNT_NOT_READY',message:'账号未启用或认证已过期'}})
   try{
    const template=(await factory(account).templates()).find(t=>t.templateId===input.templateId)
    const keys=template?[...template.content.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\.DATA\}\}/g)].map(m=>m[1]!):[]
    if(!keys.length||keys.some(k=>!(k in input.dataKeys))||Object.keys(input.dataKeys).some(k=>!keys.includes(k)))throw new Error('Template mismatch')
   }catch{return reply.code(409).send({error:{code:'POINTS_TEMPLATE_NOT_VERIFIED',message:'模板权限或字段未验证，不能启用'}})}
  }
  await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'member.card.manage')
   await tx.query(`INSERT INTO mbox.official_points_settings(tenant_id,store_id,account_id,enabled,template_id,data_keys,certification_expires_at,evidence_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,store_id) DO UPDATE SET account_id=EXCLUDED.account_id,enabled=EXCLUDED.enabled,template_id=EXCLUDED.template_id,data_keys=EXCLUDED.data_keys,certification_expires_at=EXCLUDED.certification_expires_at,evidence_reference=EXCLUDED.evidence_reference,updated_at=clock_timestamp()`,[ctx.scope.tenantId,ctx.scope.storeId,input.accountId,input.enabled,input.templateId,JSON.stringify(input.dataKeys),input.certificationExpiresAt,input.evidenceReference])
   await appendAuditEvent(tx,{actor:{type:'employee',employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'loyalty.official_notifications.configured',objectType:'social_account',objectId:input.accountId,afterData:{...input}})
  })
  return {data:{saved:true}}
 })
 app.get('/public/mini/official-points-notifications',async request=>{
  const ctx=await options.resolvePublicContext(request)
  return {data:await options.transactions.run(ctx.scope,async tx=>{
   const config=(await tx.query<{account_id:string;name:string;enabled:boolean}>("SELECT s.account_id,a.name,(s.enabled AND a.enabled AND s.certification_expires_at>clock_timestamp()) AS enabled FROM mbox.official_points_settings s JOIN mbox.social_accounts a ON(a.tenant_id,a.store_id,a.id)=(s.tenant_id,s.store_id,s.account_id) WHERE s.tenant_id=$1 AND s.store_id=$2",[ctx.scope.tenantId,ctx.scope.storeId])).rows[0]
   if(!config)return{available:false,enabled:false,linked:false,accountId:null,accountName:null}
   const pref=(await tx.query<{enabled:boolean}>('SELECT enabled FROM mbox.official_points_preferences WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND account_id=$4',[ctx.scope.tenantId,ctx.scope.storeId,ctx.customerId,config.account_id])).rows[0]
   const linked=!!await new SocialAccountRepository(tx,options.protection).recipient(config.account_id,ctx.customerId)
   return{available:config.enabled,enabled:pref?.enabled??false,linked,accountId:config.account_id,accountName:config.name}
  },{readOnly:true})}
 })
 app.post('/public/mini/official-points-notifications',async(request,reply)=>{
  const ctx=await options.resolvePublicContext(request),input=z.object({accountId:z.string().uuid(),enabled:z.boolean()}).strict().parse(request.body)
  const ok=await options.transactions.run(ctx.scope,async tx=>{
   const settings=await tx.query('SELECT 1 FROM mbox.official_points_settings WHERE tenant_id=$1 AND store_id=$2 AND account_id=$3 AND enabled AND certification_expires_at>clock_timestamp() FOR SHARE',[ctx.scope.tenantId,ctx.scope.storeId,input.accountId])
   if(input.enabled&&(!settings.rowCount||!await new SocialAccountRepository(tx,options.protection).recipient(input.accountId,ctx.customerId)))return false
   await tx.query(`INSERT INTO mbox.official_points_preferences(tenant_id,store_id,customer_id,account_id,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,store_id,customer_id,account_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=clock_timestamp() WHERE official_points_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled`,[ctx.scope.tenantId,ctx.scope.storeId,ctx.customerId,input.accountId,input.enabled])
   await appendAuditEvent(tx,{actor:{type:'guest',ref:ctx.actorRef},businessDate:ctx.businessDate,action:'loyalty.official_notifications.preference',objectType:'customer',objectId:ctx.customerId,afterData:{...input}})
   return true
  })
  if(!ok)return reply.code(409).send({error:{code:'POINTS_ACCOUNT_NOT_LINKED',message:'请先关注并绑定本人的公众号身份；账号通知权限也须可用'}})
  return{data:{enabled:input.enabled}}
 })
}
