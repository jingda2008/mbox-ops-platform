import {appendAuditEvent} from './command-executor.js'
import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {ScopedTransaction} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {OfficialSocialAccountAdapter,socialCredentialsSchema,type SocialAccount,type SocialCredentials} from './social-account-adapter.js'
import {BottleCustodyError} from './bottle-custody-policy.js'
export const socialAccountInputSchema=z.object({id:z.string().uuid().optional(),kind:z.enum(['service_account','wecom']),name:z.string().trim().min(1).max(80),appId:z.string().regex(/^(?:wx|ww)[A-Za-z0-9_-]{4,126}$/),enabled:z.boolean(),credentials:socialCredentialsSchema.optional(),codeTemplateId:z.string().max(128).nullable(),codeDataKey:z.string().regex(/^[a-z_]+[0-9]+$/),reminderTemplateId:z.string().max(128).nullable(),reminderDataKey:z.string().regex(/^[a-z_]+[0-9]+$/)}).strict()
export function xmlValue(xml:string,tag:string,required=true):string{
 if(/<!DOCTYPE|<!ENTITY/i.test(xml)||xml.length>65536)throw new Error('INVALID_XML')
 const matches=[...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`,'g'))]
 if(!matches.length&&!required)return ''
 if(matches.length!==1)throw new Error('INVALID_EVENT_FIELD')
 const raw=matches[0]![1]!.trim(),value=raw.startsWith('<![CDATA[')&&raw.endsWith(']]>')?raw.slice(9,-3):raw
 if(/[<>]/.test(value)||value.length>1024)throw new Error('INVALID_EVENT_FIELD')
 return value
}
export class SocialAccountRepository{
 constructor(private readonly tx:ScopedTransaction,private readonly protection:ActivityContactProtectionKeyring){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async list(){return(await this.tx.query('SELECT id,kind,name,app_id,enabled,code_template_id,code_data_key,reminder_template_id,reminder_data_key,updated_at::text FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 ORDER BY name,id',this.scope)).rows}
 async account(id:string):Promise<{account:SocialAccount;credentials:SocialCredentials}>{
  const row=(await this.tx.query<SocialAccount&Record<string,unknown>&{credential_hash:string;encrypted_credentials:Buffer;key_id:string}>('SELECT * FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,id])).rows[0]
  if(!row)throw new BottleCustodyError('服务号或企微配置不存在')
  const secret=this.protection.reveal({encryptedContact:row.encrypted_credentials,contactHash:row.credential_hash,encryptionKeyId:row.key_id})
  return{account:row,credentials:socialCredentialsSchema.parse(JSON.parse(secret))}
 }
 async save(input:z.infer<typeof socialAccountInputSchema>,employeeId:string){
  const id=input.id??randomUUID()
  const existing=input.id?await this.account(id):null
  if(existing&&(existing.account.kind!==input.kind||existing.account.app_id!==input.appId))throw new BottleCustodyError('已建账号不能替换主体，请新建配置')
  if(!input.credentials&&!existing)throw new BottleCustodyError('新建账号需要完整密钥配置')
  const protectedValue=this.protection.protect(JSON.stringify(input.credentials??existing!.credentials))
  await this.tx.query(`INSERT INTO mbox.social_accounts(id,tenant_id,store_id,kind,name,app_id,enabled,credential_hash,encrypted_credentials,key_id,code_template_id,code_data_key,reminder_template_id,reminder_data_key,created_by_employee_id) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(tenant_id,store_id,id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,credential_hash=EXCLUDED.credential_hash,encrypted_credentials=EXCLUDED.encrypted_credentials,key_id=EXCLUDED.key_id,code_template_id=EXCLUDED.code_template_id,code_data_key=EXCLUDED.code_data_key,reminder_template_id=EXCLUDED.reminder_template_id,reminder_data_key=EXCLUDED.reminder_data_key,updated_at=clock_timestamp()`,[...this.scope,id,input.kind,input.name,input.appId,input.enabled,protectedValue.hash,Buffer.from(protectedValue.encryptedBase64,'base64'),protectedValue.keyId,input.codeTemplateId,input.codeDataKey,input.reminderTemplateId,input.reminderDataKey,employeeId])
  if(existing?.account.enabled&&!input.enabled){const linked=await this.tx.query<{customer_id:string}>('SELECT DISTINCT customer_id FROM mbox.social_relationships WHERE tenant_id=$1 AND store_id=$2 AND account_id=$3 AND customer_id IS NOT NULL',[...this.scope,id]);for(const row of linked.rows)await this.refreshCards(row.customer_id)}
  return{id,callbackPath:`/api/social-accounts/${id}/callback`,credentialsConfigured:true}
 }
 async recordBroadcastReceipt(accountId:string,xml:string){
  const reference=xmlValue(xml,'MsgID'),success=xmlValue(xml,'Status')==='send success'
  await this.tx.query("UPDATE mbox.social_broadcasts SET status=$5,error_code=$6,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND account_id=$3 AND provider_reference=$4 AND status IN('accepted','unknown')",[...this.scope,accountId,reference,success?'delivered':'delivery_failed',success?null:'PROVIDER_DELIVERY_FAILED'])
 }
 async ingestVerified(accountId:string,xml:string){
  const type=xmlValue(xml,'Event',false)||xmlValue(xml,'MsgType',false)||'unknown'
  const seconds=Number(xmlValue(xml,'CreateTime'))
  if(!Number.isSafeInteger(seconds)||seconds<1||seconds*1000>Date.now()+600000)throw new Error('INVALID_EVENT_TIME')
  const payload=this.protection.protect(xml),fingerprint=createHash('sha256').update(xml).digest('hex')
  await this.tx.query(`INSERT INTO mbox.social_callback_events(tenant_id,store_id,account_id,fingerprint,event_type,provider_occurred_at,payload_hash,encrypted_payload,key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[...this.scope,accountId,fingerprint,type,new Date(seconds*1000).toISOString(),payload.hash,Buffer.from(payload.encryptedBase64,'base64'),payload.keyId])
  return true
 }
 async applyRelationship(input:{accountId:string;externalId:string;staffId:string;active:boolean;unionId:string|null;occurredAt:string}){
  const external=this.protection.protect(input.externalId),unionHash=input.unionId?createHash('sha256').update(input.unionId).digest('hex'):null
  let customerId:string|null=null
  if(unionHash){const customers=(await this.tx.query<{id:string}>(`SELECT DISTINCT mbox.canonical_customer_id(ci.tenant_id,ci.store_id,ci.customer_id) AS id FROM mbox.wechat_identities wi JOIN mbox.customer_identities ci ON ci.tenant_id=wi.tenant_id AND ci.store_id=wi.store_id AND ci.identity_kind='wechat' AND ci.identity_hash=encode(sha256(convert_to('wechat:'||wi.principal_id,'UTF8')),'hex') AND ci.status='active' WHERE wi.tenant_id=$1 AND wi.store_id=$2 AND wi.unionid_sha256=$3 AND wi.revoked_at IS NULL`,[...this.scope,unionHash])).rows;if(customers.length===1)customerId=customers[0]!.id}
  await this.tx.query(`INSERT INTO mbox.social_relationships(tenant_id,store_id,account_id,external_hash,encrypted_external_id,key_id,unionid_sha256,customer_id,staff_external_id,active,provider_occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,store_id,account_id,external_hash,staff_external_id) DO UPDATE SET active=EXCLUDED.active,unionid_sha256=COALESCE(EXCLUDED.unionid_sha256,social_relationships.unionid_sha256),customer_id=COALESCE(EXCLUDED.customer_id,social_relationships.customer_id),provider_occurred_at=EXCLUDED.provider_occurred_at,verified_at=clock_timestamp() WHERE social_relationships.provider_occurred_at<EXCLUDED.provider_occurred_at OR(social_relationships.provider_occurred_at=EXCLUDED.provider_occurred_at AND NOT EXCLUDED.active)`,[...this.scope,input.accountId,external.hash,Buffer.from(external.encryptedBase64,'base64'),external.keyId,unionHash,customerId,input.staffId,input.active,input.occurredAt])
  const linked=(await this.tx.query<{customer_id:string|null}>('SELECT customer_id FROM mbox.social_relationships WHERE tenant_id=$1 AND store_id=$2 AND account_id=$3 AND external_hash=$4',[...this.scope,input.accountId,external.hash])).rows
  for(const id of new Set(linked.map(row=>row.customer_id).filter((value):value is string=>!!value)))await this.refreshCards(id)
 }
 async relinkVerifiedRelationships(){
  // Follow may precede Mini Program sign-in. Bind only an unambiguous platform UnionID.
  const rows=await this.tx.query<{customer_id:string}>(`WITH matches AS (
   SELECT r.id,min(mbox.canonical_customer_id(ci.tenant_id,ci.store_id,ci.customer_id)::text)::uuid AS customer_id
   FROM mbox.social_relationships r JOIN mbox.wechat_identities wi ON wi.tenant_id=r.tenant_id AND wi.store_id=r.store_id AND wi.unionid_sha256=r.unionid_sha256 AND wi.revoked_at IS NULL
   JOIN mbox.customer_identities ci ON ci.tenant_id=wi.tenant_id AND ci.store_id=wi.store_id AND ci.identity_kind='wechat' AND ci.identity_hash=encode(sha256(convert_to('wechat:'||wi.principal_id,'UTF8')),'hex') AND ci.status='active'
   WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.customer_id IS NULL AND r.unionid_sha256 IS NOT NULL
   GROUP BY r.id HAVING count(DISTINCT mbox.canonical_customer_id(ci.tenant_id,ci.store_id,ci.customer_id))=1
  ) UPDATE mbox.social_relationships r SET customer_id=m.customer_id FROM matches m WHERE r.id=m.id RETURNING r.customer_id`,this.scope)
  for(const id of new Set(rows.rows.map(r=>r.customer_id)))await this.refreshCards(id)
 }
 async refreshCards(customerId:string){
  // Manual suspension/withdrawal remains separate. Only this flag can auto-resume.
  const revoked=await this.tx.query<{id:string;status:string}>(`UPDATE mbox.member_cards c SET status=CASE WHEN p.auto_restore THEN 'suspended' ELSE 'revoked' END,social_suspended=p.auto_restore,updated_at=clock_timestamp() FROM mbox.member_card_projects p WHERE c.tenant_id=$1 AND c.store_id=$2 AND p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id($1,$2,$3) AND c.status='active' AND p.require_social_conditions AND NOT mbox.card_social_conditions_met(c.tenant_id,c.store_id,c.project_id,c.customer_id) RETURNING c.id,c.status`,[...this.scope,customerId])
  const restored=await this.tx.query<{id:string;status:string}>(`UPDATE mbox.member_cards c SET status='active',social_suspended=false,updated_at=clock_timestamp() FROM mbox.member_card_projects p WHERE c.tenant_id=$1 AND c.store_id=$2 AND p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id($1,$2,$3) AND c.status='suspended' AND c.social_suspended AND p.auto_restore AND c.valid_until>clock_timestamp() AND mbox.card_social_conditions_met(c.tenant_id,c.store_id,c.project_id,c.customer_id) RETURNING c.id,c.status`,[...this.scope,customerId])
  for(const card of [...revoked.rows,...restored.rows])await appendAuditEvent(this.tx,{actor:{type:'system',ref:'social-relationship'},businessDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),action:'member_card.social_state_changed',objectType:'member_card',objectId:card.id,afterData:{status:card.status,customerId}})
 }
 async recipient(accountId:string,customerId:string){
  const rows=(await this.tx.query<{encrypted_external_id:Buffer;external_hash:string;key_id:string}>(`SELECT r.encrypted_external_id,r.external_hash,r.key_id FROM mbox.social_relationships r JOIN mbox.social_accounts a ON a.tenant_id=r.tenant_id AND a.store_id=r.store_id AND a.id=r.account_id WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.account_id=$3 AND a.enabled AND a.kind='service_account' AND r.active AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id($1,$2,$4) ORDER BY r.verified_at DESC LIMIT 2`,[...this.scope,accountId,customerId])).rows
  if(rows.length!==1)return null
  const row=rows[0]!;return this.protection.reveal({encryptedContact:row.encrypted_external_id,contactHash:row.external_hash,encryptionKeyId:row.key_id})
 }
}
export async function processSocialEvent(repo:SocialAccountRepository,accountId:string,xml:string,adapter?:OfficialSocialAccountAdapter){
 const {account,credentials}=await repo.account(accountId),event=xmlValue(xml,'Event',false)
 
 if(account.kind==='service_account'&&event==='MASSSENDJOBFINISH'){await repo.recordBroadcastReceipt(accountId,xml);return}
 if(account.kind==='service_account'&&!['subscribe','unsubscribe'].includes(event))return
 if(account.kind==='wecom'&&event!=='change_external_contact')return
 const change=account.kind==='service_account'?event:xmlValue(xml,'ChangeType')
 if(!['subscribe','unsubscribe','add_external_contact','del_external_contact','del_follow_user'].includes(change))return
 const externalId=xmlValue(xml,account.kind==='service_account'?'FromUserName':'ExternalUserID'),staffId=account.kind==='wecom'?xmlValue(xml,'UserID'):''
 const active=['subscribe','add_external_contact'].includes(change)
 // A pending half-contact is not evidence that the customer has added the enterprise.
 const info=active?await(adapter??new OfficialSocialAccountAdapter(account,credentials)).user(externalId):{active:false,unionId:null}
 await repo.applyRelationship({accountId,externalId,staffId,active:active&&info.active&&(account.kind!=='wecom'||('followers' in info&&Array.isArray(info.followers)&&info.followers.includes(staffId))),unionId:info.unionId,occurredAt:new Date(Number(xmlValue(xml,'CreateTime'))*1000).toISOString()})
}
