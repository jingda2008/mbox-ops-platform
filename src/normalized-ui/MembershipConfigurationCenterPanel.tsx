import { useCallback,useEffect,useMemo,useState } from 'react'
import { ChevronDown,FileCheck2,RefreshCw,Save,ShieldCheck } from 'lucide-react'
import type { NormalizedApiClient,StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import './membership-configuration-center-panel.css'

type Domain='base_points'|'tier_policy'|'tier_benefits'|'redemption_catalog'|'promotion_points'|'membership_terms'|'wechat_notifications'
type ConfigurationContent={domain:Domain}&Record<string,unknown>
interface Summary{domain:Domain;configurationId:string;status:string;revision:number;version:number;title:string;updatedAt:string}
interface Draft{publicId:string;domain:Domain;status:string;revision:number;makerEmployeeIds:string[];content:ConfigurationContent;updatedAt:string}
interface Preview{publicId:string;draftRevision:number;expiresAt:string;historicalMembership:{activeMembers:number;availablePointsLiability:number};estimatedPointsIssued:number;estimatedPointsCostAmountMinor:number;estimatedBenefitCostAmountMinor:number;estimatedRedemptionCostAmountMinor:number;affectedExistingMembers:number;warnings:string[]}

const domainLabels:Record<Domain,string>={base_points:'基础积分',tier_policy:'会员等级',tier_benefits:'等级权益',redemption_catalog:'积分兑换',promotion_points:'促销积分',membership_terms:'入会条款',wechat_notifications:'微信服务通知'}
const statusLabels:Record<string,string>={draft:'待编辑/审批',approved:'已审批待发布',published:'运行中',paused:'已暂停',retired:'已退役'}
const warningLabels:Record<string,string>={inventory_shortage:'库存可能不足',fulfillment_capacity_review:'需要复核人工履约能力',points_cost_review:'需要复核积分成本',benefit_cost_review:'需要复核权益成本',redemption_cost_review:'需要复核兑换成本',terms_reacceptance_not_forced:'不强迫既有会员重新同意'}
const fieldLabels:Record<string,string>={pointsNumerator:'积分倍率分子',pointsDenominatorMinor:'每多少分金额',growthNumerator:'成长值倍率分子',growthDenominatorMinor:'成长值金额分母',roundingMode:'取整方式',pointsValidityMonths:'积分有效月数',evaluationWindowMonths:'评估周期（月）',tierPeriodMonths:'等级周期（月）',downgradeGraceDays:'降级宽限天数',silverUpgradeGrowth:'银卡升级值',silverRetainGrowth:'银卡保级值',goldUpgradeGrowth:'金卡升级值',goldRetainGrowth:'金卡保级值',silverPointsMultiplierNumerator:'银卡积分倍率分子',silverPointsMultiplierDenominator:'银卡积分倍率分母',goldPointsMultiplierNumerator:'金卡积分倍率分子',goldPointsMultiplierDenominator:'金卡积分倍率分母',tierPolicyVersionId:'等级策略版本ID',rules:'规则',items:'兑换项',ruleCode:'规则编号',eligibleTier:'适用等级',inheritToHigherTiers:'向更高等级继承',grantOnEntry:'入级发放',grantOnRetention:'保级发放',benefitDefinitionId:'权益定义ID',quantity:'数量',validityDays:'有效天数',revocationPolicy:'降级处理',enabled:'启用',publicId:'公开编号',itemCode:'兑换项编号',name:'名称',fulfillmentKind:'履约类型',productId:'商品ID',activityId:'活动ID',pointsRequired:'所需积分',costAmountMinor:'成本（分）',currency:'币种',totalInventory:'总库存',dailyInventory:'日库存',memberDailyLimit:'每人每日上限',memberRolling30DayLimit:'每人30日上限',memberLifetimeLimit:'每人终身上限',minimumTier:'最低等级',requiresTableSession:'需要桌台会话',requiresEmployeeFulfillment:'需要员工履约',cancellationAllowedBeforeFulfillment:'履约前允许取消',restoreExpiredPointsDays:'退回过期积分天数',availableFrom:'可用开始时间',availableUntil:'可用结束时间',fulfillmentTimeoutMinutes:'履约时限（分钟）',status:'状态',campaignCode:'活动积分编号',stackingGroup:'叠加组',stackingMode:'叠加方式',priority:'优先级',storeBudgetPoints:'门店总预算积分',perMemberPointsLimit:'每会员上限',pointValidityDays:'积分有效天数',refundPolicy:'退款冲回规则',budgetReuseAfterRefund:'退款后释放预算',memberLimitReuseAfterRefund:'退款后释放个人限额',eligibleMemberLevels:'适用会员等级',triggerKind:'触发事实',points:'奖励积分',perMemberAwardLimit:'每人奖励次数',minimumPaidAmountMinor:'最低付款金额（分）',title:'标题',summary:'摘要',content:'正文',notificationType:'通知类型',authorizationPurpose:'授权用途',authorizationContext:'授权场景',templateId:'微信模板ID',pagePath:'到达页面',pointsDataKey:'积分字段',balanceDataKey:'余额字段',occurredAtDataKey:'发生时间字段',expiresAtDataKey:'到期时间字段',expiryLeadDays:'提前提醒天数',maxPerCustomerPer24h:'每人24小时上限',minimumIntervalMinutes:'最短发送间隔',quietHoursStart:'静默开始',quietHoursEnd:'静默结束'}

export function MembershipConfigurationCenterPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const { confirmAction } = useConfirmationDialog()
  const canView=auth.permissions.includes('loyalty.configuration.view')
  const canEdit=auth.permissions.includes('loyalty.configuration.edit')
  const canPreview=auth.permissions.includes('loyalty.configuration.preview')
  const canApprove=auth.permissions.includes('loyalty.configuration.approve')
  const [expanded,setExpanded]=useState(false)
  const [summaries,setSummaries]=useState<Summary[]>([])
  const [selected,setSelected]=useState<Draft|null>(null)
  const [editing,setEditing]=useState<ConfigurationContent|null>(null)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [reason,setReason]=useState('')
  const [busy,setBusy]=useState('')
  const [notice,setNotice]=useState('')

  const load=useCallback(async()=>{if(!canView)return
    setBusy('load');setNotice('')
    try{const response=await api.getEndpoint<{data:Summary[]}>('/api/staff/loyalty/configuration-center');setSummaries(response.data)}
    catch(error){setNotice(message(error,'经营配置暂时无法读取'))}finally{setBusy('')}
  },[api,canView])
  useEffect(()=>{if(expanded)void load()},[expanded,load])
  useEffect(()=>{const open=()=>{setExpanded(true);requestAnimationFrame(()=>(
    document.getElementById('membership-configuration-center')?.scrollIntoView({behavior:'smooth',block:'start'})
  ))};window.addEventListener('mbox:open-membership-configuration',open)
    return()=>window.removeEventListener('mbox:open-membership-configuration',open)},[])
  const selectedSummary=useMemo(()=>summaries.find((item)=>item.configurationId===selected?.publicId)??null,[selected,summaries])
  if(!canView)return null

  async function open(item:Summary){setBusy(item.configurationId);setNotice('');setPreview(null)
    try{const response=await api.getEndpoint<{data:Draft}>(path(item));setSelected(response.data);setEditing(clone(response.data.content));setReason('')}
    catch(error){setNotice(message(error,'配置详情暂时无法读取'))}finally{setBusy('')}
  }
  async function save(){if(!selected||!editing||busy)return;if(reason.trim().length<2)return setNotice('请填写本次修改原因。')
    setBusy('save');setNotice('');setPreview(null)
    try{const result=await api.putEndpoint<Draft>(`${path(selected)}/draft`,{expectedRevision:selected.revision,reason:reason.trim(),content:editing});setSelected(result);setEditing(clone(result.content));setNotice('草稿已保存；此前影响预览已失效，请重新生成。');await load()}
    catch(error){setNotice(message(error,'草稿没有保存，请刷新后重试'))}finally{setBusy('')}
  }
  async function generatePreview(){if(!selected||busy)return;setBusy('preview');setNotice('')
    try{const result=await api.postEndpoint<Preview>(`${path(selected)}/impact-preview`,{});setPreview(result);setNotice('预览由服务端按当前会员、成本、库存和履约事实生成，15分钟内有效。')}
    catch(error){setNotice(message(error,'影响预览生成失败'))}finally{setBusy('')}
  }
  async function approve(){if(!selected||!preview||busy)return;if(reason.trim().length<2)return setNotice('请填写独立审批说明。')
    if(!(await confirmAction({title:'确认独立审批',description:'将依据当前服务端影响预览审批。审批后内容不可直接修改，仍需第三人发布。',confirmLabel:'确认审批'})))return
    setBusy('approve');setNotice('')
    try{const result=await api.postEndpoint<Draft>(`${path(selected)}/approve`,{expectedRevision:selected.revision,impactPreviewPublicId:preview.publicId,reason:reason.trim()});setSelected(result);setEditing(clone(result.content));setPreview(null);setNotice('独立审批已记录；配置尚未生效，等待第三位授权人员发布。');await load()}
    catch(error){setNotice(message(error,'审批未完成，请重新生成影响预览'))}finally{setBusy('')}
  }

  return <section id="membership-configuration-center" className="membership-configuration-center" aria-label="会员经营配置中心">
    <button className="membership-configuration-summary" type="button" aria-expanded={expanded} onClick={()=>setExpanded((value)=>!value)}>
      <span><ShieldCheck size={18}/></span><div><strong>会员经营配置中心</strong><small>保存草稿、计算影响、独立审批；所有经营字段均为强类型配置。</small></div><em>{summaries.filter((item)=>item.status==='draft').length} 个待处理</em><ChevronDown size={17}/>
    </button>
    {expanded&&<div className="membership-configuration-body">
      {notice&&<p role="status">{notice}</p>}
      <div className="membership-configuration-layout">
        <nav aria-label="配置列表"><header><strong>配置版本</strong><button type="button" disabled={busy!==''} onClick={()=>void load()} aria-label="刷新配置"><RefreshCw size={15}/></button></header>
          {summaries.map((item)=><button key={`${item.domain}-${item.configurationId}`} type="button" data-active={selected?.publicId===item.configurationId} onClick={()=>void open(item)}><span><strong>{domainLabels[item.domain]}</strong><small>{item.title} · 第{item.version}版</small></span><em>{statusLabels[item.status]??item.status}</em></button>)}
          {summaries.length===0&&<small>尚无可管理的配置版本。</small>}
        </nav>
        <div className="membership-configuration-workspace">
          {!selected||!editing?<div className="membership-configuration-empty"><FileCheck2 size={24}/><strong>选择一个配置版本</strong><small>运行中的版本只读；待审批草稿可继续保存。</small></div>:<>
            <header><div><strong>{domainLabels[selected.domain]}</strong><small>{selectedSummary?.title??'配置版本'} · 修订 {selected.revision}</small></div><em>{statusLabels[selected.status]??selected.status}</em></header>
            <p className="membership-configuration-separation">全部参与修改的人均不能审批；审批人也不能发布。旧页面的“已看过”勾选不再作为审批依据。</p>
            <div className="membership-configuration-fields">{fields(editing,(next)=>setEditing(next))}</div>
            <label className="membership-configuration-reason">本次修改或审批说明<textarea minLength={2} maxLength={500} value={reason} onChange={(event)=>setReason(event.target.value)} placeholder="说明改什么、为什么，以及核对了哪些经营影响"/></label>
            <div className="membership-configuration-actions">
              {selected.status==='draft'&&canEdit&&<button type="button" disabled={busy!==''} onClick={()=>void save()}><Save size={15}/>保存草稿</button>}
              {selected.status==='draft'&&canPreview&&<button type="button" disabled={busy!==''} onClick={()=>void generatePreview()}><FileCheck2 size={15}/>生成服务端影响预览</button>}
              {selected.status==='draft'&&canApprove&&preview&&<button className="primary" type="button" disabled={busy!==''} onClick={()=>void approve()}><ShieldCheck size={15}/>独立审批</button>}
            </div>
            {preview&&<article className="membership-impact-preview"><header><strong>影响预览</strong><small>{new Date(preview.expiresAt).toLocaleTimeString('zh-CN')} 前有效</small></header><dl>
              <div><dt>现有会员</dt><dd>{preview.historicalMembership.activeMembers}</dd></div><div><dt>受影响会员</dt><dd>{preview.affectedExistingMembers}</dd></div><div><dt>预计积分</dt><dd>{preview.estimatedPointsIssued}</dd></div><div><dt>积分成本</dt><dd>¥{minor(preview.estimatedPointsCostAmountMinor)}</dd></div><div><dt>权益成本</dt><dd>¥{minor(preview.estimatedBenefitCostAmountMinor)}</dd></div><div><dt>兑换成本</dt><dd>¥{minor(preview.estimatedRedemptionCostAmountMinor)}</dd></div>
            </dl>{preview.warnings.length>0&&<ul>{preview.warnings.map((warning)=><li key={warning}>{warningLabels[warning]??warning}</li>)}</ul>}</article>}
          </>}
        </div>
      </div>
    </div>}
  </section>
}

