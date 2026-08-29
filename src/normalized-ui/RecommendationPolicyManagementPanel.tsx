import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, Copy, FileCheck2, Plus, Rocket, ShieldCheck } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import './recommendation-policy-management-panel.css'

type PolicyStatus = 'draft'|'approved'|'published'|'retired'
type RolloutState = 'disabled'|'shadow'|'pilot'|'enabled'

interface PolicyView {
  publicId:string;code:string;version:number;status:PolicyStatus
  preferenceWeight:number;sceneWeight:number;marginWeight:number;priorityWeight:number
  performanceWeight:number;inventoryWeight:number;capacityWeight:number
  minimumGrossMarginBasisPoints:number;preferenceHalfLifeDays:number;preferenceMaxAgeDays:number
  preferenceMinEffectiveScore:number;preferenceMinConfidenceBasisPoints:number
  explanationTemplate:string;draftReason:string;approvalReason:string|null;publicationReason:string|null
  publicationMode:'legacy_unverified'|'separated';createdBy:string|null;approvedBy:string|null
  publishedBy:string|null;createdAt:string;approvedAt:string|null;publishedAt:string|null
  effectiveFrom:string|null;effectiveUntil:string|null
}
interface Configuration {
  feature:{rolloutState:RolloutState;reason:string;effectiveFrom:string|null;updatedAt:string}
  policies:PolicyView[]
}
interface Draft {
  preferenceWeight:string;sceneWeight:string;marginWeight:string;priorityWeight:string
  minimumGrossMarginBasisPoints:string;preferenceHalfLifeDays:string;preferenceMaxAgeDays:string
  preferenceMinEffectiveScore:string;preferenceMinConfidenceBasisPoints:string
  explanationTemplate:string;draftReason:string
}

const statusLabel:Record<PolicyStatus,string>={draft:'待审批',approved:'待发布',published:'已排期',retired:'历史'}
const rolloutLabel:Record<RolloutState,string>={disabled:'关闭',shadow:'影子验证',pilot:'小范围试点',enabled:'正式开放'}

export function RecommendationPolicyManagementPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}) {
  const { confirmAction, promptAction } = useConfirmationDialog()
  const canView=auth.permissions.includes('recommendation.rule.view')
  const canDraft=auth.permissions.includes('recommendation.rule.draft')
  const canApprove=auth.permissions.includes('recommendation.rule.approve')
  const canPublish=auth.permissions.includes('recommendation.rule.publish')
  const [expanded,setExpanded]=useState(false)
  const [configuration,setConfiguration]=useState<Configuration|null>(null)
  const [draft,setDraft]=useState<Draft|null>(null)
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')

  const load=useCallback(async()=>{
    if(!canView)return
    setBusy('load');setNotice('')
    try{
      const response=await api.getEndpoint<{data:Configuration}>('/api/staff/customer-experience/recommendation-policies')
      setConfiguration(response.data)
    }catch(error){setNotice(message(error,'推荐规则暂时无法读取'))}
    finally{setBusy('')}
  },[api,canView])
  useEffect(()=>{if(expanded)void load()},[expanded,load])
  if(!canView)return null

  async function create(event:FormEvent){
    event.preventDefault();if(!draft||busy)return
    if(!(await confirmAction({title:'确认保存推荐规则草稿',description:'草稿不会改变顾客页面，仍需另外两名授权人员审批和发布。',confirmLabel:'保存草稿'})))return
    setBusy('create');setNotice('')
    try{
      await api.postEndpoint('/api/staff/customer-experience/recommendation-policies',{
        code:'DEFAULT',preferenceWeight:integer(draft.preferenceWeight,'偏好权重',-1000,1000),
        sceneWeight:integer(draft.sceneWeight,'场景权重',-1000,1000),
        marginWeight:integer(draft.marginWeight,'毛利权重',-1000,1000),
        priorityWeight:integer(draft.priorityWeight,'经营优先级权重',-1000,1000),
        performanceWeight:0,inventoryWeight:0,capacityWeight:0,
        minimumGrossMarginBasisPoints:integer(draft.minimumGrossMarginBasisPoints,'最低毛利基点',0,9999),
        preferenceHalfLifeDays:integer(draft.preferenceHalfLifeDays,'偏好半衰期',7,730),
        preferenceMaxAgeDays:integer(draft.preferenceMaxAgeDays,'偏好最长有效期',30,3650),
        preferenceMinEffectiveScore:integer(draft.preferenceMinEffectiveScore,'偏好最低有效分',1,10000),
        preferenceMinConfidenceBasisPoints:integer(draft.preferenceMinConfidenceBasisPoints,'偏好最低置信度',0,10000),
        explanationTemplate:draft.explanationTemplate.trim(),displayConfiguration:{},draftReason:draft.draftReason.trim(),
      },{idempotencyKey:key('recommendation-policy-draft')})
      setDraft(null);setNotice('草稿已保存；顾客推荐仍按原版本和独立开关运行。');await load()
    }catch(error){setNotice(message(error,'推荐规则草稿没有保存'))}finally{setBusy('')}
  }

  async function approve(policy:PolicyView){
    const reason=(await promptAction({title:'填写独立审批依据',description:'请核对偏好衰减、毛利底线和解释文案。',label:'审批依据',defaultValue:'关键参数已复核',confirmLabel:'继续'}))?.trim()??''
    if(reason.length<2||busy)return
    setBusy(policy.publicId);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/customer-experience/recommendation-policies/${encodeURIComponent(policy.publicId)}/approve`,{reason},{idempotencyKey:key('recommendation-policy-approve')})
      setNotice('审批完成；规则仍未发布，也不会自动开放顾客推荐。');await load()
    }catch(error){setNotice(message(error,'推荐规则没有通过审批'))}finally{setBusy('')}
  }

  async function publish(policy:PolicyView){
    const entered=(await promptAction({title:'填写规则生效时间',description:'例如 2026-08-20 18:00。',label:'生效时间',defaultValue:localStart(),confirmLabel:'继续',multiline:false}))?.trim()??''
    const parsed=Date.parse(entered)
    if(!Number.isFinite(parsed))return setNotice('生效时间格式无效。')
    const reason=(await promptAction({title:'填写发布依据',description:'发布后业务参数不可直接修改。',label:'发布依据',defaultValue:'已核对版本、试点边界和回退方案',confirmLabel:'继续'}))?.trim()??''
    if(reason.length<2||busy)return
    if(!(await confirmAction({title:'确认安排推荐规则生效',description:`安排第 ${policy.version} 版在 ${new Date(parsed).toLocaleString('zh-CN')} 生效。发布不会自动开启顾客推荐。`,confirmLabel:'确认排期'})))return
    setBusy(policy.publicId);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/customer-experience/recommendation-policies/${encodeURIComponent(policy.publicId)}/publish`,{
        effectiveFrom:new Date(parsed).toISOString(),reason,
      },{idempotencyKey:key('recommendation-policy-publish')})
      setNotice('版本已排期；顾客推荐开关保持原状态，需另行确认试点。');await load()
    }catch(error){setNotice(message(error,'推荐规则没有发布'))}finally{setBusy('')}
  }

  async function clone(policy:PolicyView){
    const reason=(await promptAction({title:'填写复制原因',description:'系统会建立新草稿，不会修改历史版本。',label:'复制原因',defaultValue:'基于历史稳定版本调整',confirmLabel:'继续'}))?.trim()??''
    if(reason.length<2||busy)return
    setBusy(policy.publicId);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/customer-experience/recommendation-policies/${encodeURIComponent(policy.publicId)}/clone-draft`,{reason},{idempotencyKey:key('recommendation-policy-clone')})
      setNotice('已复制为新草稿；当前运行版本不受影响。');await load()
    }catch(error){setNotice(message(error,'历史版本没有复制成功'))}finally{setBusy('')}
  }

  async function setRollout(rolloutState:RolloutState){
    const reason=(await promptAction({title:'填写推荐开放调整原因',description:`将顾客推荐调整为“${rolloutLabel[rolloutState]}”。`,label:'调整原因',defaultValue:rolloutState==='disabled'?'停止顾客曝光，保留原点单流程':rolloutState==='pilot'?'当前已发布规则用于可随时关闭的门店试运行':'已完成规则、岗位和样本复核',confirmLabel:'继续'}))?.trim()??''
    if(reason.length<2||busy)return
    if((rolloutState==='pilot'||rolloutState==='enabled')&&!(await confirmAction({title:'确认开放顾客推荐',description:rolloutState==='pilot'?'试运行可使用当前已发布规则，随时可关闭；可售、库存、产能与支付门禁不变。':'正式启用仍需要当前生效的三人分离版本。',confirmLabel:'确认开放'})))return
    setBusy('rollout');setNotice('')
    try{
      await api.putEndpoint('/api/staff/customer-experience/features/recommendation.engine',{
        rolloutState,configuration:{},reason,
      },{idempotencyKey:key('recommendation-rollout')})
      setNotice(`顾客推荐已调整为“${rolloutLabel[rolloutState]}”。`);await load()
    }catch(error){setNotice(message(error,'推荐开放状态没有改变'))}finally{setBusy('')}
  }

  const active=configuration?.policies.find((policy)=>policy.status==='published'&&isCurrent(policy))??null
  return <section className="recommendation-policy-panel" aria-label="推荐规则版本与试点">
    <button className="recommendation-policy-summary" type="button" aria-expanded={expanded} onClick={()=>setExpanded((value)=>!value)}>
      <span><ShieldCheck size={18}/></span><div><strong>推荐规则与顾客开放</strong><small>规则版本与顾客试运行分开管理；正式启用仍保留三人分离发布。</small></div>
      <em>{configuration?rolloutLabel[configuration.feature.rolloutState]:'读取中'}</em><ChevronDown size={17}/>
    </button>
    {expanded&&<div className="recommendation-policy-body">
      {notice&&<p role="status">{notice}</p>}
      <div className="recommendation-rollout-card"><div><strong>顾客开放状态：{configuration?rolloutLabel[configuration.feature.rolloutState]:'—'}</strong><small>{configuration?.feature.reason??'正在读取门店状态'}{active?` · 当前第 ${active.version} 版`:' · 当前没有已生效的发布版本'}</small></div>
        {canPublish&&<div>{(['disabled','shadow','pilot','enabled'] as const).map((state)=><button type="button" key={state} disabled={busy!==''||configuration?.feature.rolloutState===state} onClick={()=>void setRollout(state)}>{rolloutLabel[state]}</button>)}</div>}
      </div>
      <p className="recommendation-policy-boundary">演出、库存、产能已作为硬性可售门禁，但尚未成为可调评分项，因此对应权重固定为 0；不得用虚假分值影响排序。</p>
      <div className="recommendation-policy-grid">{configuration?.policies.map((policy)=><article key={policy.publicId} data-status={policy.status}>
        <header><div><strong>{policy.code} · 第 {policy.version} 版</strong><small>{policy.publicationMode==='legacy_unverified'?'历史版本，未补造三人证据':'三人分离受控版本'}</small></div><em>{statusLabel[policy.status]}</em></header>
        <dl><div><dt>偏好 / 场景</dt><dd>{policy.preferenceWeight} / {policy.sceneWeight}</dd></div><div><dt>毛利 / 优先级</dt><dd>{policy.marginWeight} / {policy.priorityWeight}</dd></div><div><dt>最低毛利</dt><dd>{(policy.minimumGrossMarginBasisPoints/100).toFixed(2)}%</dd></div></dl>
        <small>{policy.explanationTemplate}</small>
        <small>起草：{policy.createdBy??'历史未记录'} · 审批：{policy.approvedBy??'尚未审批'} · 发布：{policy.publishedBy??'尚未发布'}</small>
        <small>{policy.effectiveFrom?`${new Date(policy.effectiveFrom).toLocaleString('zh-CN')} 起${policy.effectiveUntil?`，至 ${new Date(policy.effectiveUntil).toLocaleString('zh-CN')}`:''}`:'尚未排期'} · {policy.publicationReason??policy.approvalReason??policy.draftReason}</small>
        <footer>{policy.status==='draft'&&canApprove&&<button type="button" disabled={busy!==''} onClick={()=>void approve(policy)}><FileCheck2 size={15}/>独立审批</button>}
          {policy.status==='approved'&&canPublish&&<button type="button" disabled={busy!==''} onClick={()=>void publish(policy)}><Rocket size={15}/>排期发布</button>}
          {canDraft&&<button type="button" disabled={busy!==''} onClick={()=>void clone(policy)}><Copy size={15}/>复制为草稿</button>}</footer>
      </article>)}</div>
      {configuration?.policies.length===0&&<p className="recommendation-policy-empty">尚无推荐规则；顾客推荐保持关闭，原点单流程不受影响。</p>}
      {canDraft&&!draft&&<button className="recommendation-policy-create" type="button" onClick={()=>setDraft(emptyDraft(configuration?.policies[0]))}><Plus size={16}/>新建推荐规则草稿</button>}
      {draft&&<form className="recommendation-policy-draft" onSubmit={(event)=>void create(event)}>
        <header><div><strong>新建 DEFAULT 推荐规则草稿</strong><small>仅保存强类型经营参数；保存、审批、发布必须由三名不同员工完成。</small></div><button type="button" onClick={()=>setDraft(null)}>取消</button></header>
        <div>{field('偏好权重','preferenceWeight',draft,setDraft,-1000,1000)}{field('场景权重','sceneWeight',draft,setDraft,-1000,1000)}{field('毛利权重','marginWeight',draft,setDraft,-1000,1000)}{field('经营优先级权重','priorityWeight',draft,setDraft,-1000,1000)}{field('最低毛利基点','minimumGrossMarginBasisPoints',draft,setDraft,0,9999)}{field('偏好半衰期（天）','preferenceHalfLifeDays',draft,setDraft,7,730)}{field('偏好最长有效期（天）','preferenceMaxAgeDays',draft,setDraft,30,3650)}{field('偏好最低有效分','preferenceMinEffectiveScore',draft,setDraft,1,10000)}{field('最低置信度基点','preferenceMinConfidenceBasisPoints',draft,setDraft,0,10000)}</div>
        <label>顾客可见解释<textarea required minLength={2} maxLength={500} value={draft.explanationTemplate} onChange={(event)=>setDraft({...draft,explanationTemplate:event.target.value})}/></label>
        <label>起草原因<textarea required minLength={2} maxLength={500} value={draft.draftReason} onChange={(event)=>setDraft({...draft,draftReason:event.target.value})}/></label>
        <button className="recommendation-policy-submit" type="submit" disabled={busy!==''}>保存草稿，交由另一人审批</button>
      </form>}
    </div>}
  </section>
}

function field(label:string,keyName:keyof Draft,draft:Draft,setDraft:(value:Draft)=>void,min:number,max:number){return <label key={keyName}>{label}<input type="number" min={min} max={max} required value={draft[keyName]} onChange={(event)=>setDraft({...draft,[keyName]:event.target.value})}/></label>}
function emptyDraft(source?:PolicyView):Draft{return{
  preferenceWeight:String(source?.preferenceWeight??100),sceneWeight:String(source?.sceneWeight??60),
  marginWeight:String(source?.marginWeight??50),priorityWeight:String(source?.priorityWeight??50),
  minimumGrossMarginBasisPoints:String(source?.minimumGrossMarginBasisPoints??1500),
  preferenceHalfLifeDays:String(source?.preferenceHalfLifeDays??90),preferenceMaxAgeDays:String(source?.preferenceMaxAgeDays??730),
  preferenceMinEffectiveScore:String(source?.preferenceMinEffectiveScore??1000),
  preferenceMinConfidenceBasisPoints:String(source?.preferenceMinConfidenceBasisPoints??2500),
  explanationTemplate:source?.explanationTemplate??'按人数、场景、明确偏好、价格与当前可售条件提供三档建议',
  draftReason:'根据门店影子样本调整推荐经营参数',
}}
function integer(value:string,label:string,min:number,max:number){const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new Error(`${label}超出范围`);return parsed}
function key(prefix:string){return `${prefix}-${crypto.randomUUID()}`}
function localStart(){const date=new Date(Date.now()+5*60_000);date.setSeconds(0,0);return date.toLocaleString('sv-SE').slice(0,16).replace('T',' ')}
function isCurrent(policy:PolicyView){const now=Date.now();const start=policy.effectiveFrom?Date.parse(policy.effectiveFrom):Number.POSITIVE_INFINITY;const end=policy.effectiveUntil?Date.parse(policy.effectiveUntil):Number.POSITIVE_INFINITY;return start<=now&&now<end}
function message(error:unknown,fallback:string){return error instanceof Error&&error.message.trim()?error.message:fallback}
