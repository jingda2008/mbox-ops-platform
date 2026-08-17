import { useCallback,useEffect,useState,type FormEvent } from 'react'
import { ChevronDown,RefreshCw,ShieldCheck } from 'lucide-react'
import type { NormalizedApiClient,StaffAuthView } from '../normalized-api'
import './personal-contact-governance-panel.css'

type ResourceKind='activity_registration_contact'|'verified_membership_phone'
interface Policy {publicId:string;resourceKind:ResourceKind;version:number;status:string;retentionDaysAfterPurposeEnd:number;legalBasisReference:string;draftedBy:string;approvedBy:string|null;publishedBy:string|null;effectiveFrom:string|null;effectiveUntil:string|null}
interface Hold {publicId:string;resourceKind:ResourceKind;resourcePublicId:string;maskedContact:string;status:'active'|'released';legalBasisReference:string;reason:string;createdBy:string;createdAt:string;holdUntil:string|null;releasedBy:string|null;releaseReason:string|null;releasedAt:string|null}
interface Disposition {resourcePublicId:string;resourceKind:ResourceKind;maskedContact:string;policyPublicId:string;policyVersion:number;dispositionMethod:string;purposeEndedAt:string;disposedAt:string}
interface EligibleResource {publicId:string;resourceKind:ResourceKind;maskedContact:string;businessLabel:string;status:string}