function fields(content:ConfigurationContent,onChange:(value:ConfigurationContent)=>void){return Object.entries(content).filter(([key])=>key!=='domain').map(([key,value])=><Field key={key} fieldKey={key} value={value} onChange={(next)=>onChange({...content,[key]:next})}/>)}
function Field({fieldKey,value,onChange}:{fieldKey:string;value:unknown;onChange(value:unknown):void}){
  const label=fieldLabels[fieldKey]??fieldKey
  if(Array.isArray(value))return <fieldset className="membership-array"><legend>{label}</legend>{value.length===0?<small>当前没有项目；请从对应业务草稿入口新增后再在此复核。</small>:value.map((item,index)=>typeof item==='object'&&item!==null?<article key={index}>{Object.entries(item).map(([key,nested])=><Field key={key} fieldKey={key} value={nested} onChange={(next)=>onChange(value.map((entry,position)=>position===index?{...(entry as Record<string,unknown>),[key]:next}:entry))}/>)}</article>:<label key={index}>{label} {index+1}<input value={String(item)} onChange={(event)=>onChange(value.map((entry,position)=>position===index?event.target.value:entry))}/></label>)}</fieldset>
  if(typeof value==='boolean')return <label className="membership-checkbox"><input type="checkbox" checked={value} onChange={(event)=>onChange(event.target.checked)}/>{label}</label>
  if(typeof value==='number')return <label>{label}<input type="number" value={value} onChange={(event)=>onChange(Number(event.target.value))}/></label>
  if(value===null)return <label>{label}<input value="" placeholder="留空" onChange={(event)=>onChange(event.target.value.trim()===''?null:event.target.value)}/></label>
  const options=choices[fieldKey]
  if(options)return <label>{label}<select value={String(value)} onChange={(event)=>onChange(event.target.value)}>{options.map(([option,text])=><option key={option} value={option}>{text}</option>)}</select></label>
  if(fieldKey==='content'||fieldKey==='summary')return <label className="membership-wide">{label}<textarea value={String(value)} onChange={(event)=>onChange(event.target.value)}/></label>
  return <label>{label}<input value={String(value)} onChange={(event)=>onChange(event.target.value)}/></label>
}
const choices:Record<string,readonly (readonly [string,string])[]>={roundingMode:[['floor','向下取整'],['nearest','四舍五入']],eligibleTier:[['member','普通会员'],['silver','银卡'],['gold','金卡']],minimumTier:[['member','普通会员'],['silver','银卡'],['gold','金卡']],revocationPolicy:[['revoke_unreserved','撤回未使用权益'],['protect_until_expiry','保留至到期']],fulfillmentKind:[['product','商品'],['benefit','权益'],['activity','活动'],['service','服务']],status:[['active','启用'],['paused','暂停'],['retired','退役']],stackingMode:[['stackable','可叠加'],['exclusive_highest','同组取最高'],['exclusive_first','同组取最先']],refundPolicy:[['reverse_on_any_refund','任一退款冲回'],['reverse_on_full_refund','全额退款冲回']],triggerKind:[['activity_payment','付款成功'],['activity_check_in','完成签到'],['activity_completion','活动完成']]}
function path(item:{domain:Domain;configurationId?:string;publicId?:string}){return `/api/staff/loyalty/configuration-center/${item.domain}/${encodeURIComponent(item.configurationId??item.publicId??'')}`}
function clone<T>(value:T):T{return structuredClone(value)}
function message(error:unknown,fallback:string){return error instanceof Error?error.message:fallback}
function minor(value:number){return (value/100).toFixed(2)}
