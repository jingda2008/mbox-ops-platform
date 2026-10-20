import {z} from 'zod'
import type {ScopedPostgresTransactionRunner,ScopedTransaction,StoreScope} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {SocialAccountRepository} from './social-account-repository.js'
import {OfficialSocialAccountAdapter,type SocialDeliveryResult} from './social-account-adapter.js'
import {LoyaltyOperationalControlRepository} from './loyalty-operational-control-repository.js'

export const pointsDataKeysSchema=z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,50}$/),z.enum(['change','balance','reason','occurredAt','memberNo'])).refine(value=>['change','balance','reason','occurredAt'].every(key=>Object.values(value).includes(key as 'change')),'模板须包含变动、余额、原因和时间')
export const officialPointsSettingsSchema=z.object({accountId:z.string().uuid(),enabled:z.boolean(),templateId:z.string().min(8).max(128),dataKeys:pointsDataKeysSchema,certificationExpiresAt:z.string().datetime({offset:true}),evidenceReference:z.string().trim().min(8).max(500)}).strict()
export interface OfficialPointsEvent extends Record<string,unknown>{id:string;customer_id:string;membership_id:string;event_type:string;points_delta:number;balance_after:number;reason:string;occurred_at:string;created_at:string}
export interface OfficialPointsSettings extends Record<string,unknown>{account_id:string;template_id:string;data_keys:Record<string,'change'|'balance'|'reason'|'occurredAt'|'memberNo'>;enabled:boolean;certification_expires_at:string}
export interface OfficialPointsBatch{workerId:string;accepted:number;blocked:number;skipped:number;unknown:number;rejected:number}
export type OfficialPointsAdapterFactory=(account:Awaited<ReturnType<SocialAccountRepository['account']>>)=>Pick<OfficialSocialAccountAdapter,'user'|'templates'|'sendTemplate'>
const titles:Record<string,string>={earn:'消费积分到账',promotion_earn:'活动奖励积分到账',redeem:'积分兑换扣减',expire:'积分到期扣减',reverse:'退款积分冲回',supplement:'漏积分补发',adjust:'积分调整',restore:'积分返还',checkout_hold:'结账积分占用',checkout_settled:'结账抵扣确认',expired_return:'返还积分已到期',pending_recovery:'退款待回收积分变动',debt_recovery:'抵回退款欠积分'}
export function officialPointsData(event:OfficialPointsEvent,memberNo:string,keys:OfficialPointsSettings['data_keys']){
 const values={change:event.points_delta>0?`+${event.points_delta}`:String(event.points_delta),balance:String(event.balance_after),reason:titles[event.event_type]??'积分变动',occurredAt:new Date(event.occurred_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),memberNo}
 return Object.fromEntries(Object.entries(keys).map(([key,field])=>[key,values[field]]))
}
export class OfficialPointsNotificationWorker{
 constructor(private readonly transactions:ScopedPostgresTransactionRunner,private readonly protection:ActivityContactProtectionKeyring,private readonly factory:OfficialPointsAdapterFactory=({account,credentials})=>new OfficialSocialAccountAdapter(account,credentials),private readonly miniProgramAppId?:string){}
 async runBatch(scope:Readonly<StoreScope>,workerId:string,batchSize=20):Promise<OfficialPointsBatch>{
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('Invalid batch size')
  const result:OfficialPointsBatch={workerId,accepted:0,blocked:0,skipped:0,unknown:0,rejected:0}
  if((await this.transactions.run(scope,tx=>new LoyaltyOperationalControlRepository(tx).state('wechat_notification'),{readOnly:true})).state==='paused')return result
  await this.transactions.run(scope,tx=>tx.query("UPDATE mbox.official_points_notifications SET status='unknown',error_code='WORKER_INTERRUPTED',completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND status='dispatching' AND attempted_at<clock_timestamp()-interval '5 minutes'",[scope.tenantId,scope.storeId]))
  const due=await this.transactions.run(scope,async tx=>(await tx.query<OfficialPointsEvent>("SELECT *,created_at::text AS created_at,occurred_at::text AS occurred_at FROM mbox.official_points_notifications WHERE tenant_id=$1 AND store_id=$2 AND status IN('queued','blocked') AND next_check_at<=clock_timestamp() ORDER BY official_points_notifications.created_at,id LIMIT $3",[scope.tenantId,scope.storeId,batchSize])).rows,{readOnly:true})
  for(const event of due){
   let claimed=false
   try{
    const prepared=await this.transactions.run(scope,async tx=>{
     const settings=(await tx.query<OfficialPointsSettings>('SELECT * FROM mbox.official_points_settings WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])).rows[0]
     if(!settings?.enabled||Date.parse(settings.certification_expires_at)<=Date.now())return {error:'ACCOUNT_PERMISSION_UNVERIFIED'} as const
     const member=(await tx.query<{member_no:string}>("SELECT member_no FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active'",[scope.tenantId,scope.storeId,event.membership_id])).rows[0]
     if(!member)return {skip:'MEMBER_INACTIVE'} as const
     if(!await optedIn(tx,event,settings.account_id))return {skip:'POINTS_NOTICE_NOT_AUTHORIZED'} as const
     const repo=new SocialAccountRepository(tx,this.protection),account=await repo.account(settings.account_id),openId=await repo.recipient(settings.account_id,event.customer_id)
     if(account.account.kind!=='service_account'||!account.account.enabled)return{error:'ACCOUNT_DISABLED'} as const
     if(!openId)return{skip:'FOLLOWER_NOT_UNIQUELY_BOUND'} as const
     return{settings,member,account,openId}
    },{readOnly:true})
    if('error'in prepared){await this.finishUnsent(scope,event.id,'blocked',prepared.error!);result.blocked++;continue}
    if('skip'in prepared){await this.finishUnsent(scope,event.id,'skipped',prepared.skip!);result.skipped++;continue}
    const adapter=this.factory(prepared.account)
    // These are read-only official API calls; no send before capability/follower checks.
    const templates=await adapter.templates(),template=templates.find(t=>t.templateId===prepared.settings.template_id)
    const required=template?[...template.content.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\.DATA\}\}/g)].map(m=>m[1]!):[]
    if(!template||!pointsDataKeysSchema.safeParse(prepared.settings.data_keys).success||!required.length||required.some(key=>!(key in prepared.settings.data_keys))||Object.keys(prepared.settings.data_keys).some(key=>!required.includes(key))){await this.finishUnsent(scope,event.id,'blocked','POINTS_TEMPLATE_UNAVAILABLE');result.blocked++;continue}
    if(!(await adapter.user(prepared.openId)).active){await this.finishUnsent(scope,event.id,'skipped','NOT_FOLLOWING');result.skipped++;continue}
    claimed=await this.transactions.run(scope,async tx=>{
     // Recheck settings and consent immediately before committing the exclusive claim.
     if((await new LoyaltyOperationalControlRepository(tx).state('wechat_notification',true)).state==='paused')return false
     if(!(await tx.query("SELECT 1 FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' FOR SHARE",[scope.tenantId,scope.storeId,event.membership_id])).rowCount)return false
     const settings=await tx.query("SELECT 1 FROM mbox.official_points_settings WHERE tenant_id=$1 AND store_id=$2 AND enabled AND account_id=$3 AND template_id=$4 AND data_keys=$5::jsonb AND certification_expires_at>clock_timestamp() FOR SHARE",[scope.tenantId,scope.storeId,prepared.settings.account_id,prepared.settings.template_id,JSON.stringify(prepared.settings.data_keys)])
     if(!settings.rowCount||!await optedIn(tx,event,prepared.settings.account_id,true))return false
     const recipient=await new SocialAccountRepository(tx,this.protection).recipient(prepared.settings.account_id,event.customer_id)
     if(recipient!==prepared.openId)return false
     const claim=await tx.query("UPDATE mbox.official_points_notifications SET status='dispatching',account_id=$4,template_id=$5,attempted_at=clock_timestamp(),error_code=NULL WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('queued','blocked') AND NOT EXISTS(SELECT 1 FROM mbox.official_points_notifications older WHERE older.tenant_id=$1 AND older.store_id=$2 AND older.customer_id=official_points_notifications.customer_id AND (older.created_at,older.id)<(official_points_notifications.created_at,official_points_notifications.id) AND older.status IN('queued','blocked','dispatching')) RETURNING id",[scope.tenantId,scope.storeId,event.id,prepared.settings.account_id,prepared.settings.template_id]);return claim.rowCount===1
    })
    if(!claimed)continue
    let receipt:SocialDeliveryResult
    try{receipt=await adapter.sendTemplate(prepared.openId,prepared.settings.template_id,officialPointsData(event,prepared.member.member_no,prepared.settings.data_keys),this.miniProgramAppId?{appid:this.miniProgramAppId,pagepath:"pages/points/index"}:undefined)}catch{receipt={status:'unknown',providerReference:null,errorCode:'DELIVERY_OUTCOME_UNKNOWN'}}
    await this.transactions.run(scope,tx=>tx.query("UPDATE mbox.official_points_notifications SET status=COALESCE((SELECT CASE WHEN r.delivered THEN 'delivered' ELSE 'delivery_failed' END FROM mbox.official_points_receipts r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.account_id=official_points_notifications.account_id AND r.provider_reference=$5),$4),provider_reference=$5,error_code=CASE WHEN EXISTS(SELECT 1 FROM mbox.official_points_receipts r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.account_id=official_points_notifications.account_id AND r.provider_reference=$5 AND NOT r.delivered) THEN 'PROVIDER_DELIVERY_FAILED' ELSE $6 END,completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='dispatching'",[scope.tenantId,scope.storeId,event.id,receipt.status,receipt.providerReference,receipt.errorCode]))
    result[receipt.status]++
   }catch{
    if(claimed){await this.transactions.run(scope,tx=>tx.query("UPDATE mbox.official_points_notifications SET status='unknown',error_code='DELIVERY_OUTCOME_UNKNOWN',completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='dispatching'",[scope.tenantId,scope.storeId,event.id]));result.unknown++}
    else{await this.finishUnsent(scope,event.id,'blocked','CAPABILITY_CHECK_UNAVAILABLE');result.blocked++}
   }
  }
  return result
 }
 private finishUnsent(scope:Readonly<StoreScope>,id:string,status:'blocked'|'skipped',error:string){return this.transactions.run(scope,tx=>tx.query("UPDATE mbox.official_points_notifications SET status=$4,error_code=$5,next_check_at=clock_timestamp()+interval '1 hour' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('queued','blocked')",[scope.tenantId,scope.storeId,id,status,error]))}
}
async function optedIn(tx:ScopedTransaction,event:OfficialPointsEvent,accountId:string,lock=false){
 // No inherited mini-program authorization; a preference belongs to this exact OA/customer.
 return (await tx.query("SELECT 1 FROM mbox.official_points_preferences WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND account_id=$4 AND enabled AND updated_at<=$5::timestamptz"+(lock?" FOR SHARE":""),[tx.scope.tenantId,tx.scope.storeId,event.customer_id,accountId,event.created_at])).rowCount===1
}