export function PersonalContactGovernancePanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const canView=auth.permissions.includes('privacy.contact.retention.view')
  const canDraft=auth.permissions.includes('privacy.contact.retention.draft')
  const canApprove=auth.permissions.includes('privacy.contact.retention.approve')
  const canPublish=auth.permissions.includes('privacy.contact.retention.publish')
  const canHold=auth.permissions.includes('privacy.contact.legal_hold')
  const [expanded,setExpanded]=useState(false)
  const [policies,setPolicies]=useState<Policy[]>([])
  const [holds,setHolds]=useState<Hold[]>([])
  const [dispositions,setDispositions]=useState<Disposition[]>([])
  const [eligibleResources,setEligibleResources]=useState<EligibleResource[]>([])
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')
  const [policyForm,setPolicyForm]=useState({resourceKind:'activity_registration_contact' as ResourceKind,days:'30',basis:'',reason:''})
  const [holdForm,setHoldForm]=useState({resourceKind:'activity_registration_contact' as ResourceKind,resourcePublicId:'',basis:'',reason:'',holdUntil:''})

  const load=useCallback(async()=>{
    setBusy('load');setNotice('')
    try{
      const [policyResponse,evidenceResponse]=await Promise.all([
        api.getEndpoint<{data:unknown}>('/api/staff/personal-contact-governance/policies'),
        api.getEndpoint<{data:unknown}>('/api/staff/personal-contact-governance/evidence'),
      ])
      setPolicies(policyList(policyResponse.data))
      const evidence=evidenceView(evidenceResponse.data)
      setHolds(evidence.holds);setDispositions(evidence.dispositions);setEligibleResources(evidence.eligibleResources)
    }catch(error){setNotice(message(error,'联系方式治理信息读取失败'))}
    finally{setBusy('')}
  },[api])

  useEffect(()=>{if(expanded) void load()},[expanded,load])
  if(!canView)return null

  async function draft(event:FormEvent){
    event.preventDefault();setBusy('draft');setNotice('')
    try{
      await api.postEndpoint('/api/staff/personal-contact-governance/policies',{
        resourceKind:policyForm.resourceKind,
        retentionDaysAfterPurposeEnd:integer(policyForm.days,'保留天数'),
        legalBasisReference:policyForm.basis.trim(),reason:policyForm.reason.trim(),
      })
      setPolicyForm((value)=>({...value,basis:'',reason:''}));setNotice('保留策略草稿已建立，须由另一人审批、第三人发布。');await load()
    }catch(error){setNotice(message(error,'策略草稿未保存'))}finally{setBusy('')}
  }

  async function transition(policy:Policy,action:'approve'|'publish'){
    const reason=window.prompt(action==='approve'?'请输入独立审批意见':'请输入发布说明')?.trim()
    if(!reason||reason.length<2)return
    setBusy(`${policy.publicId}:${action}`);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/personal-contact-governance/policies/${encodeURIComponent(policy.publicId)}/${action}`,
        action==='approve'?{reason}:{reason,effectiveFrom:new Date().toISOString()})
      setNotice(action==='approve'?'已审批，等待第三人发布。':'策略已发布；不会自动修改法定期限，仍按门店核准内容执行。');await load()
    }catch(error){setNotice(message(error,action==='approve'?'策略未能审批':'策略未能发布'))}finally{setBusy('')}
  }

  async function createHold(event:FormEvent){
    event.preventDefault();setBusy('hold');setNotice('')
    try{
      await api.postEndpoint('/api/staff/personal-contact-governance/legal-holds',{
        resourceKind:holdForm.resourceKind,resourcePublicId:holdForm.resourcePublicId.trim(),
        legalBasisReference:holdForm.basis.trim(),reason:holdForm.reason.trim(),
        holdUntil:holdForm.holdUntil?new Date(holdForm.holdUntil).toISOString():null,
      })
      setHoldForm((value)=>({...value,resourcePublicId:'',basis:'',reason:'',holdUntil:''}));setNotice('已建立法定保留；仅阻止旧版本清除，不影响顾客更正新联系方式。');await load()
    }catch(error){setNotice(message(error,'法定保留未能建立'))}finally{setBusy('')}
  }

  async function release(hold:Hold){
    const reason=window.prompt('请输入释放法定保留的依据或说明')?.trim()
    if(!reason||reason.length<2)return
    setBusy(`${hold.publicId}:release`);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/personal-contact-governance/legal-holds/${encodeURIComponent(hold.publicId)}/release`,{reason})
      setNotice('法定保留已释放；符合已发布期限的旧版本将由清除任务处理。');await load()
    }catch(error){setNotice(message(error,'法定保留未能释放'))}finally{setBusy('')}
  }

  return <section className="personal-contact-governance" aria-label="联系方式隐私治理">
    <header><div><ShieldCheck size={18}/><span><strong>联系方式隐私治理</strong><small>只显示掩码、策略和处置证据；密文、哈希与内部编号不在页面出现。</small></span></div><button type="button" aria-expanded={expanded} onClick={()=>setExpanded((value)=>!value)}>{expanded?'收起':'打开'}<ChevronDown size={17}/></button></header>
    {expanded&&<div className="personal-contact-governance-body">
      {notice&&<p role="status">{notice}</p>}
      <div className="personal-contact-governance-toolbar"><span>{policies.length} 个策略版本 · {holds.filter((hold)=>hold.status==='active').length} 个有效保留</span><button type="button" disabled={busy==='load'} onClick={()=>void load()}><RefreshCw size={16}/>刷新</button></div>
      {canDraft&&<details><summary>起草保留策略</summary><form onSubmit={(event)=>void draft(event)}><label>资源<select value={policyForm.resourceKind} onChange={(event)=>setPolicyForm({...policyForm,resourceKind:event.target.value as ResourceKind})}><option value="activity_registration_contact">活动报名联系</option><option value="verified_membership_phone">已验证会员手机号</option></select></label><label>目的结束后保留天数<input required inputMode="numeric" value={policyForm.days} onChange={(event)=>setPolicyForm({...policyForm,days:event.target.value})}/></label><label className="wide">依据<input required minLength={3} maxLength={500} value={policyForm.basis} onChange={(event)=>setPolicyForm({...policyForm,basis:event.target.value})}/></label><label className="wide">起草原因<input required minLength={2} maxLength={500} value={policyForm.reason} onChange={(event)=>setPolicyForm({...policyForm,reason:event.target.value})}/></label><button disabled={busy==='draft'}>保存草稿</button></form></details>}
      <section><header><strong>策略版本</strong><small>未来版本不会提前停用当前版本</small></header><div className="governance-list">{policies.map((policy)=><article key={policy.publicId}><div><strong>{resourceLabel(policy.resourceKind)} · 第{policy.version}版</strong><small>{policy.retentionDaysAfterPurposeEnd}天 · {policy.legalBasisReference}</small><small>起草 {policy.draftedBy}{policy.approvedBy?` · 审批 ${policy.approvedBy}`:''}{policy.publishedBy?` · 发布 ${policy.publishedBy}`:''}</small></div><span>{policyStatus(policy.status)}</span><div>{canApprove&&policy.status==='draft'&&<button onClick={()=>void transition(policy,'approve')}>独立审批</button>}{canPublish&&policy.status==='approved'&&<button onClick={()=>void transition(policy,'publish')}>第三人发布</button>}</div></article>)}</div></section>
      {canHold&&<details><summary>建立法定保留</summary><form onSubmit={(event)=>void createHold(event)}><label>资源<select value={holdForm.resourceKind} onChange={(event)=>setHoldForm({...holdForm,resourceKind:event.target.value as ResourceKind,resourcePublicId:''})}><option value="activity_registration_contact">活动报名联系</option><option value="verified_membership_phone">已验证会员手机号</option></select></label><label>联系方式版本<select required value={holdForm.resourcePublicId} onChange={(event)=>setHoldForm({...holdForm,resourcePublicId:event.target.value})}><option value="">请选择当前门店的联系方式版本</option>{eligibleResources.filter((item)=>item.resourceKind===holdForm.resourceKind).map((item)=><option key={item.publicId} value={item.publicId}>{item.businessLabel} · {item.maskedContact} · {item.status} · {item.publicId}</option>)}</select></label><label className="wide">法定或争议依据<input required minLength={3} maxLength={500} value={holdForm.basis} onChange={(event)=>setHoldForm({...holdForm,basis:event.target.value})}/></label><label className="wide">原因<input required minLength={2} maxLength={500} value={holdForm.reason} onChange={(event)=>setHoldForm({...holdForm,reason:event.target.value})}/></label><label>可选截止时间<input type="datetime-local" value={holdForm.holdUntil} onChange={(event)=>setHoldForm({...holdForm,holdUntil:event.target.value})}/></label><button disabled={busy==='hold'}>建立保留</button></form></details>}
      <section><header><strong>法定保留</strong><small>刷新后仍可查找和释放</small></header><div className="governance-list">{holds.map((hold)=><article key={hold.publicId}><div><strong>{resourceLabel(hold.resourceKind)} · {hold.maskedContact}</strong><small>{hold.resourcePublicId} · {hold.legalBasisReference}</small><small>{hold.createdBy} · {dateText(hold.createdAt)}</small></div><span>{hold.status==='active'?'保留中':'已释放'}</span>{canHold&&hold.status==='active'&&<button disabled={busy===`${hold.publicId}:release`} onClick={()=>void release(hold)}>释放</button>}</article>)}</div></section>
      <section><header><strong>清除证据</strong><small>仅证明已按发布策略完成加密清除</small></header><div className="governance-list">{dispositions.map((item)=><article key={`${item.resourceKind}:${item.resourcePublicId}`}><div><strong>{resourceLabel(item.resourceKind)} · {item.maskedContact}</strong><small>{item.resourcePublicId} · 策略第{item.policyVersion}版</small><small>{dateText(item.disposedAt)} 已清除</small></div><span>已清除</span></article>)}</div></section>
    </div>}
  </section>
}

