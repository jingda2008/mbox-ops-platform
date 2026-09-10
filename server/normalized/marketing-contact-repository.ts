import {createHash} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {CustomerRepository} from './customer-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {appendAuditEvent} from './command-executor.js'
import {parseMarketingNotice,marketingChannels,marketingPurposes,MarketingContactError,type MarketingNotice,type MarketingChannel,type MarketingPurpose} from './marketing-contact-policy.js'
type ConsentEvent=Record<string,unknown>&{id:string;sequence:string;action:'granted'|'withdrawn'|'denied'|'stop_all';channel:MarketingChannel|null;purpose:MarketingPurpose|null;notice_id:string|null;valid_until:string|null;created_at:string}
type Notice=Record<string,unknown>&{id:string;code:string;version:number;created_by_employee_id:string;status:string;rule:MarketingNotice;decisions:Array<{action:string;employee_id:string}>}
function id(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new MarketingContactError('记录编号无效')}
function reason(value:string){if(typeof value!=='string'||value.trim().length<2||value.length>500)throw new MarketingContactError('须填写2至500字原因')}
export class MarketingContactRepository{
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
  private async lock(key:string){const result=await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`marketing:${this.scope.join(':')}:${key}`]);if(!result.rows[0]?.locked)throw new MarketingContactError('联系偏好正在更新，请稍后重试；正常点单不受影响')}
  private async identity(customerId:string){
    id(customerId);const result=await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[`table-customer-movement:${this.scope.join(':')}`])
    if(!result.rows[0]?.locked)throw new MarketingContactError('身份正在同步，请稍后重试')
    const customer=(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id;await this.lock(`customer:${customer}`);return customer
  }
  private async audit(action:string,objectId:string,context:{customerId?:string;employeeId?:string;businessDate:string;reason?:string}){
    await appendAuditEvent(this.tx,{actor:context.employeeId?{type:'employee',employeeId:context.employeeId}:{type:'guest',ref:`customer:${context.customerId}`},businessDate:context.businessDate,action:`marketing.${action}`,objectType:'marketing_authority',objectId,reason:context.reason,afterData:{operation:action}})
  }
  async list(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'marketing.notice.view');if(cursor)id(cursor)
    const rows=(await this.tx.query<{id:string}>('SELECT id FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21',[...this.scope,cursor])).rows
    const items=[];for(const row of rows.slice(0,20))items.push(await this.find(row.id))
    return{items,nextCursor:rows.length>20?items.at(-1)!.id:null}
  }
  async customers(employeeId:string,permission:'marketing.send'|'marketing.refusal.record'|'marketing.consent.audit',search:string,cursor:string|null=null){
    if(!['marketing.send','marketing.refusal.record','marketing.consent.audit'].includes(permission))throw new MarketingContactError('客户查找用途无效')
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,permission)
    if(typeof search!=='string'||search.trim().length<2||search.length>80)throw new MarketingContactError('请输入至少2字的会员号或客户编号')
    if(cursor)id(cursor)
    const pattern=`%${search.trim().replace(/[\\%_]/g,'\\$&')}%`
    const rows=(await this.tx.query<{id:string;name:string;code:string}>(`SELECT c.id,COALESCE(m.member_no,c.public_id) AS name,c.public_id AS code FROM mbox.customers c LEFT JOIN LATERAL(SELECT member_no FROM mbox.customer_memberships WHERE tenant_id=c.tenant_id AND store_id=c.store_id AND customer_id=c.id ORDER BY joined_at DESC,id DESC LIMIT 1)m ON true WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.merged_into_customer_id IS NULL AND (m.member_no ILIKE $3 OR c.public_id ILIKE $3) AND ($4::uuid IS NULL OR c.id>$4) ORDER BY c.id LIMIT 51`,[...this.scope,pattern,cursor])).rows
    return{items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null}
  }
  async find(noticeId:string):Promise<Notice>{
    id(noticeId)
    const row=(await this.tx.query<Record<string,unknown>>('SELECT * FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,noticeId])).rows[0]
    if(!row)throw new MarketingContactError('告知版本不存在或不属于本店')
    const decisions=(await this.tx.query<{action:string;employee_id:string}>('SELECT action,employee_id FROM mbox.marketing_notice_decisions WHERE tenant_id=$1 AND store_id=$2 AND notice_id=$3',[...this.scope,noticeId])).rows
    return{...row,id:String(row.id),code:String(row.code),version:Number(row.version),created_by_employee_id:String(row.created_by_employee_id),status:decisions.some(d=>d.action==='stop')?'stopped':decisions.some(d=>d.action==='publish')?'published':decisions.some(d=>d.action==='approve')?'approved':'draft',decisions,
      rule:parseMarketingNotice({operatorName:row.operator_name,operatorContact:row.operator_contact,summary:row.summary,withdrawalInstructions:row.withdrawal_instructions,purposes:row.purposes,channels:row.channels,dataCategories:row.data_categories,validFrom:new Date(row.valid_from as string).toISOString(),validUntil:new Date(row.valid_until as string).toISOString(),consentDays:row.consent_days,contactStartMinute:row.contact_start_minute,contactEndMinute:row.contact_end_minute,weekdays:row.weekdays,maximumPerDay:row.maximum_per_day,maximumPerMonth:row.maximum_per_month,sharingMode:row.sharing_mode})}
  }
  async consentHistory(input:{employeeId:string;customerId:string;businessDate:string;reason:string;cursor?:string|null}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'marketing.consent.audit')
    reason(input.reason)
    const cursor=input.cursor??null
    if(cursor!==null&&(typeof cursor!=='string'||!/^[1-9][0-9]{0,18}$/.test(cursor)||BigInt(cursor)>9223372036854775807n))throw new MarketingContactError('历史分页位置无效')
    const customerId=await this.identity(input.customerId)
    const rows=(await this.tx.query<{id:string;sequence:string;action:string;channel:string|null;purpose:string|null;validUntil:string|null;createdAt:string;source:string;actorName:string|null;reason:string|null;notice:Record<string,unknown>|null}>(`
      WITH RECURSIVE family(id) AS (
        SELECT id FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3
        UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2
      )
      SELECT e.id,e.sequence::text,e.action,e.channel,e.purpose,e.valid_until::text AS "validUntil",
        e.created_at::text AS "createdAt",e.source,employee.display_name AS "actorName",e.reason,
        CASE WHEN n.id IS NULL THEN NULL ELSE jsonb_build_object('id',n.id,'code',n.code,'version',n.version,
          'operatorName',n.operator_name,'summary',n.summary,'withdrawalInstructions',n.withdrawal_instructions,
          'channels',n.channels,'purposes',n.purposes,'dataCategories',n.data_categories,
          'validFrom',n.valid_from,'validUntil',n.valid_until,'consentDays',n.consent_days,'sharingMode',n.sharing_mode) END AS notice
      FROM mbox.marketing_consent_events e
      LEFT JOIN mbox.marketing_notice_versions n ON n.tenant_id=e.tenant_id AND n.store_id=e.store_id AND n.id=e.notice_id
      LEFT JOIN mbox.employees employee ON employee.tenant_id=e.tenant_id AND employee.store_id=e.store_id AND employee.id=e.actor_employee_id
      WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id IN(SELECT id FROM family)
        AND ($4::bigint IS NULL OR e.sequence<$4::bigint)
      ORDER BY e.sequence DESC LIMIT 51
    `,[...this.scope,customerId,cursor])).rows
    await this.audit('consent_history_viewed',customerId,{...input,customerId,reason:input.reason.trim()})
    return{customerId,items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.sequence:null}
  }
  async save(input:{code:string;rule:unknown;employeeId:string;businessDate:string;reason:string;requestKey:string;expectedVersion:number}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'marketing.notice.edit');reason(input.reason)
    if(!/^[A-Z][A-Z0-9_]{1,39}$/.test(input.code)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion>=2147483647||!/^[A-Za-z0-9:_-]{8,128}$/.test(input.requestKey))throw new MarketingContactError('告知编号、版本或请求编号无效')
    const rule=parseMarketingNotice(input.rule),fingerprint=createHash('sha256').update(JSON.stringify({...input,rule,requestKey:undefined})).digest('hex')
    await this.lock('notices')
    const old=(await this.tx.query<{id:string;request_fingerprint:string}>('SELECT id,request_fingerprint FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND request_key=$3',[...this.scope,input.requestKey])).rows[0]
    if(old){if(old.request_fingerprint!==fingerprint)throw new MarketingContactError('相同请求的告知内容已变化');return{noticeId:old.id,replayed:true}}
    const current=(await this.tx.query<{version:number}>('SELECT COALESCE(max(version),0) AS version FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3',[...this.scope,input.code])).rows[0]!.version
    if(current!==input.expectedVersion)throw new MarketingContactError('已有新版本，请重新读取')
    const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.marketing_notice_versions(tenant_id,store_id,code,version,operator_name,operator_contact,summary,withdrawal_instructions,purposes,channels,data_categories,valid_from,valid_until,consent_days,contact_start_minute,contact_end_minute,weekdays,maximum_per_day,maximum_per_month,sharing_mode,created_by_employee_id,reason,request_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,[...this.scope,input.code,current+1,rule.operatorName,rule.operatorContact,rule.summary,rule.withdrawalInstructions,rule.purposes,rule.channels,rule.dataCategories,rule.validFrom,rule.validUntil,rule.consentDays,rule.contactStartMinute,rule.contactEndMinute,rule.weekdays,rule.maximumPerDay,rule.maximumPerMonth,rule.sharingMode,input.employeeId,input.reason.trim(),input.requestKey,fingerprint])).rows[0]!
    await this.audit('notice_saved',row.id,input);return{noticeId:row.id,replayed:false}
  }
  async decide(input:{noticeId:string;action:'approve'|'publish'|'stop';employeeId:string;businessDate:string;reason:string}){
    if(!['approve','publish','stop'].includes(input.action))throw new MarketingContactError('告知操作无效')
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,input.action==='approve'?'marketing.notice.approve':'marketing.notice.publish');reason(input.reason)
    await this.lock('notices');const notice=await this.find(input.noticeId)
    if(notice.decisions.some(d=>d.action===input.action))return{noticeId:notice.id,status:notice.status,replayed:true}
    if(notice.status!=={approve:'draft',publish:'approved',stop:'published'}[input.action])throw new MarketingContactError('当前告知状态不支持此操作')
    if(input.action!=='stop'){
      if(notice.created_by_employee_id===input.employeeId||(input.action==='publish'&&notice.decisions.some(d=>d.action==='approve'&&d.employee_id===input.employeeId)))throw new MarketingContactError('编辑、审核、发布须由不同授权人员完成')
      if(Date.parse(notice.rule.validUntil)<=Date.now())throw new MarketingContactError('告知已经过期')
    }
    await this.tx.query('INSERT INTO mbox.marketing_notice_decisions(tenant_id,store_id,notice_id,action,employee_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[...this.scope,notice.id,input.action,input.employeeId,input.reason.trim()])
    await this.audit(`notice_${input.action}`,notice.id,input)
    return{noticeId:notice.id,status:{approve:'approved',publish:'published',stop:'stopped'}[input.action],replayed:false}
  }
  private async events(customerId:string){
    // Latest event for each scope plus stop-all, bounded to seven rows. A
    // merged identity retains original evidence; sequence resolves ordering.
    return(await this.tx.query<ConsentEvent>(`WITH RECURSIVE family(id) AS(SELECT $3::uuid UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2) SELECT * FROM(SELECT DISTINCT ON(e.channel,e.purpose) e.id,e.sequence::text,e.action,e.channel,e.purpose,e.notice_id,e.valid_until::text,e.created_at::text FROM mbox.marketing_consent_events e WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.customer_id IN(SELECT id FROM family) ORDER BY e.channel,e.purpose,e.sequence DESC) latest ORDER BY sequence::bigint DESC`,[...this.scope,customerId])).rows
  }
  async selfView(customerId:string){
    id(customerId);const canonical=(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id,events=await this.events(canonical)
    const stop=events.find(e=>e.action==='stop_all'),now=Number((await this.tx.query<{now:string}>('SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0]!.now)
    const rows=(await this.tx.query<{id:string}>(`SELECT v.id FROM mbox.marketing_notice_versions v WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.valid_from<=clock_timestamp() AND v.valid_until>clock_timestamp() AND EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.notice_id=v.id AND d.action='publish') AND NOT EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.notice_id=v.id AND d.action='stop') ORDER BY v.created_at DESC,v.id DESC LIMIT 21`,this.scope)).rows
    if(rows.length>20)throw new MarketingContactError('可用告知版本过多，请联系门店整理；仍可停止全部营销')
    const notices:Array<{id:string;code:string;version:number;rule:MarketingNotice}>=[];for(const row of rows){const notice=await this.find(row.id);notices.push({id:notice.id,code:notice.code,version:notice.version,rule:notice.rule})}
    const decisions=marketingChannels.flatMap(channel=>marketingPurposes.map(purpose=>{
      const event=events.find(e=>e.channel===channel&&e.purpose===purpose)
      const granted=!!event&&event.action==='granted'&&(!stop||BigInt(event.sequence)>BigInt(stop.sequence))&&!!event.valid_until&&Date.parse(event.valid_until)>now&&notices.some(n=>n.id===event.notice_id)
      return{channel,purpose,decision:granted?'granted':event?.action==='denied'?'denied':'not_granted',noticeId:granted?event!.notice_id:null,validUntil:granted?event!.valid_until:null}
    }))
    return{revision:events[0]?.id??'none',notices,decisions,stoppedAll:!!stop&&!decisions.some(d=>d.decision==='granted'),
      // Account capability is not inferred from a local preference. Outbound
      // adapters must provide verified readiness before these can be opened.
      channels:marketingChannels.map(channel=>({channel,ready:false,status:'not_configured'}))}
  }
  async recordChoices(input:{customerId:string;noticeId:string;expectedRevision:string;choices:Array<{channel:MarketingChannel;purpose:MarketingPurpose;decision:'granted'|'withdrawn'|'denied'}>;businessDate:string}){
    const customerId=await this.identity(input.customerId),events=await this.events(customerId)
    if(input.expectedRevision!==(events[0]?.id??'none'))throw new MarketingContactError('联系偏好已变化，请重新读取后选择；旧页面不会恢复已撤回许可')
    if(!Array.isArray(input.choices)||!input.choices.length||input.choices.length>6||new Set(input.choices.map(c=>`${c.channel}:${c.purpose}`)).size!==input.choices.length)throw new MarketingContactError('本次渠道选择无效或重复')
    const notice=await this.find(input.noticeId)
    const now=Number((await this.tx.query<{now:string}>('SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0]!.now)
    for(const choice of input.choices){
      if(!marketingChannels.includes(choice.channel)||!marketingPurposes.includes(choice.purpose)||!['granted','withdrawn','denied'].includes(choice.decision))throw new MarketingContactError('渠道、用途或决定无效')
      if(choice.decision==='granted'&&(notice.status!=='published'||now<Date.parse(notice.rule.validFrom)||now>=Date.parse(notice.rule.validUntil)||!notice.rule.channels.includes(choice.channel)||!notice.rule.purposes.includes(choice.purpose)))throw new MarketingContactError('告知未开放或不覆盖本次选择')
      await this.tx.query(`INSERT INTO mbox.marketing_consent_events(tenant_id,store_id,customer_id,action,channel,purpose,notice_id,valid_until,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4='granted' THEN LEAST($8::timestamptz,clock_timestamp()+($9::int*interval '1 day')) ELSE NULL END,'customer_self')`,[...this.scope,customerId,choice.decision,choice.channel,choice.purpose,notice.id,notice.rule.validUntil,notice.rule.consentDays])
    }
    await this.audit('choices_recorded',customerId,{...input,customerId})
    return this.selfView(customerId)
  }
  /** Internal execution facts under the same non-blocking identity/customer
   * lock used by withdrawal. Never expose this as a client-writable proof. */
  async executionAuthority(customerId:string,noticeId:string,channel:MarketingChannel,purpose:MarketingPurpose){
    const canonical=await this.identity(customerId),notice=await this.find(noticeId),events=await this.events(canonical)
    const event=events.find(e=>e.channel===channel&&e.purpose===purpose),stop=events.find(e=>e.action==='stop_all')
    const now=new Date((await this.tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)
    return{customerId:canonical,notice,now,consent:event&&event.action!=='stop_all'?{consentId:event.id,noticeId:event.notice_id??'',decision:event.action,validUntil:event.valid_until??'',afterLatestStop:!stop||BigInt(event.sequence)>BigInt(stop.sequence)}:null}
  }
  async stopAll(input:{customerId:string;businessDate:string;employeeId?:string;reason?:string}){
    if(input.employeeId){await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'marketing.refusal.record');reason(input.reason??'')}
    const customerId=await this.identity(input.customerId)
    await this.tx.query("INSERT INTO mbox.marketing_consent_events(tenant_id,store_id,customer_id,action,source,actor_employee_id,reason) VALUES($1,$2,$3,'stop_all',$4,$5,$6)",[...this.scope,customerId,input.employeeId?'staff_recorded_refusal':'customer_self',input.employeeId??null,input.reason??null])
    await this.audit('stop_all',customerId,{...input,customerId})
    return{stopped:true,customerId}
  }
  async withdrawChannel(input:{customerId:string;channel:MarketingChannel;businessDate:string}){
    if(!marketingChannels.includes(input.channel))throw new MarketingContactError('联系渠道无效')
    const customerId=await this.identity(input.customerId)
    for(const purpose of marketingPurposes)await this.tx.query("INSERT INTO mbox.marketing_consent_events(tenant_id,store_id,customer_id,action,channel,purpose,source) VALUES($1,$2,$3,'withdrawn',$4,$5,'customer_self')",[...this.scope,customerId,input.channel,purpose])
    await this.audit('channel_withdrawn',customerId,{...input,customerId})
    return{stopped:true,channel:input.channel}
  }
}
