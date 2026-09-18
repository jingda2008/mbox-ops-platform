import {sendNextBroadcast} from './social-broadcast-repository.js'
import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {SocialAccountRepository,processSocialEvent} from './social-account-repository.js'
import {OfficialSocialAccountAdapter,type SocialDeliveryResult} from './social-account-adapter.js'
function clipThing(value:string){return Array.from(value.trim()||'—').slice(0,20).join('')}
function clipCharacter(value:string){return Array.from(value.trim()||'—').slice(0,32).join('')}
function formatWechatTime(ms:number){
 if(!Number.isFinite(ms))return '待确认'
 const date=new Date(ms)
 const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(date)
 const pick=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value??''
 return `${pick('year')}年${pick('month')}月${pick('day')}日 ${pick('hour')}:${pick('minute')}`
}
/** Database claims precede network calls. A crash after claim is unknown, never
 * automatically resent: duplicate messages cannot be ruled out. */
export class SocialCustodyWorker{
 constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>,private readonly protection:ActivityContactProtectionKeyring){}
 async runBatch(scope:StoreScope){
  await this.transactions.run(scope,async tx=>{
   await tx.query("UPDATE mbox.bottle_custody_challenges SET delivery_status='unknown',error_code='WORKER_INTERRUPTED' WHERE tenant_id=$1 AND store_id=$2 AND delivery_status='sending' AND claimed_at<clock_timestamp()-interval '2 minutes'",[scope.tenantId,scope.storeId])
   await tx.query("UPDATE mbox.bottle_custody_reminders SET status='unknown',error_code='WORKER_INTERRUPTED' WHERE tenant_id=$1 AND store_id=$2 AND status='sending' AND claimed_at<clock_timestamp()-interval '2 minutes'",[scope.tenantId,scope.storeId])
  })
  await this.transactions.run(scope,tx=>new SocialAccountRepository(tx,this.protection).relinkVerifiedRelationships())
  await this.transactions.run(scope,tx=>tx.query("UPDATE mbox.bottle_custody_challenges SET delivery_status='rejected',error_code='EXPIRED_OR_INVALIDATED' WHERE tenant_id=$1 AND store_id=$2 AND delivery_status='pending' AND (expires_at<=clock_timestamp() OR invalidated_at IS NOT NULL)",[scope.tenantId,scope.storeId]))
  await this.processEvents(scope)
  await this.transactions.run(scope,async tx=>{
   await tx.query(`INSERT INTO mbox.bottle_custody_reminders(tenant_id,store_id,order_id,expiry_snapshot,days_before,due_at)
    SELECT o.tenant_id,o.store_id,o.id,o.expires_at,d.day,
    ((o.expires_at AT TIME ZONE 'Asia/Shanghai')::date-d.day+make_interval(mins=>p.send_minute)) AT TIME ZONE 'Asia/Shanghai'
    FROM mbox.bottle_custody_orders o JOIN mbox.bottle_custody_policies p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id CROSS JOIN LATERAL unnest(p.reminder_days) d(day)
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND p.reminders_enabled AND o.status='stored' AND o.remaining_quantity>0
    AND (((o.expires_at AT TIME ZONE 'Asia/Shanghai')::date-d.day+make_interval(mins=>p.send_minute)) AT TIME ZONE 'Asia/Shanghai')>=o.stored_at
    ON CONFLICT DO NOTHING`,[scope.tenantId,scope.storeId])
   await tx.query(`UPDATE mbox.bottle_custody_reminders r SET status='cancelled' FROM mbox.bottle_custody_orders o WHERE r.tenant_id=$1 AND r.store_id=$2 AND o.tenant_id=r.tenant_id AND o.store_id=r.store_id AND o.id=r.order_id AND r.status='pending' AND(o.status<>'stored' OR r.expiry_snapshot<>o.expires_at OR r.due_at<date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,[scope.tenantId,scope.storeId])
  })
  for(let i=0;i<5;i++)if(!await this.sendNext(scope,'code'))break
  for(let i=0;i<5;i++)if(!await this.sendNext(scope,'reminder'))break
  await sendNextBroadcast(this.transactions,scope,this.protection)
 }
 private async processEvents(scope:StoreScope){
  for(let i=0;i<5;i++){
   const done=await this.transactions.run(scope,async tx=>{
    const event=(await tx.query<{id:string;account_id:string;encrypted_payload:Buffer;payload_hash:string;key_id:string}>(`SELECT id,account_id,encrypted_payload,payload_hash,key_id FROM mbox.social_callback_events WHERE tenant_id=$1 AND store_id=$2 AND status='pending' ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[scope.tenantId,scope.storeId])).rows[0]
    if(!event)return false
    const xml=this.protection.reveal({encryptedContact:event.encrypted_payload,contactHash:event.payload_hash,encryptionKeyId:event.key_id})
    await tx.query('SAVEPOINT social_event_apply')
    try{await processSocialEvent(new SocialAccountRepository(tx,this.protection),event.account_id,xml);await tx.query("UPDATE mbox.social_callback_events SET status='processed',processed_at=clock_timestamp() WHERE id=$1",[event.id])}
    catch{await tx.query('ROLLBACK TO SAVEPOINT social_event_apply');await tx.query("UPDATE mbox.social_callback_events SET status='failed',error_code='PROVIDER_OR_BINDING_UNAVAILABLE' WHERE id=$1",[event.id])}
    return true
   });if(!done)break
  }
 }
 private async sendNext(scope:StoreScope,kind:'code'|'reminder'){
  const table=kind==='code'?'bottle_custody_challenges':'bottle_custody_reminders',status=kind==='code'?'delivery_status':'status'
  const job=await this.transactions.run(scope,async tx=>{
   const rows=await tx.query<Record<string,unknown>&{id:string;order_id:string;customer_id:string;account_id:string|null;encrypted_code?:Buffer;code_hash?:string;key_id?:string;reminder_text:string;expires_at:string;stored_at:string;public_id:string;item_name:string}>(`SELECT j.*,o.customer_id,o.expires_at::text,o.stored_at::text,o.public_id,o.item_name,p.service_account_id AS account_id,p.reminder_text FROM mbox.${table} j JOIN mbox.bottle_custody_orders o ON o.tenant_id=j.tenant_id AND o.store_id=j.store_id AND o.id=j.order_id JOIN mbox.bottle_custody_policies p ON p.tenant_id=j.tenant_id AND p.store_id=j.store_id WHERE j.tenant_id=$1 AND j.store_id=$2 AND j.${status}='pending' AND o.status='stored' AND ${kind==='code'?"j.expires_at>clock_timestamp() AND j.invalidated_at IS NULL AND j.order_version=o.version":"p.reminders_enabled AND j.expiry_snapshot=o.expires_at AND j.due_at<=clock_timestamp() AND (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date=(j.due_at AT TIME ZONE 'Asia/Shanghai')::date AND date_trunc('minute',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::time BETWEEN time '16:00' AND time '17:00'"} ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[scope.tenantId,scope.storeId])
   const row=rows.rows[0];if(!row)return null
   await tx.query(`UPDATE mbox.${table} SET ${status}='sending',claimed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[scope.tenantId,scope.storeId,row.id]);return row
  });if(!job)return false
  let result:SocialDeliveryResult={status:'rejected',providerReference:null,errorCode:'ACCOUNT_OR_RECIPIENT_UNAVAILABLE'}
  try{
   const delivery=job.account_id?await this.transactions.run(scope,async tx=>{const valid=await tx.query(`SELECT j.id FROM mbox.${table} j JOIN mbox.bottle_custody_orders o ON o.tenant_id=j.tenant_id AND o.store_id=j.store_id AND o.id=j.order_id WHERE j.tenant_id=$1 AND j.store_id=$2 AND j.id=$3 AND j.${status}='sending' AND o.status='stored' AND ${kind==='code'?"j.expires_at>clock_timestamp() AND j.invalidated_at IS NULL AND j.consumed_at IS NULL AND j.order_version=o.version":"j.expiry_snapshot=o.expires_at AND o.remaining_quantity>0 AND EXISTS(SELECT 1 FROM mbox.bottle_custody_policies p WHERE p.tenant_id=j.tenant_id AND p.store_id=j.store_id AND p.reminders_enabled)"}`,[scope.tenantId,scope.storeId,job.id]);if(!valid.rows.length)return null;const repo=new SocialAccountRepository(tx,this.protection);return{...await repo.account(job.account_id!),recipient:await repo.recipient(job.account_id!,job.customer_id)}},{readOnly:true}):null
   if(delivery?.recipient&&delivery.account.enabled){
    const adapter=new OfficialSocialAccountAdapter(delivery.account,delivery.credentials)
    if(kind==='code'){
     const template=delivery.account.code_template_id
     const code=this.protection.reveal({encryptedContact:job.encrypted_code!,contactHash:job.code_hash!,encryptionKeyId:job.key_id!}).split(':')[1]!
     const ttlMinutes=Math.max(1,Math.ceil((Date.parse(job.expires_at)-Date.now())/60_000))
     if(template)result=await adapter.sendSubscribe(delivery.recipient,template,{
      number1:code,
      thing3:`${ttlMinutes}分钟`,
      thing2:'寄存取走',
     },'pages/profile/index')
     else result.errorCode='TEMPLATE_NOT_CONFIGURED'
    }else{
     const template=delivery.account.reminder_template_id
     if(template)result=await adapter.sendSubscribe(delivery.recipient,template,{
      thing1:clipThing('超嗨M-BOX陆家嘴店'),
      character_string2:clipCharacter(String(job.public_id)),
      thing3:clipThing(String(job.item_name)),
      time4:formatWechatTime(Date.parse(String(job.stored_at))),
      time5:formatWechatTime(Date.parse(String(job.expires_at))),
     },'pages/profile/index')
     else result.errorCode='TEMPLATE_NOT_CONFIGURED'
    }
   }
  }catch{result={status:'rejected',providerReference:null,errorCode:'PRE_SEND_CONFIGURATION_UNAVAILABLE'}}
  await this.transactions.run(scope,tx=>tx.query(`UPDATE mbox.${table} SET ${status}=$4,provider_reference=$5,error_code=$6 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND ${status}='sending'`,[scope.tenantId,scope.storeId,job.id,result.status,result.providerReference,result.errorCode]))
  return true
 }
}
