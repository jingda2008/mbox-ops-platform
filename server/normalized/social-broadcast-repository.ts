import {z} from 'zod'
import type {ScopedTransaction,StoreScope,ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {appendAuditEvent} from './command-executor.js'
import {SocialAccountRepository} from './social-account-repository.js'
import {OfficialSocialAccountAdapter,type SocialDeliveryResult} from './social-account-adapter.js'
import {BottleCustodyError} from './bottle-custody-policy.js'
export const broadcastSchema=z.object({accountId:z.string().uuid(),title:z.string().trim().min(1).max(80),content:z.string().trim().min(1).max(600).refine(v=>Buffer.byteLength(v,'utf8')<=1800),scheduledAt:z.iso.datetime({offset:true})}).strict()
export class SocialBroadcastRepository{
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async list(cursor?:string){return(await this.tx.query('SELECT id,account_id,title,content,scheduled_at::text,status,provider_reference,error_code,created_at::text FROM mbox.social_broadcasts WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id<$3) ORDER BY id DESC LIMIT 100',[...this.scope,cursor??null])).rows}
 async create(input:z.infer<typeof broadcastSchema>,employeeId:string){
  if(Date.parse(input.scheduledAt)<=Date.now())throw new BottleCustodyError('发送时间须在未来')
  const account=await this.tx.query("SELECT id FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND kind='service_account'",[...this.scope,input.accountId]);if(!account.rows.length)throw new BottleCustodyError('请选择本店服务号')
  return(await this.tx.query<{id:string;status:string}>('INSERT INTO mbox.social_broadcasts(tenant_id,store_id,account_id,title,content,scheduled_at,created_by_employee_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status',[...this.scope,input.accountId,input.title,input.content,input.scheduledAt,employeeId])).rows[0]!
 }
 async transition(id:string,action:'schedule'|'cancel'){
  const row=(await this.tx.query<{status:string;scheduled_at:string;account_id:string}>('SELECT status,scheduled_at::text,account_id FROM mbox.social_broadcasts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,id])).rows[0]
  if(!row)throw new BottleCustodyError('群发任务不存在')
  if(action==='schedule'){
   if(row.status!=='draft'||Date.parse(row.scheduled_at)<=Date.now())throw new BottleCustodyError('只有尚未过期的草稿可以安排群发')
   if(!(await this.tx.query('SELECT id FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND enabled',[...this.scope,row.account_id])).rows.length)throw new BottleCustodyError('服务号未启用')
  }else if(!['draft','scheduled'].includes(row.status))throw new BottleCustodyError('任务已开始发送或已结束，不能再次操作')
  const status=action==='schedule'?'scheduled':'cancelled';await this.tx.query('UPDATE mbox.social_broadcasts SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,id,status]);return{id,status}
 }
 async recordReceipt(accountId:string,reference:string,providerStatus:string){
  const status=providerStatus==='send success'?'delivered':'delivery_failed'
  await this.tx.query("UPDATE mbox.social_broadcasts SET status=$5,error_code=$6,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND account_id=$3 AND provider_reference=$4 AND status IN('accepted','unknown')",[...this.scope,accountId,reference,status,status==='delivered'?null:'PROVIDER_DELIVERY_FAILED'])
 }
}
export async function sendNextBroadcast(transactions:Pick<ScopedPostgresTransactionRunner,'run'>,scope:StoreScope,protection:ActivityContactProtectionKeyring){
 const job=await transactions.run(scope,async tx=>{
  await tx.query("UPDATE mbox.social_broadcasts SET status='unknown',error_code='WORKER_INTERRUPTED' WHERE tenant_id=$1 AND store_id=$2 AND status='sending' AND claimed_at<clock_timestamp()-interval '2 minutes'",[scope.tenantId,scope.storeId])
  const row=(await tx.query<{id:string;account_id:string;content:string}>("SELECT id,account_id,content FROM mbox.social_broadcasts WHERE tenant_id=$1 AND store_id=$2 AND status='scheduled' AND scheduled_at<=clock_timestamp() ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[scope.tenantId,scope.storeId])).rows[0]
  if(!row)return null
  await tx.query("UPDATE mbox.social_broadcasts SET status='sending',claimed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,row.id]);return row
 });if(!job)return false
 let result:SocialDeliveryResult
 try{const a=await transactions.run(scope,tx=>new SocialAccountRepository(tx,protection).account(job.account_id),{readOnly:true});result=await new OfficialSocialAccountAdapter(a.account,a.credentials).sendBroadcast(job.content)}catch{result={status:'unknown',providerReference:null,errorCode:'DELIVERY_OUTCOME_UNKNOWN'}}
 await transactions.run(scope,async tx=>{await tx.query("UPDATE mbox.social_broadcasts SET status=$4,provider_reference=$5,error_code=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='sending'",[scope.tenantId,scope.storeId,job.id,result.status,result.providerReference,result.errorCode]);await appendAuditEvent(tx,{actor:{type:'system',ref:'social-broadcast'},businessDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),action:'social.broadcast.submitted',objectType:'social_broadcast',objectId:job.id,afterData:result})})
 return true
}
