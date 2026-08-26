import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BadgePercent, CheckCircle2, ChevronDown, Plus, Rocket, Trash2 } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import './promotional-loyalty-panel.css'

type TriggerKind = 'activity_payment'|'activity_check_in'|'activity_completion'
type StackingMode = 'stackable'|'exclusive_highest'|'exclusive_first'
type RefundPolicy = 'reverse_on_any_refund'|'reverse_on_full_refund'
type MemberLevel = 'member'|'silver'|'gold'

interface PromotionRule {
  id?:string;ruleCode:string;triggerKind:TriggerKind;points:number
  perMemberAwardLimit:number;minimumPaidAmountMinor:number;enabled:boolean
}
interface PromotionPolicy {
  id:string;campaignCode:string;version:number;name:string;activityId:string;activityTitle:string
  stackingGroup:string;stackingMode:StackingMode;priority:number;storeBudgetPoints:number
  perMemberPointsLimit:number;pointValidityDays:number;refundPolicy:RefundPolicy
  budgetReuseAfterRefund:boolean
  memberLimitReuseAfterRefund:boolean
  eligibleMemberLevels:MemberLevel[];status:'draft'|'approved'|'published'|'retired'
  effectiveFrom:string|null;effectiveUntil:string|null;reason:string;rules:PromotionRule[]
  awardedPoints:number;remainingBudgetPoints:number;deferredTriggerCount:number
}
interface PromotionConfiguration {
  policies:PromotionPolicy[]
  activities:Array<{ id:string;publicId:string;title:string;startsAt:string;status:string }>
}
interface DraftRule {
  ruleCode:string;triggerKind:TriggerKind;points:string;perMemberAwardLimit:string
  minimumPaidYuan:string;enabled:boolean
}
interface DraftForm {
  campaignCode:string;name:string;activityId:string;stackingGroup:string
  stackingMode:StackingMode;priority:string;storeBudgetPoints:string
  perMemberPointsLimit:string;pointValidityDays:string;refundPolicy:RefundPolicy
  budgetReuseAfterRefund:boolean
  memberLimitReuseAfterRefund:boolean
  eligibleMemberLevels:MemberLevel[];reason:string;rules:DraftRule[]
}

const triggerLabels:Record<TriggerKind,string>={
  activity_payment:'付款成功',activity_check_in:'到场签到',activity_completion:'活动完成',
}
const stackingLabels:Record<StackingMode,string>={
  stackable:'可与同组规则叠加',exclusive_highest:'同组只取积分最高',exclusive_first:'同组只取优先级最高',
}
const statusLabels={ draft:'待审批',approved:'待发布',published:'运行中',retired:'已结束' } as const