function policyList(value:unknown):Policy[]{if(!Array.isArray(value))throw new Error('策略列表格式无法识别');return value.map((item)=>{const row=record(item);return{publicId:text(row.publicId),resourceKind:resourceKind(row.resourceKind),version:number(row.version),status:text(row.status),retentionDaysAfterPurposeEnd:number(row.retentionDaysAfterPurposeEnd),legalBasisReference:text(row.legalBasisReference),draftedBy:text(row.draftedBy),approvedBy:nullableText(row.approvedBy),publishedBy:nullableText(row.publishedBy),effectiveFrom:nullableText(row.effectiveFrom),effectiveUntil:nullableText(row.effectiveUntil)}})}
function evidenceView(value:unknown){const row=record(value);if(!Array.isArray(row.eligibleResources)||!Array.isArray(row.holds)||!Array.isArray(row.dispositions))throw new Error('治理证据格式无法识别');return{eligibleResources:row.eligibleResources.map((item)=>{const itemRow=record(item);return{publicId:text(itemRow.publicId),resourceKind:resourceKind(itemRow.resourceKind),maskedContact:text(itemRow.maskedContact),businessLabel:text(itemRow.businessLabel),status:text(itemRow.status)}}),holds:row.holds.map((item)=>{const itemRow=record(item);return{publicId:text(itemRow.publicId),resourceKind:resourceKind(itemRow.resourceKind),resourcePublicId:text(itemRow.resourcePublicId),maskedContact:text(itemRow.maskedContact),status:itemRow.status==='active'?'active' as const:'released' as const,legalBasisReference:text(itemRow.legalBasisReference),reason:text(itemRow.reason),createdBy:text(itemRow.createdBy),createdAt:text(itemRow.createdAt),holdUntil:nullableText(itemRow.holdUntil),releasedBy:nullableText(itemRow.releasedBy),releaseReason:nullableText(itemRow.releaseReason),releasedAt:nullableText(itemRow.releasedAt)}}),dispositions:row.dispositions.map((item)=>{const itemRow=record(item);return{resourcePublicId:text(itemRow.resourcePublicId),resourceKind:resourceKind(itemRow.resourceKind),maskedContact:text(itemRow.maskedContact),policyPublicId:text(itemRow.policyPublicId),policyVersion:number(itemRow.policyVersion),dispositionMethod:text(itemRow.dispositionMethod),purposeEndedAt:text(itemRow.purposeEndedAt),disposedAt:text(itemRow.disposedAt)}})}}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('数据格式无法识别');return value as Record<string,unknown>}
function text(value:unknown){if(typeof value!=='string')throw new Error('文本格式无法识别');return value}
function nullableText(value:unknown){return value===null?null:text(value)}
function number(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('数字格式无法识别');return Number(value)}
function resourceKind(value:unknown):ResourceKind{if(value!=='activity_registration_contact'&&value!=='verified_membership_phone')throw new Error('资源类型无法识别');return value}
function integer(value:string,label:string){if(!/^\d+$/.test(value)||Number(value)>36500)throw new Error(`${label}格式无效`);return Number(value)}
function message(error:unknown,fallback:string){return error instanceof Error?error.message:fallback}
function resourceLabel(value:ResourceKind){return value==='activity_registration_contact'?'活动报名联系':'会员验证手机号'}
function policyStatus(value:string){return({draft:'草稿',approved:'已审批',published:'已发布',retired:'已停用'} as Record<string,string>)[value]??value}
function dateText(value:string){return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
