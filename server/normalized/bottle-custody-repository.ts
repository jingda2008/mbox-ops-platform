import {custodyPhoto,custodyPhone,depositEvidenceSchema,validateDepositFraction,type DepositEvidence} from './custody-deposit-evidence.js'
import {custodyReport,type CustodyReportFilter} from './custody-report.js'
import {tabularWorkbook} from './custody-document.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {randomInt,randomUUID,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import type {ScopedTransaction} from './transaction-runner.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {custodyNumber,validateCustodyExtraFields,custodyPolicySchema,defaultCustodyPolicy,quantitySchema,quantityText,quantityUnits,BottleCustodyError,type CustodyPolicy} from './bottle-custody-policy.js'

const uuid=z.string().uuid()
const fields=`o.id,o.public_id,o.customer_id,o.member_no,o.category_id,c.name AS category_name,o.item_name,o.unit,o.original_quantity::text,o.remaining_quantity::text,o.source_order_id,o.source_reference,o.location,o.note,o.expires_at::text,o.stored_at::text,o.status,o.version,o.extra_fields,o.extra_field_snapshot,o.declared_value_minor::text`
export const custodyCreateSchema=z.object({evidence:depositEvidenceSchema,declaredValueMinor:z.number().int().min(0).max(100000000000).nullable().default(null),extraFields:z.record(z.string().max(30),z.string().max(500)).default({}),memberNo:z.string().trim().min(1).max(64),categoryId:uuid,itemName:z.string().trim().min(1).max(120),unit:z.string().trim().min(1).max(20),quantity:quantitySchema,sourceOrderId:uuid.nullable().default(null),sourceReference:z.string().trim().max(120).nullable().default(null),location:z.string().trim().max(120).default(''),note:z.string().trim().max(1000).default(''),expiresAt:z.iso.datetime({offset:true}).nullable().default(null),days:z.number().int().min(1).max(3660).nullable().default(null)}).strict().refine(v=>!(v.expiresAt&&v.days),'到期日期和天数只能选择一项')
export interface CustodyOrder extends Record<string,unknown>{id:string;public_id:string;customer_id:string;member_no:string;category_id:string;category_name:string;item_name:string;unit:string;original_quantity:string;remaining_quantity:string;expires_at:string;stored_at:string;status:string;version:number}
export class BottleCustodyRepository{
 constructor(private readonly tx:ScopedTransaction,private readonly protection?:ActivityContactProtectionKeyring){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async memberContact(memberNo:string){
  const member=(await this.tx.query<{customer_id:string}>(`SELECT mbox.canonical_customer_id(tenant_id,store_id,customer_id) AS customer_id FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND member_no=$3 AND status='active'`,[...this.scope,memberNo])).rows[0]
  if(!member)throw new BottleCustodyError('未找到有效会员，请核对会员号')
  const contact=await this.phoneForCustomer(member.customer_id)
  return{memberNo,maskedPhone:contact?.masked_value??null,source:contact?'membership':null}
 }
 private async phoneForCustomer(customerId:string){
  const rows=(await this.tx.query<{id:string;encrypted_value:Buffer;contact_hash:string;contact_encryption_key_id:string;masked_value:string}>(`SELECT id,encrypted_value,contact_hash,contact_encryption_key_id,masked_value FROM mbox.customer_verified_contacts WHERE tenant_id=$1 AND store_id=$2 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$3 AND contact_type='phone' AND processing_status='active' ORDER BY verified_at DESC,id LIMIT 2`,[...this.scope,customerId])).rows
  if(rows.length>1)throw new BottleCustodyError('会员存在多条有效手机号，请先核对会员联系信息')
  return rows[0]
 }
 private async recordDeposit(orderId:string,customerId:string,memberNo:string,unit:string,quantity:string,input:DepositEvidence,employeeId:string,collectionId:string|null){
  const evidence=depositEvidenceSchema.parse(input);validateDepositFraction(evidence,quantity,unit)
  if(!this.protection)throw new BottleCustodyError('手机号保护服务未配置')
  const contact=await this.phoneForCustomer(customerId)
  let phone:{encrypted:Buffer;hash:string;keyId:string;masked:string;source:string;contactId:string|null}
  if(contact){
   if(evidence.phone)throw new BottleCustodyError('会员已有手机号，请使用系统读取的号码；变更请走会员联系信息流程')
   if(!this.protection.validateProbe({kind:'verified_membership_phone',encryptedValue:contact.encrypted_value,contactHash:contact.contact_hash,encryptionKeyId:contact.contact_encryption_key_id}))throw new BottleCustodyError('会员手机号无法安全读取，请先核对会员联系信息')
   phone={encrypted:contact.encrypted_value,hash:contact.contact_hash,keyId:contact.contact_encryption_key_id,masked:contact.masked_value,source:'membership',contactId:contact.id}
  }else{
   if(!evidence.phone)throw new BottleCustodyError('会员未留有效手机号，请填写本次存酒联系手机号')
   const value=custodyPhone(evidence.phone),protectedPhone=this.protection.protect(value)
   phone={encrypted:Buffer.from(protectedPhone.encryptedBase64,'base64'),hash:protectedPhone.hash,keyId:protectedPhone.keyId,masked:value.startsWith('+86')&&value.length===14?`${value.slice(3,6)}****${value.slice(-4)}`:protectedPhone.masked,source:'manual',contactId:null}
  }
  const now=new Date((await this.tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)
  const photo=await custodyPhoto(evidence.photoBase64,now,memberNo,quantity,evidence.fraction)
  await this.tx.query(`INSERT INTO mbox.bottle_custody_deposits(tenant_id,store_id,order_id,collection_id,employee_id,quantity,fraction_label,phone_source,encrypted_phone,phone_hash,phone_key_id,phone_masked,contact_id,photo,photo_sha256,recorded_at,watermark) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[...this.scope,orderId,collectionId,employeeId,quantity,evidence.fraction,phone.source,phone.encrypted,phone.hash,phone.keyId,phone.masked,phone.contactId,photo.bytes,photo.sha256,now.toISOString(),photo.watermark])
 }
 async photo(orderId:string,depositId:string){
  const row=(await this.tx.query<{photo:Buffer}>('SELECT photo FROM mbox.bottle_custody_deposits WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4',[...this.scope,orderId,depositId])).rows[0]
  if(!row)throw new BottleCustodyError('照片不存在','CUSTODY_PHOTO_NOT_FOUND',404)
  return row.photo
 }
 async policy():Promise<{policy:CustodyPolicy;version:number}>{
  const row=(await this.tx.query<{policy:CustodyPolicy;version:number}>(`SELECT jsonb_build_object('allowRestorage',allow_restorage,'requireOriginalOrder',require_original_order,'archiveMode',archive_mode,'extraFieldDefinitions',extra_field_definitions,'printFields',print_fields,'printFooter',print_footer,'reportDimensions',report_dimensions,'serviceAccountId',service_account_id,'enabled',enabled,'defaultDays',default_days,'remindersEnabled',reminders_enabled,'reminderDays',reminder_days,'sendMinute',send_minute,'codeDigits',code_digits,'codeTtlSeconds',code_ttl_seconds,'resendSeconds',resend_seconds,'maximumAttempts',maximum_attempts,'allowPartial',allow_partial,'numberPattern',number_pattern,'printTitle',print_title,'reminderText',reminder_text) AS policy,version FROM mbox.bottle_custody_policies WHERE tenant_id=$1 AND store_id=$2`,this.scope)).rows[0]
  return row??{policy:defaultCustodyPolicy,version:0}
 }
 async savePolicy(policy:CustodyPolicy,version:number){
  const p=custodyPolicySchema.parse(policy)
  if(p.serviceAccountId){const account=await this.tx.query("SELECT id FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND kind='service_account'",[...this.scope,p.serviceAccountId]);if(!account.rows.length)throw new BottleCustodyError('请选择本店服务号')}
  if(p.remindersEnabled&&!p.serviceAccountId)throw new BottleCustodyError('启用提醒前请绑定服务号')
  const inserted=await this.tx.query('INSERT INTO mbox.bottle_custody_policies(tenant_id,store_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING store_id',this.scope)
  const row=(await this.tx.query<{version:number}>('SELECT version FROM mbox.bottle_custody_policies WHERE tenant_id=$1 AND store_id=$2 FOR UPDATE',this.scope)).rows[0]!
  if((inserted.rows.length?0:row.version)!==version)throw new BottleCustodyError('配置已变更，请刷新后重试','CUSTODY_VERSION_CONFLICT',409)
  await this.tx.query(`UPDATE mbox.bottle_custody_policies SET allow_restorage=$21,require_original_order=$22,archive_mode=$23,extra_field_definitions=$20::jsonb,print_fields=$17,print_footer=$18,report_dimensions=$19,service_account_id=$16,enabled=$3,default_days=$4,reminders_enabled=$5,reminder_days=$6,send_minute=$7,code_digits=$8,code_ttl_seconds=$9,resend_seconds=$10,maximum_attempts=$11,allow_partial=$12,number_pattern=$13,print_title=$14,reminder_text=$15,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2`,[...this.scope,p.enabled,p.defaultDays,p.remindersEnabled,p.reminderDays,p.sendMinute,p.codeDigits,p.codeTtlSeconds,p.resendSeconds,p.maximumAttempts,p.allowPartial,p.numberPattern,p.printTitle,p.reminderText,p.serviceAccountId,p.printFields,p.printFooter,p.reportDimensions,JSON.stringify(p.extraFieldDefinitions),p.allowRestorage,p.requireOriginalOrder,p.archiveMode])
  return this.policy()
 }
 async categories(){return(await this.tx.query('SELECT id,code,name,default_days,active,sort_order FROM mbox.bottle_custody_categories WHERE tenant_id=$1 AND store_id=$2 ORDER BY sort_order,name,id',this.scope)).rows}
 async saveCategory(input:{id?:string;code:string;name:string;defaultDays:number;active:boolean;sortOrder:number}){
  const id=input.id??randomUUID()
  const result=await this.tx.query(`INSERT INTO mbox.bottle_custody_categories(id,tenant_id,store_id,code,name,default_days,active,sort_order) VALUES($3,$1,$2,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,store_id,id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,default_days=EXCLUDED.default_days,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order RETURNING id`,[...this.scope,id,input.code,input.name,input.defaultDays,input.active,input.sortOrder]);return result.rows[0]!
 }
 async create(input:z.infer<typeof custodyCreateSchema>,employeeId:string){
  const {policy}=await this.policy();if(!policy.enabled)throw new BottleCustodyError('新建存酒已停用，已有存酒仍可处理')
  validateCustodyExtraFields(input.extraFields,policy.extraFieldDefinitions)
  const member=(await this.tx.query<{customer_id:string}>(`SELECT mbox.canonical_customer_id(tenant_id,store_id,customer_id) AS customer_id FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2 AND member_no=$3 AND status='active'`,[...this.scope,input.memberNo])).rows[0]
  if(!member)throw new BottleCustodyError('未找到有效会员，请核对会员号')
  const category=(await this.tx.query<{default_days:number}>('SELECT default_days FROM mbox.bottle_custody_categories WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND active FOR SHARE',[...this.scope,input.categoryId])).rows[0]
  if(!category)throw new BottleCustodyError('请选择有效存酒品类')
  if(input.sourceOrderId){const order=await this.tx.query(`SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND mbox.canonical_customer_id(tenant_id,store_id,created_by_customer_id)=$4`,[...this.scope,input.sourceOrderId,member.customer_id]);if(!order.rows.length)throw new BottleCustodyError('原订单不属于该会员或不存在')}
  const now=new Date((await this.tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)
  const expiry=input.expiresAt??new Date(now.getTime()+(input.days??category.default_days??policy.defaultDays)*86400000).toISOString()
  if(Date.parse(expiry)<=now.getTime())throw new BottleCustodyError('到期时间必须晚于当前时间')
  const serial=(await this.tx.query<{serial:string}>("SELECT nextval('mbox.bottle_custody_orders_serial_seq')::text AS serial")).rows[0]!.serial
  const number=custodyNumber(policy.numberPattern,now,input.memberNo,serial),id=randomUUID()
  await this.tx.query(`INSERT INTO mbox.bottle_custody_orders(id,serial,tenant_id,store_id,public_id,customer_id,member_no,category_id,item_name,unit,original_quantity,remaining_quantity,source_order_id,source_reference,location,note,expires_at,created_by_employee_id,extra_fields,extra_field_snapshot,declared_value_minor) OVERRIDING SYSTEM VALUE VALUES($3,$4,$1,$2,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13, $14,$15,$16,$17,$18::jsonb,$19::jsonb,$20)`,[...this.scope,id,serial,number,member.customer_id,input.memberNo,input.categoryId,input.itemName,input.unit,input.quantity,input.sourceOrderId,input.sourceReference,input.location,input.note,expiry,employeeId,JSON.stringify(input.extraFields),JSON.stringify(policy.extraFieldDefinitions),input.declaredValueMinor])
  await this.recordDeposit(id,member.customer_id,input.memberNo,input.unit,input.quantity,input.evidence,employeeId,null)
  await this.event(id,'stored',employeeId,input.quantity)
  return this.detail(id)
 }
 async list(filter:{memberNo?:string;categoryId?:string;status?:string;from?:string;to?:string;query?:string;cursor?:string}={}){
  const predicate=`o.tenant_id=$1 AND o.store_id=$2 AND ($3::text IS NULL OR o.member_no=$3) AND ($4::uuid IS NULL OR o.category_id=$4) AND ($5::text IS NULL OR o.status=$5) AND ($6::timestamptz IS NULL OR o.stored_at>=$6) AND ($7::timestamptz IS NULL OR o.stored_at<$7) AND ($8::text IS NULL OR position($8 in o.public_id)>0 OR position($8 in o.item_name)>0)`
  const values=[...this.scope,filter.memberNo??null,filter.categoryId??null,filter.status??null,filter.from??null,filter.to??null,filter.query??null]
  const rows=(await this.tx.query<CustodyOrder>(`SELECT ${fields} FROM mbox.bottle_custody_orders o JOIN mbox.bottle_custody_categories c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.category_id WHERE ${predicate} AND ($9::uuid IS NULL OR o.id>$9) ORDER BY o.id LIMIT 101`,[...values,filter.cursor??null])).rows
  const summary=(await this.tx.query<{count:string;stored:string;collected:string;archived:string}>(`SELECT count(*)::text AS count,count(*) FILTER(WHERE o.status='stored')::text AS stored,count(*) FILTER(WHERE o.status='collected')::text AS collected,count(*) FILTER(WHERE o.status='archived')::text AS archived FROM mbox.bottle_custody_orders o WHERE ${predicate}`,values)).rows[0]!
  const categoryCounts=(await this.tx.query<{name:string;count:string}>(`SELECT c.name,count(*)::text AS count FROM mbox.bottle_custody_orders o JOIN mbox.bottle_custody_categories c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.category_id WHERE ${predicate} GROUP BY c.id,c.name ORDER BY c.name,c.id`,values)).rows
  return{items:rows.slice(0,100),nextCursor:rows.length>100?rows[99]!.id:null,summary:{...summary,categoryCounts,amountStatus:'declared_value_not_revenue'}}
 }
 async exportReport(input:Omit<CustodyReportFilter,'offset'>,employeeId:string){
  if(input.scope!=='custody')await new StaffAccessRepository(this.tx).assertPermission(employeeId,'order.history.all')
  const result=await custodyReport(this.tx,{...input,offset:0},10000)
  if(result.nextOffset!==null)throw new BottleCustodyError('结果超过一万笔，请缩小日期范围')
  const rows:unknown[][]=[['类型','编号','会员号','品类','内容','时间（北京时间）','状态','单笔金额（元）','金额口径','币种'],...result.items.map(r=>[r.type==='custody'?'存酒':'消费',r.public_id,r.member_no,r.category,r.item_name,new Date(r.occurred_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),r.status,r.amount_minor==null?'未登记':(Number(r.amount_minor)/100).toFixed(2),r.amount_basis,r.currency])]
  return{base64:tabularWorkbook(rows,'可选范围报表').toString('base64'),filename:'MBOX-可选范围报表.xlsx',count:result.items.length,summary:result.summary}
 }
 async detail(id:string){uuid.parse(id);const order=(await this.tx.query<CustodyOrder>(`SELECT ${fields} FROM mbox.bottle_custody_orders o JOIN mbox.bottle_custody_categories c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.category_id WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3`,[...this.scope,id])).rows[0];if(!order)throw new BottleCustodyError('存酒单不存在','CUSTODY_NOT_FOUND',404)
  const events=(await this.tx.query('SELECT e.event_type,e.quantity::text,e.challenge_id,e.collection_id,e.employee_id,staff.display_name AS employee_name,e.reason,e.occurred_at::text FROM mbox.bottle_custody_events e LEFT JOIN mbox.employees staff ON staff.tenant_id=e.tenant_id AND staff.store_id=e.store_id AND staff.id=e.employee_id WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.order_id=$3 ORDER BY e.occurred_at,e.id',[...this.scope,id])).rows
  const collections=(await this.tx.query('SELECT id,quantity::text,returned_quantity::text,status,restored_order_id,collected_at::text FROM mbox.bottle_custody_collections WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY collected_at,id',[...this.scope,id])).rows
  const challenges=(await this.tx.query('SELECT id,quantity::text,delivery_status,provider_reference,error_code,expires_at::text,verified_at::text,consumed_at::text,invalidated_at::text,attempts,maximum_attempts FROM mbox.bottle_custody_challenges WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY created_at DESC LIMIT 5',[...this.scope,id])).rows
  const reminders=(await this.tx.query('SELECT days_before,due_at::text,status,provider_reference,error_code FROM mbox.bottle_custody_reminders WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY created_at DESC LIMIT 100',[...this.scope,id])).rows
  const deposits=(await this.tx.query('SELECT id,quantity::text,fraction_label,phone_source,phone_masked,employee_id,recorded_at::text,watermark,photo_sha256 FROM mbox.bottle_custody_deposits WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY recorded_at DESC,id',[...this.scope,id])).rows
  return{order,events,collections,challenges,reminders,deposits}
 }
 private async lock(id:string){uuid.parse(id);const row=(await this.tx.query<CustodyOrder>('SELECT id,customer_id,version,status,remaining_quantity::text,original_quantity::text,expires_at::text FROM mbox.bottle_custody_orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,id])).rows[0];if(!row)throw new BottleCustodyError('存酒单不存在','CUSTODY_NOT_FOUND',404);return row}
 async requestCode(id:string,quantity:string,employeeId:string){
  quantitySchema.parse(quantity);const order=await this.lock(id),{policy}=await this.policy()
  if(order.status!=='stored'||quantityUnits(quantity)>quantityUnits(order.remaining_quantity))throw new BottleCustodyError('存酒状态或可取数量已变化')
  if(!policy.allowPartial&&quantityUnits(quantity)!==quantityUnits(order.remaining_quantity))throw new BottleCustodyError('当前仅支持整单取酒')
  if(!this.protection)throw new BottleCustodyError('验证码加密服务未配置','CUSTODY_DELIVERY_UNAVAILABLE',503)
  const recent=await this.tx.query('SELECT id FROM mbox.bottle_custody_challenges WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND created_at>clock_timestamp()-make_interval(secs=>$4)',[...this.scope,id,policy.resendSeconds])
  if(recent.rows.length)throw new BottleCustodyError('请稍后重发验证码','CUSTODY_RATE_LIMIT',429)
  await this.tx.query('UPDATE mbox.bottle_custody_challenges SET invalidated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND consumed_at IS NULL AND invalidated_at IS NULL',[...this.scope,id])
  const challengeId=randomUUID(),code=randomInt(10**policy.codeDigits).toString().padStart(policy.codeDigits,'0'),protectedCode=this.protection.protect(`${challengeId}:${code}`)
  await this.tx.query(`INSERT INTO mbox.bottle_custody_challenges(id,tenant_id,store_id,order_id,customer_id,quantity,order_version,code_hash,encrypted_code,key_id,maximum_attempts,expires_at,created_by_employee_id) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+make_interval(secs=>$12),$13)`,[...this.scope,challengeId,id,order.customer_id,quantity,order.version,protectedCode.hash,Buffer.from(protectedCode.encryptedBase64,'base64'),protectedCode.keyId,policy.maximumAttempts,policy.codeTtlSeconds,employeeId])
  await this.event(id,'code_requested',employeeId,quantity,challengeId)
  return{challengeId,deliveryStatus:'pending',message:'发送任务已登记，请等待服务号发送结果'}
 }
 async verify(id:string,challengeId:string,code:string,employeeId:string){
  uuid.parse(challengeId);z.string().regex(/^[0-9]{4,8}$/).parse(code);const order=await this.lock(id)
  const challenge=(await this.tx.query<{encrypted_code:Buffer;code_hash:string;key_id:string;eligible:boolean}>(`SELECT encrypted_code,code_hash,key_id,(delivery_status='accepted' AND invalidated_at IS NULL AND consumed_at IS NULL AND expires_at>clock_timestamp() AND attempts<maximum_attempts AND order_version=$5) AS eligible FROM mbox.bottle_custody_challenges WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4 FOR UPDATE`,[...this.scope,id,challengeId,order.version])).rows[0]
  if(!challenge?.eligible||!this.protection)throw new BottleCustodyError('验证码尚未发送成功、已失效或尝试次数已用尽')
  const actual=this.protection.reveal({encryptedContact:challenge.encrypted_code,contactHash:challenge.code_hash,encryptionKeyId:challenge.key_id})
  const supplied=Buffer.from(`${challengeId}:${code}`),expected=Buffer.from(actual)
  const valid=supplied.length===expected.length&&timingSafeEqual(supplied,expected)
  await this.tx.query(`UPDATE mbox.bottle_custody_challenges SET attempts=attempts+1,verified_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4`,[...this.scope,id,challengeId,valid])
  await this.event(id,valid?'code_verified':'code_rejected',employeeId,null,challengeId)
  // A wrong attempt commits its counter and audit; throwing here would undo both.
  return{verified:valid,message:valid?'验证通过，请核对实物后点击已取走':'验证码不正确，请重新核对'}
 }
 async collect(id:string,challengeId:string,employeeId:string){
  uuid.parse(challengeId);const order=await this.lock(id)
  const challenge=(await this.tx.query<{quantity:string}>(`SELECT quantity::text FROM mbox.bottle_custody_challenges WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4 AND order_version=$5 AND verified_at IS NOT NULL AND expires_at>clock_timestamp() AND invalidated_at IS NULL AND consumed_at IS NULL AND delivery_status='accepted' FOR UPDATE`,[...this.scope,id,challengeId,order.version])).rows[0]
  if(!challenge||order.status!=='stored')throw new BottleCustodyError('须先完成有效验证码验证，且存酒状态未发生变化')
  const remaining=quantityUnits(order.remaining_quantity)-quantityUnits(challenge.quantity);if(remaining<0n)throw new BottleCustodyError('剩余数量不足')
  const collectionId=randomUUID()
  await this.tx.query('UPDATE mbox.bottle_custody_challenges SET consumed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,challengeId])
  await this.tx.query(`INSERT INTO mbox.bottle_custody_collections(id,tenant_id,store_id,order_id,challenge_id,quantity,created_by_employee_id) VALUES($3,$1,$2,$4,$5,$6,$7)`,[...this.scope,collectionId,id,challengeId,challenge.quantity,employeeId])
  await this.tx.query(`UPDATE mbox.bottle_custody_orders SET remaining_quantity=$4,status=CASE WHEN $4::numeric=0 THEN 'collected' ELSE 'stored' END,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id,quantityText(remaining)])
  await this.event(id,'collected',employeeId,challenge.quantity,challengeId,collectionId)
  return this.detail(id)
 }
 async resolveCollection(id:string,collectionId:string,quantity:string|null,employeeId:string,reason:string,restorageMode:'original'|'new'='original',evidence?:DepositEvidence){
  uuid.parse(collectionId);const order=await this.lock(id),{policy}=await this.policy()
  const collection=(await this.tx.query<{quantity:string;status:string}>('SELECT quantity::text,status FROM mbox.bottle_custody_collections WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4 FOR UPDATE',[...this.scope,id,collectionId])).rows[0]
  if(!collection||collection.status!=='collected')throw new BottleCustodyError('该次取酒已处理，请刷新核对')
  let restoredOrderId:string|null=null
  if(quantity!==null){
   if(!evidence)throw new BottleCustodyError('再次寄存必须重新拍照并保留手机号')
   quantitySchema.parse(quantity);if(!policy.allowRestorage)throw new BottleCustodyError('当前规则已关闭再存')
   if(quantityUnits(quantity)>quantityUnits(collection.quantity))throw new BottleCustodyError('再存数量不能超过本次取酒数量')
   if(!policy.allowPartial&&quantityUnits(quantity)!==quantityUnits(collection.quantity))throw new BottleCustodyError('当前仅支持整笔再存')
   if(restorageMode==='new'){
    if(policy.requireOriginalOrder)throw new BottleCustodyError('当前规则要求再存沿用原单')
    const old=(await this.detail(id)).order
    const next=await this.create(custodyCreateSchema.parse({evidence,memberNo:old.member_no,categoryId:old.category_id,itemName:old.item_name,unit:old.unit,quantity,location:old.location,note:'再存新单；原取酒来源保留在审计记录中',extraFields:Object.fromEntries(policy.extraFieldDefinitions.map(field=>[field.key,String((old.extra_fields as Record<string,string>)[field.key]??'')])),declaredValueMinor:null}),employeeId)
    restoredOrderId=next.order.id
    await this.event(restoredOrderId,'restored',employeeId,quantity,null,collectionId,`再存来源：${old.public_id}；${reason}`)
   }else{
    if(Date.parse(order.expires_at)<=Date.now())throw new BottleCustodyError('原单已到期，请先调整到期时间再办理再存')
    restoredOrderId=id
    const old=(await this.detail(id)).order
    await this.recordDeposit(id,old.customer_id,old.member_no,old.unit,quantity,evidence,employeeId,collectionId)
    await this.tx.query("UPDATE mbox.bottle_custody_orders SET remaining_quantity=remaining_quantity+$4::numeric,status='stored',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,id,quantity])
   }
  }
  await this.tx.query('UPDATE mbox.bottle_custody_collections SET returned_quantity=$5,status=$6,restored_order_id=$7 WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND id=$4',[...this.scope,id,collectionId,quantity??'0',quantity?'restored':'archived',restoredOrderId])
  await this.event(id,quantity?'restored':'collection_closed',employeeId,quantity,null,collectionId,`${reason}${restoredOrderId&&restoredOrderId!==id?`;再存新单ID=${restoredOrderId}`:''}`)
  if(policy.archiveMode==='automatic')await this.archiveIfComplete(id,employeeId,'所有取酒已处理，按规则自动归档',false)
  return{...await this.detail(id),restoredOrderId}
 }
 private async archiveIfComplete(id:string,employeeId:string,reason:string,required:boolean){
  const row=await this.tx.query("UPDATE mbox.bottle_custody_orders SET status='archived',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='collected' AND remaining_quantity=0 AND NOT EXISTS(SELECT 1 FROM mbox.bottle_custody_collections WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status='collected') RETURNING id",[...this.scope,id])
  if(!row.rows.length&&required)throw new BottleCustodyError('有剩余存酒、待处理取酒或单据已经归档，不能再次归档')
  if(row.rows.length)await this.event(id,'archived',employeeId,null,null,null,reason)
 }
 async archive(id:string,employeeId:string,reason:string){await this.lock(id);await this.archiveIfComplete(id,employeeId,reason,true);return this.detail(id)}
 async changeExpiry(id:string,expiresAt:string,employeeId:string,reason:string){await this.lock(id);if(Date.parse(expiresAt)<=Date.now())throw new BottleCustodyError('请选择未来的到期时间');await this.tx.query('UPDATE mbox.bottle_custody_orders SET expires_at=$4,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,id,expiresAt]);await this.event(id,'expiry_changed',employeeId,null,null,null,reason);return this.detail(id)}
 async event(id:string,type:string,employeeId:string,quantity:string|null=null,challengeId:string|null=null,collectionId:string|null=null,reason=''){
  await this.tx.query('INSERT INTO mbox.bottle_custody_events(tenant_id,store_id,order_id,event_type,quantity,challenge_id,collection_id,employee_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...this.scope,id,type,quantity,challengeId,collectionId,employeeId,reason])
 }
}