export function PromotionalLoyaltyPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}) {
  const { confirmAction, promptAction } = useConfirmationDialog()
  const canView=auth.permissions.includes('loyalty.promotion.view')
  const canManage=auth.permissions.includes('loyalty.promotion.manage')
  const canApprove=auth.permissions.includes('loyalty.promotion.approve')
  const canPublish=auth.permissions.includes('loyalty.promotion.publish')
  const [expanded,setExpanded]=useState(false)
  const [configuration,setConfiguration]=useState<PromotionConfiguration>({policies:[],activities:[]})
  const [draft,setDraft]=useState<DraftForm|null>(null)
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')

  const load=useCallback(async()=>{
    if(!canView)return
    try{
      const response=await api.getEndpoint<{data:PromotionConfiguration}>('/api/staff/loyalty/promotion-policies')
      setConfiguration(response.data)
    }catch(error){setNotice(message(error,'促销积分配置暂时无法读取'))}
  },[api,canView])
  useEffect(()=>{if(expanded)void load()},[expanded,load])
  if(!canView)return null

  async function submitDraft(event:FormEvent){
    event.preventDefault();if(!draft||busy)return
    const payload=draftPayload(draft)
    if(!(await confirmAction({title:'确认建立促销积分草稿',description:`建立“${draft.name}”草稿不会立即发积分，仍需他人审批和最高管理人员发布。`,confirmLabel:'建立草稿'})))return
    setBusy('draft');setNotice('')
    try{
      await api.postEndpoint('/api/staff/loyalty/promotion-policies',payload,{
        idempotencyKey:`loyalty-promotion-draft-${crypto.randomUUID()}`,
      })
      setDraft(null);setNotice('草稿已建立；规则尚未生效，等待独立审批。');await load()
    }catch(error){setNotice(message(error,'促销积分草稿没有保存'))}finally{setBusy('')}
  }

  function approve(_policy:PromotionPolicy){
    setNotice('审批已移至“会员经营配置中心”：系统将依据预算、会员上限、叠加、退款和权威活动事实生成影响预览。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publish(policy:PromotionPolicy){
    const start=(await promptAction({title:'填写促销积分生效时间',description:'例如 2026-08-20 18:00。',label:'生效时间',confirmLabel:'继续',multiline:false}))?.trim()
    if(!start)return
    const parsedStart=Date.parse(start)
    if(!Number.isFinite(parsedStart))return setNotice('生效时间格式无效。')
    const until=(await promptAction({title:'填写失效时间（可选）',description:'留空表示由下一版本准确接替。',label:'失效时间',confirmLabel:'继续',multiline:false}))?.trim()??''
    const parsedUntil=until?Date.parse(until):null
    if(parsedUntil!==null&&(!Number.isFinite(parsedUntil)||parsedUntil<=parsedStart))return setNotice('失效时间必须晚于生效时间。')
    const reason=(await promptAction({title:'填写发布说明',description:'说明会保留在规则审计中。',label:'发布说明',defaultValue:'已确认预算、叠加、触发证据和退款冲回策略',confirmLabel:'继续'}))?.trim()
    if(!reason||!(await confirmAction({title:'确认发布促销积分规则',description:`发布“${policy.name}”第${policy.version}版后，业务规则不可直接修改。`,confirmLabel:'确认发布'})))return
    setBusy(policy.id);setNotice('')
    try{
      await api.postEndpoint(`/api/staff/loyalty/promotion-policies/${encodeURIComponent(policy.id)}/publish`,{
        effectiveFrom:new Date(parsedStart).toISOString(),
        effectiveUntil:parsedUntil===null?null:new Date(parsedUntil).toISOString(),reason,
      },{idempotencyKey:`loyalty-promotion-publish-${crypto.randomUUID()}`})
      setNotice('已安排发布；系统只按权威付款、签到或完成事实发放。');await load()
    }catch(error){setNotice(message(error,'促销积分规则没有发布'))}finally{setBusy('')}
  }

  function changeRule(index:number,patch:Partial<DraftRule>){
    setDraft((current)=>current?{...current,rules:current.rules.map((rule,position)=>position===index?{...rule,...patch}:rule)}:current)
  }

  return <section className="promotion-loyalty-panel" aria-label="促销积分规则">
    <button className="promotion-loyalty-summary" type="button" aria-expanded={expanded} onClick={()=>setExpanded((value)=>!value)}>
      <span><BadgePercent size={18}/></span><div><strong>促销积分</strong><small>按活动付款、签到或完成事实发放；预算、上限和退款冲回均受控。</small></div>
      <em>{configuration.policies.filter((item)=>item.status==='published').length} 个运行中</em><ChevronDown size={17}/>
    </button>
    {expanded&&<div className="promotion-loyalty-body">
      {notice&&<p role="status">{notice}</p>}
      <div className="promotion-policy-grid">{configuration.policies.map((policy)=><article key={policy.id} data-status={policy.status}>
        <header><div><strong>{policy.name}</strong><small>{policy.activityTitle} · 第{policy.version}版</small></div><em>{statusLabels[policy.status]}</em></header>
        <div className="promotion-budget"><span style={{width:`${Math.min(100,policy.awardedPoints/policy.storeBudgetPoints*100)}%`}}/></div>
        <dl><div><dt>已发 / 预算</dt><dd>{policy.awardedPoints} / {policy.storeBudgetPoints}</dd></div><div><dt>个人上限</dt><dd>{policy.perMemberPointsLimit}</dd></div><div><dt>有效期</dt><dd>{policy.pointValidityDays}天</dd></div></dl>
        <small>{stackingLabels[policy.stackingMode]} · {policy.refundPolicy==='reverse_on_any_refund'?'任一退款即冲回':'全额退款才冲回'} · {policy.budgetReuseAfterRefund?'释放预算':'不释放预算'} · {policy.memberLimitReuseAfterRefund?'释放个人限额':'不释放个人限额'}</small>
        <div className="promotion-rule-chips">{policy.rules.filter((rule)=>rule.enabled).map((rule)=><span key={rule.id??rule.ruleCode}>{triggerLabels[rule.triggerKind]} +{rule.points}</span>)}</div>
        {policy.deferredTriggerCount>0&&<b>{policy.deferredTriggerCount} 条触发事实因总闸暂停待处理</b>}
        <footer>{policy.status==='draft'&&canApprove&&<button type="button" disabled={busy!==''} onClick={()=>void approve(policy)}><CheckCircle2 size={15}/>前往配置中心审批</button>}
          {policy.status==='approved'&&canPublish&&<button type="button" disabled={busy!==''} onClick={()=>void publish(policy)}><Rocket size={15}/>安排发布</button>}</footer>
      </article>)}</div>
      {configuration.policies.length===0&&<p className="promotion-empty">尚无促销积分规则。旧活动里的积分数字不会自动发放。</p>}
      {canManage&&!draft&&<button className="promotion-create" type="button" onClick={()=>setDraft(emptyDraft(configuration.activities[0]?.id??''))}><Plus size={16}/>新建促销积分草稿</button>}
      {draft&&<form className="promotion-draft" onSubmit={(event)=>void submitDraft(event)}>
        <header><div><strong>新建促销积分草稿</strong><small>默认采用保守预算、单次发放、180天有效期和退款即冲回；所有值均可配置。</small></div><button type="button" onClick={()=>setDraft(null)}>取消</button></header>
        <div className="promotion-form-grid">
          <label>规则名称<input required value={draft.name} onChange={(event)=>setDraft({...draft,name:event.target.value})}/></label>
          <label>活动<select required value={draft.activityId} onChange={(event)=>setDraft({...draft,activityId:event.target.value})}><option value="">请选择</option>{configuration.activities.map((activity)=><option key={activity.id} value={activity.id}>{activity.title} · {new Date(activity.startsAt).toLocaleDateString('zh-CN')}</option>)}</select></label>
          <label>业务编号<input required value={draft.campaignCode} onChange={(event)=>setDraft({...draft,campaignCode:event.target.value.toUpperCase()})}/></label>
          <label>门店总预算<input type="number" min="1" max="10000000" required value={draft.storeBudgetPoints} onChange={(event)=>setDraft({...draft,storeBudgetPoints:event.target.value})}/></label>
          <label>每会员积分上限<input type="number" min="1" max="100000" required value={draft.perMemberPointsLimit} onChange={(event)=>setDraft({...draft,perMemberPointsLimit:event.target.value})}/></label>
          <label>积分有效天数<input type="number" min="1" max="730" required value={draft.pointValidityDays} onChange={(event)=>setDraft({...draft,pointValidityDays:event.target.value})}/></label>
          <label>叠加组<input required value={draft.stackingGroup} onChange={(event)=>setDraft({...draft,stackingGroup:event.target.value.toUpperCase()})}/></label>
          <label>叠加方式<select value={draft.stackingMode} onChange={(event)=>setDraft({...draft,stackingMode:event.target.value as StackingMode})}>{Object.entries(stackingLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>同组优先级<input type="number" min="0" max="10000" value={draft.priority} onChange={(event)=>setDraft({...draft,priority:event.target.value})}/></label>
          <label>退款处理<select value={draft.refundPolicy} onChange={(event)=>setDraft({...draft,refundPolicy:event.target.value as RefundPolicy})}><option value="reverse_on_any_refund">任一成功退款即冲回</option><option value="reverse_on_full_refund">全额退款才冲回</option></select></label>
          <label>退款后预算<select value={draft.budgetReuseAfterRefund?'reuse':'hold'} onChange={(event)=>setDraft({...draft,budgetReuseAfterRefund:event.target.value==='reuse'})}><option value="hold">不释放，防反复套取</option><option value="reuse">释放，可再次发放</option></select></label>
          <label>退款后个人限额<select value={draft.memberLimitReuseAfterRefund?'reuse':'hold'} onChange={(event)=>setDraft({...draft,memberLimitReuseAfterRefund:event.target.value==='reuse'})}><option value="hold">不释放，防个人反复领取</option><option value="reuse">释放，允许再次领取</option></select></label>
        </div>
        <fieldset><legend>适用会员</legend>{([['member','普通'],['silver','银卡'],['gold','金卡']] as const).map(([value,label])=><label key={value}><input type="checkbox" checked={draft.eligibleMemberLevels.includes(value)} onChange={(event)=>setDraft({...draft,eligibleMemberLevels:event.target.checked?[...draft.eligibleMemberLevels,value]:draft.eligibleMemberLevels.filter((item)=>item!==value)})}/>{label}</label>)}</fieldset>
        <div className="promotion-rules"><header><strong>触发与奖励</strong><button type="button" onClick={()=>setDraft({...draft,rules:[...draft.rules,emptyRule(draft.rules.length+1)]})}><Plus size={14}/>增加</button></header>{draft.rules.map((rule,index)=><div className="promotion-rule-row" key={`${index}-${rule.ruleCode}`}>
          <label>规则编号<input required value={rule.ruleCode} onChange={(event)=>changeRule(index,{ruleCode:event.target.value.toUpperCase()})}/></label>
          <label>触发<select value={rule.triggerKind} onChange={(event)=>changeRule(index,{triggerKind:event.target.value as TriggerKind,minimumPaidYuan:event.target.value==='activity_payment'?rule.minimumPaidYuan:'0'})}>{Object.entries(triggerLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>奖励积分<input type="number" min="1" max="100000" required value={rule.points} onChange={(event)=>changeRule(index,{points:event.target.value})}/></label>
          <label>每人次数<input type="number" min="1" max="100" required value={rule.perMemberAwardLimit} onChange={(event)=>changeRule(index,{perMemberAwardLimit:event.target.value})}/></label>
          {rule.triggerKind==='activity_payment'&&<label>最低付款（元）<input inputMode="decimal" required value={rule.minimumPaidYuan} onChange={(event)=>changeRule(index,{minimumPaidYuan:event.target.value})}/></label>}
          {draft.rules.length>1&&<button aria-label="删除规则" type="button" onClick={()=>setDraft({...draft,rules:draft.rules.filter((_,position)=>position!==index)})}><Trash2 size={15}/></button>}
        </div>)}</div>
        <label>起草原因<textarea required minLength={2} maxLength={500} value={draft.reason} onChange={(event)=>setDraft({...draft,reason:event.target.value})}/></label>
        <button className="promotion-submit" type="submit" disabled={busy!==''||configuration.activities.length===0}>{busy==='draft'?'正在保存':'保存草稿，交由他人审批'}</button>
      </form>}
    </div>}
  </section>
}

function emptyDraft(activityId:string):DraftForm{return{
  campaignCode:'',name:'',activityId,stackingGroup:'ACTIVITY',stackingMode:'exclusive_highest',priority:'100',
  storeBudgetPoints:'10000',perMemberPointsLimit:'200',pointValidityDays:'180',
  refundPolicy:'reverse_on_any_refund',budgetReuseAfterRefund:false,memberLimitReuseAfterRefund:false,eligibleMemberLevels:['member','silver','gold'],
  reason:'限定预算试运行，按活动权威事实发放并观察效果',rules:[emptyRule(1)],
}}
function emptyRule(index:number):DraftRule{return{ruleCode:`RULE-${index}`,triggerKind:'activity_check_in',points:'60',perMemberAwardLimit:'1',minimumPaidYuan:'0',enabled:true}}
function draftPayload(draft:DraftForm){
  if(!draft.activityId)throw new Error('请选择活动')
  if(draft.eligibleMemberLevels.length===0)throw new Error('至少选择一个会员等级')
  return{...draft,priority:whole(draft.priority,'优先级'),storeBudgetPoints:whole(draft.storeBudgetPoints,'门店预算'),
    perMemberPointsLimit:whole(draft.perMemberPointsLimit,'个人上限'),pointValidityDays:whole(draft.pointValidityDays,'有效天数'),
    rules:draft.rules.map((rule)=>({...rule,points:whole(rule.points,'奖励积分'),perMemberAwardLimit:whole(rule.perMemberAwardLimit,'每人次数'),minimumPaidAmountMinor:yuan(rule.minimumPaidYuan)})),
  }
}
function whole(value:string,label:string){const parsed=Number(value);if(!Number.isSafeInteger(parsed))throw new Error(`${label}必须是整数`);return parsed}
function yuan(value:string){if(!/^\d+(\.\d{1,2})?$/.test(value))throw new Error('最低付款金额格式无效');return Math.round(Number(value)*100)}
function message(error:unknown,fallback:string){return error instanceof Error?error.message:fallback}
