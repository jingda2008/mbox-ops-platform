import type { ScopedTransaction } from './transaction-runner.js'
import { CustomerRepository } from './customer-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { appendAuditEvent } from './command-executor.js'
import { assertCardProjectOpen, decideCardApplication, transitionMemberCard, MemberCardPolicyError,
  type CardProjectEligibility, type CardApplicationState, type MemberCardState } from './member-card-policy.js'

interface ProjectRow extends Record<string,unknown> {
  id:string;code:string;name:string;terms:string;kind:'interest'|'cobrand';status:CardProjectEligibility['state'];version:number
  available_from:string;available_until:string;cooperation_confirmed:boolean;cooperation_valid_until:string|null;created_by_employee_id:string
}
interface ApplicationRow extends Record<string,unknown> {id:string;project_id:string;customer_id:string;status:CardApplicationState;accepted_project_version:number}
const projectColumns='id,code,name,terms,kind,status,version,available_from::text,available_until::text,cooperation_confirmed,cooperation_valid_until::text,created_by_employee_id'
function uuid(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new MemberCardPolicyError('记录编号不正确')}
function text(value:string,label:string,max:number){if(typeof value!=='string'||value.trim().length<2||value.length>max)throw new MemberCardPolicyError(`${label}须为2至${max}字`);return value.trim()}
function eligibility(row:ProjectRow):CardProjectEligibility{return{state:row.status,kind:row.kind,availableFrom:new Date(row.available_from).toISOString(),availableUntil:new Date(row.available_until).toISOString(),cooperationConfirmed:row.cooperation_confirmed,cooperationValidUntil:row.cooperation_valid_until?new Date(row.cooperation_valid_until).toISOString():null}}
export class MemberCardRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
  private async identity(customerId:string){
    uuid(customerId)
    const guard=await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[`table-customer-movement:${this.scope.join(':')}`])
    if(!guard.rows[0]?.locked)throw new MemberCardPolicyError('客户身份正在同步，请稍后重试；不影响点单和收款')
    return(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id
  }
  private async project(projectId:string){uuid(projectId);const result=await this.tx.query<ProjectRow>(`SELECT ${projectColumns} FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,projectId]);if(!result.rows[0])throw new MemberCardPolicyError('卡项目不存在');return result.rows[0]}
  private async member(customerId:string){
    const result=await this.tx.query<{status:string}>(`SELECT status FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2
      AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$3 ORDER BY (customer_id=$3) DESC,joined_at DESC,id LIMIT 1`,[...this.scope,customerId])
    return result.rows[0]?.status==='active'
  }
  private async now(){return new Date((await this.tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)}
  private async audit(action:string,objectId:string,input:{customerId?:string;employeeId?:string;businessDate:string;reason?:string}){
    await appendAuditEvent(this.tx,{actor:input.employeeId?{type:'employee',employeeId:input.employeeId}:{type:'guest',ref:`customer:${input.customerId}`},
      businessDate:input.businessDate,action:`member_card.${action}`,objectType:'member_card',objectId,reason:input.reason,
      afterData:{operation:action,customerId:input.customerId??null}})
  }
  async createProject(input:{code:string;name:string;terms:string;kind:'interest'|'cobrand';availableFrom:string;availableUntil:string;cooperationConfirmed:boolean;cooperationValidUntil:string|null;cooperationReference:string|null;employeeId:string;businessDate:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'member.card.manage')
    if(typeof input.code!=='string'||!/^[A-Z][A-Z0-9_]{1,39}$/.test(input.code)||!['interest','cobrand'].includes(input.kind)||typeof input.cooperationConfirmed!=='boolean')throw new MemberCardPolicyError('卡项目定义不正确')
    const name=text(input.name,'名称',60),terms=text(input.terms,'申请条款',6000)
    const now=await this.now()
    // Validate absolute dates independently of publication; future projects are
    // valid drafts and do not issue anything when saved.
    for(const date of [input.availableFrom,input.availableUntil,...(input.cooperationValidUntil?[input.cooperationValidUntil]:[])])if(typeof date!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(date)||!Number.isFinite(Date.parse(date)))throw new MemberCardPolicyError('卡项目时间须包含明确时区')
    if(Date.parse(input.availableUntil)<=Math.max(Date.parse(input.availableFrom),now.getTime()))throw new MemberCardPolicyError('卡项目须有未来有效期')
    if(input.kind==='cobrand'&&(!input.cooperationReference||input.cooperationReference.trim().length<2))throw new MemberCardPolicyError('联名项目须记录合作依据；未确认不能开放')
    const result=await this.tx.query<{id:string}>(`INSERT INTO mbox.member_card_projects(tenant_id,store_id,code,name,terms,kind,available_from,available_until,cooperation_confirmed,cooperation_valid_until,cooperation_reference,created_by_employee_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[...this.scope,input.code,name,terms,input.kind,input.availableFrom,input.availableUntil,input.cooperationConfirmed,input.cooperationValidUntil,input.cooperationReference,input.employeeId])
    await this.audit('project_created',result.rows[0]!.id,input)
    return{projectId:result.rows[0]!.id,status:'draft' as const}
  }
  async setProjectState(input:{projectId:string;state:'open'|'paused'|'closed';employeeId:string;businessDate:string;reason:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,input.state==='open'?'loyalty.policy.publish':'member.card.manage')
    if(!['open','paused','closed'].includes(input.state))throw new MemberCardPolicyError('项目状态不正确')
    text(input.reason,'原因',300)
    const project=await this.project(input.projectId)
    if(project.status===input.state)return{projectId:project.id,status:project.status}
    if(project.status==='closed')throw new MemberCardPolicyError('已关闭项目不能重新发卡，请新建项目')
    if(input.state==='open'){
      if(project.created_by_employee_id===input.employeeId)throw new MemberCardPolicyError('卡项目创建人不能自行开放本人项目')
      const now=await this.now(),rule=eligibility(project)
      assertCardProjectOpen({...rule,state:'open'},new Date(Math.max(now.getTime(),Date.parse(rule.availableFrom))))
    }
    await this.tx.query('UPDATE mbox.member_card_projects SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,project.id,input.state])
    await this.audit(`project_${input.state}`,project.id,input)
    return{projectId:project.id,status:input.state}
  }
  async apply(input:{projectId:string;customerId:string;acceptedProjectVersion:number;businessDate:string}){
    const customerId=await this.identity(input.customerId),project=await this.project(input.projectId)
    assertCardProjectOpen(eligibility(project),await this.now())
    if(!await this.member(customerId))throw new MemberCardPolicyError('请先完成正常会员入会；不要求同意额外营销')
    if(input.acceptedProjectVersion!==project.version)throw new MemberCardPolicyError('请阅读当前卡项目说明后再申请')
    const existing=await this.tx.query<ApplicationRow>(`SELECT id,project_id,customer_id,status,accepted_project_version FROM mbox.member_card_applications
      WHERE tenant_id=$1 AND store_id=$2 AND project_id=$3 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$4 AND status='pending' ORDER BY requested_at,id LIMIT 1`,[...this.scope,project.id,customerId])
    if(existing.rows[0])return{applicationId:existing.rows[0].id,status:'pending' as const,replayed:true}
    if(await this.currentCard(project.id,customerId))throw new MemberCardPolicyError('已有此卡，请查看持卡状态，不需重复申请')
    const row=await this.tx.query<{id:string}>(`INSERT INTO mbox.member_card_applications(tenant_id,store_id,project_id,customer_id,accepted_project_version) VALUES($1,$2,$3,$4,$5) RETURNING id`,[...this.scope,project.id,customerId,project.version])
    await this.audit('applied',row.rows[0]!.id,{...input,customerId})
    return{applicationId:row.rows[0]!.id,status:'pending' as const,replayed:false}
  }
  private async currentCard(projectId:string,customerId:string){return(await this.tx.query<{id:string;status:MemberCardState}>(`SELECT id,status FROM mbox.member_cards WHERE tenant_id=$1 AND store_id=$2 AND project_id=$3
    AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$4 AND status IN('active','suspended') AND valid_until>clock_timestamp() ORDER BY created_at,id LIMIT 1`,[...this.scope,projectId,customerId])).rows[0]}
  async review(input:{applicationId:string;decision:'approve'|'reject';employeeId:string;businessDate:string;reason:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'member.card.review')
    if(!['approve','reject'].includes(input.decision))throw new MemberCardPolicyError('审核结果不正确')
    uuid(input.applicationId);text(input.reason,'审核原因',300)
    const found=await this.tx.query<ApplicationRow>('SELECT id,project_id,customer_id,status,accepted_project_version FROM mbox.member_card_applications WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,input.applicationId])
    if(!found.rows[0])throw new MemberCardPolicyError('申请不存在')
    const customerId=await this.identity(found.rows[0].customer_id),project=await this.project(found.rows[0].project_id)
    const application=(await this.tx.query<ApplicationRow>('SELECT id,project_id,customer_id,status,accepted_project_version FROM mbox.member_card_applications WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,input.applicationId])).rows[0]!
    const expected=input.decision==='approve'?'approved':'rejected'
    if(application.status===expected)return{applicationId:application.id,status:application.status,cardId:(await this.currentCard(project.id,customerId))?.id??null,replayed:true}
    const card=await this.currentCard(project.id,customerId)
    const result=decideCardApplication({state:application.status,decision:input.decision,reviewerAuthorized:true,project:eligibility(project),now:await this.now(),activeMember:await this.member(customerId),alreadyHoldsCard:!!card})
    let cardId=card?.id??null
    if(result.createCard){
      const issued=await this.tx.query<{id:string}>('INSERT INTO mbox.member_cards(tenant_id,store_id,project_id,customer_id,application_id,valid_until) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[...this.scope,project.id,customerId,application.id,project.available_until]);cardId=issued.rows[0]!.id
    }
    await this.tx.query('UPDATE mbox.member_card_applications SET status=$4,reviewed_by_employee_id=$5,review_reason=$6,resolved_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,application.id,result.applicationState,input.employeeId,input.reason.trim()])
    await this.audit(`application_${result.applicationState}`,application.id,input)
    return{applicationId:application.id,status:result.applicationState,cardId,replayed:false}
  }
  async changeCard(input:{cardId:string;action:'suspend'|'resume'|'withdraw'|'revoke';customerId?:string;employeeId?:string;businessDate:string;reason:string}){
    uuid(input.cardId);text(input.reason,'原因',300)
    if(input.action!=='withdraw'||!input.customerId){if(!input.employeeId)throw new MemberCardPolicyError('缺少持卡管理权限');await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'member.card.manage')}
    const row=(await this.tx.query<{id:string;customer_id:string;project_id:string;status:MemberCardState;valid_until:string}>('SELECT id,customer_id,project_id,status,valid_until::text FROM mbox.member_cards WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,input.cardId])).rows[0]
    if(!row)throw new MemberCardPolicyError('持卡记录不存在')
    const canonical=await this.identity(row.customer_id)
    if(input.customerId&&(await new CustomerRepository(this.tx).resolveCanonical(input.customerId)).id!==canonical)throw new MemberCardPolicyError('不能修改其他客户的卡')
    await this.project(row.project_id)
    const current=(await this.tx.query<{status:MemberCardState}>('SELECT status FROM mbox.member_cards WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,row.id])).rows[0]!
    const status=transitionMemberCard(current.status,input.action)
    if(input.action==='resume'&&new Date(row.valid_until).getTime()<=(await this.now()).getTime())throw new MemberCardPolicyError('已到期卡不能恢复')
    await this.tx.query('UPDATE mbox.member_cards SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,row.id,status])
    await this.audit(input.action,row.id,input)
    return{cardId:row.id,status}
  }
  async withdrawApplication(input:{applicationId:string;customerId:string;businessDate:string}){
    uuid(input.applicationId)
    const customerId=await this.identity(input.customerId)
    const original=(await this.tx.query<ApplicationRow>('SELECT id,project_id,customer_id,status,accepted_project_version FROM mbox.member_card_applications WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,input.applicationId])).rows[0]
    if(!original||(await new CustomerRepository(this.tx).resolveCanonical(original.customer_id)).id!==customerId)throw new MemberCardPolicyError('申请不存在或不属于本人')
    await this.project(original.project_id)
    const current=(await this.tx.query<{status:CardApplicationState}>('SELECT status FROM mbox.member_card_applications WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,input.applicationId])).rows[0]!
    if(current.status==='withdrawn')return{applicationId:input.applicationId,status:'withdrawn' as const}
    if(current.status!=='pending')throw new MemberCardPolicyError('申请已处理；已持卡请使用退出卡片入口')
    await this.tx.query("UPDATE mbox.member_card_applications SET status='withdrawn',resolved_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,input.applicationId])
    await this.audit('application_withdrawn',input.applicationId,{...input,customerId})
    return{applicationId:input.applicationId,status:'withdrawn' as const}
  }
  async selfView(customerId:string,cursors:Partial<Record<'projects'|'cards'|'applications',string>>={}){
    for(const cursor of Object.values(cursors))uuid(cursor)
    uuid(customerId);const canonical=(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id
    const projects=await this.tx.query<{id:string}>(`SELECT p.id,p.code,p.name,p.kind,p.terms,p.version,p.available_from,p.available_until,
      (p.available_from<=clock_timestamp() AND (p.kind='interest' OR (p.cooperation_confirmed AND p.cooperation_valid_until>clock_timestamp()))) AS accepting_applications,
      EXISTS(SELECT 1 FROM mbox.member_cards c WHERE c.tenant_id=p.tenant_id AND c.store_id=p.store_id AND c.project_id=p.id AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=$3 AND c.status IN('active','suspended') AND c.valid_until>clock_timestamp()) AS has_current_card,
      EXISTS(SELECT 1 FROM mbox.member_card_applications a WHERE a.tenant_id=p.tenant_id AND a.store_id=p.store_id AND a.project_id=p.id AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=$3 AND a.status='pending') AS has_pending_application
      FROM mbox.member_card_projects p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.status='open' AND p.available_until>clock_timestamp() AND ($4::uuid IS NULL OR p.id>$4::uuid) ORDER BY p.id LIMIT 51`,[...this.scope,canonical,cursors.projects??null])
    const cards=await this.tx.query<{id:string}>(`SELECT c.id,c.project_id,p.name,p.kind,c.status,c.valid_from,c.valid_until,(c.valid_until<=clock_timestamp()) AS expired
      FROM mbox.member_cards c JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id
      WHERE c.tenant_id=$1 AND c.store_id=$2 AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=$3 AND ($4::uuid IS NULL OR c.id>$4::uuid) ORDER BY c.id LIMIT 51`,[...this.scope,canonical,cursors.cards??null])
    const applications=await this.tx.query<{id:string}>(`SELECT a.id,a.project_id,p.name,a.status,a.requested_at,a.resolved_at,a.review_reason
      FROM mbox.member_card_applications a JOIN mbox.member_card_projects p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.id=a.project_id
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=$3 AND ($4::uuid IS NULL OR a.id>$4::uuid) ORDER BY a.id LIMIT 51`,[...this.scope,canonical,cursors.applications??null])
    return{projects:projects.rows.slice(0,50),cards:cards.rows.slice(0,50),applications:applications.rows.slice(0,50),activeMember:await this.member(canonical),
      nextCursors:{projects:projects.rows.length>50?projects.rows[49]!.id:null,cards:cards.rows.length>50?cards.rows[49]!.id:null,applications:applications.rows.length>50?applications.rows[49]!.id:null}}
  }
  async reviewQueue(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'member.card.review')
    if(cursor!==null)uuid(cursor)
    const result=await this.tx.query<{id:string}>(`SELECT a.id,a.project_id,p.name AS project_name,a.status,a.requested_at,c.public_id AS customer_reference,
      membership.member_no,membership.level AS member_level
      FROM mbox.member_card_applications a JOIN mbox.member_card_projects p ON p.tenant_id=a.tenant_id AND p.store_id=a.store_id AND p.id=a.project_id
      JOIN mbox.customers c ON c.tenant_id=a.tenant_id AND c.store_id=a.store_id AND c.id=a.customer_id
      LEFT JOIN LATERAL(SELECT m.member_no,m.level FROM mbox.customer_memberships m WHERE m.tenant_id=a.tenant_id AND m.store_id=a.store_id
        AND mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)=mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)
        ORDER BY (m.customer_id=mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)) DESC,m.joined_at DESC LIMIT 1) membership ON true
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.status='pending' AND ($3::uuid IS NULL OR a.id>$3::uuid) ORDER BY a.id LIMIT 51`,[...this.scope,cursor])
    return{items:result.rows.slice(0,50),nextCursor:result.rows.length>50?result.rows[49]!.id:null}
  }
  async projects(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'member.card.manage')
    if(cursor!==null)uuid(cursor)
    const result=await this.tx.query<{id:string}>(`SELECT ${projectColumns} FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 51`,[...this.scope,cursor])
    return{items:result.rows.slice(0,50),nextCursor:result.rows.length>50?result.rows[49]!.id:null}
  }
  async holdings(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'member.card.manage')
    if(cursor!==null)uuid(cursor)
    const result=await this.tx.query<{id:string}>(`SELECT c.id,c.project_id,p.name AS project_name,c.status,c.valid_until,
      (c.valid_until<=clock_timestamp()) AS expired,customer.public_id AS customer_reference
      FROM mbox.member_cards c JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id
      JOIN mbox.customers customer ON customer.tenant_id=c.tenant_id AND customer.store_id=c.store_id AND customer.id=c.customer_id
      WHERE c.tenant_id=$1 AND c.store_id=$2 AND ($3::uuid IS NULL OR c.id>$3::uuid) ORDER BY c.id LIMIT 51`,[...this.scope,cursor])
    return{items:result.rows.slice(0,50),nextCursor:result.rows.length>50?result.rows[49]!.id:null}
  }
}
