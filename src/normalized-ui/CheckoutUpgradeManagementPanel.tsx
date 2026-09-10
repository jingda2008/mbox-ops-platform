import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ChevronDown, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import { loadCompleteActiveCatalog } from './complete-catalog'
import {NumberInputWithUnit} from './NumberInputWithUnit'
import './checkout-upgrade-management-panel.css'

type RuleStatus = 'draft' | 'approved' | 'active' | 'retired'
type CapacityStatus = 'draft' | 'approved' | 'published' | 'retired'

interface ProductOption { id: string; name: string; code: string; productKind: string; status: string }
interface RuleView {
  draftedByEmployeeId?:string|null;approvedByEmployeeId?:string|null
  qualification?:{maximumAddMinor:number;maximumAddBasisPoints:number|null;minimumContributionMinor:number;minimumIncrementalContributionMinor:number;positiveFitReason:string;maximumQuantitiesPerPerson:Array<{productId:string;quantity:number}>;excludedProductIds:string[]}
  id: string; code: string; revision: number; name: string; status: RuleStatus
  sourceProductId: string; sourceProductName: string; targetProductId: string; targetProductName: string
  minimumPartySize: number; maximumPartySize: number; priority: number; offerValidMinutes: number
  minimumGrossMarginBasisPoints: number; promptTitle: string; promptBody: string; callToAction: string
}
interface OutcomeView {
  offerPublicId: string; ruleCode: string; ruleRevision: number; status: string
  targetProductName: string; paymentState: string; paidAmountMinor: number
  refundedAmountMinor: number; complaintCount: number
  eventCounts: { viewed: number; declined: number; accepted: number; converted: number; invalidated: number }
}
interface CapacityWindowView { id: string; startsAt: string; endsAt: string; capacityLimitUnits: number; usedUnits: number }
interface CapacityView {
  id: string; stationCode: 'bar' | 'kitchen' | 'cashier'; policyVersion: number
  status: CapacityStatus; reason: string; windows: CapacityWindowView[]
}
interface CapacityWindowDraft { key: string; startsAt: string; endsAt: string; capacityLimitUnits: string }

export function CheckoutUpgradeManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const canViewRules = auth.permissions.includes('checkout.upgrade.rule.view')
  const canViewCapacity = auth.permissions.includes('fulfillment.capacity.view')
  const canView = canViewRules || canViewCapacity
  const canDraftRule = auth.permissions.includes('checkout.upgrade.rule.draft')
  const canApproveRule = auth.permissions.includes('checkout.upgrade.rule.approve')
  const canPublishRule = auth.permissions.includes('checkout.upgrade.rule.publish')
  const canDraftCapacity = auth.permissions.includes('fulfillment.capacity.draft')
  const canApproveCapacity = auth.permissions.includes('fulfillment.capacity.approve')
  const canPublishCapacity = auth.permissions.includes('fulfillment.capacity.publish')
  const [expanded, setExpanded] = useState(false)
  const [rules, setRules] = useState<RuleView[]>([])
  const [outcomes, setOutcomes] = useState<OutcomeView[]>([])
  const [capacities, setCapacities] = useState<CapacityView[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [rule, setRule] = useState({
    code:'',name:'',sourceProductId:'',targetProductId:'',minimumPartySize:'2',maximumPartySize:'8',
    occasionTags:'friends',alcoholPreferenceTags:'mixed',promptTitle:'升级今晚体验',
    promptBody:'将当前单品升级为更完整的套餐体验',callToAction:'查看升级',priority:'100',
    offerValidMinutes:'10',minimumGrossMarginBasisPoints:'1500',
  })
  const [capacity, setCapacity] = useState<{ stationCode:'bar'|'kitchen'|'cashier'; reason:string; windows:CapacityWindowDraft[] }>({
    stationCode:'bar',reason:'',windows:[emptyWindow()],
  })
  const [qualification,setQualification]=useState({maximumAddMinor:'',maximumAddBasisPoints:'',minimumContributionMinor:'',minimumIncrementalContributionMinor:'',positiveFitReason:''})
  const [portionLimits,setPortionLimits]=useState<Array<{productId:string;quantity:number}>>([]),[excludedProducts,setExcludedProducts]=useState<string[]>([])
  const [limitProduct,setLimitProduct]=useState(''),[limitQuantity,setLimitQuantity]=useState('1')

  const load = useCallback(async () => {
    setBusy('load'); setNotice('')
    try {
      const [ruleResponse,outcomeResponse,capacityResponse,productResponse] = await Promise.all([
        canViewRules ? api.getEndpoint<{ data:RuleView[] }>('/api/staff/customer-experience/checkout-upgrade-rules') : Promise.resolve({data:[]}),
        canViewRules ? api.getEndpoint<{ data:OutcomeView[] }>('/api/staff/customer-experience/checkout-upgrade-outcomes') : Promise.resolve({data:[]}),
        canViewCapacity ? api.getEndpoint<{ data:CapacityView[] }>('/api/staff/customer-experience/fulfillment-capacity-policies') : Promise.resolve({data:[]}),
        canDraftRule ? loadCompleteActiveCatalog(api).then((data) => ({data})) : Promise.resolve({data:[]}),
      ])
      const loadedProducts = productOptions(productResponse.data)
      setRules(ruleResponse.data); setOutcomes(outcomeResponse.data); setCapacities(capacityResponse.data); setProducts(loadedProducts)
      setRule((current) => ({
        ...current,
        sourceProductId:current.sourceProductId || loadedProducts.find((item)=>item.productKind==='single')?.id || '',
        targetProductId:current.targetProductId || loadedProducts.find((item)=>item.productKind==='bundle')?.id || '',
      }))
    } catch (error) { setNotice(message(error,'升级与产能配置暂时无法读取')) }
    finally { setBusy('') }
  }, [api, canDraftRule, canViewCapacity, canViewRules])

  useEffect(() => { if (expanded) void load() }, [expanded, load])

  const summary = useMemo(() => ({
    accepted:outcomes.reduce((sum,item)=>sum+item.eventCounts.accepted,0),
    converted:outcomes.reduce((sum,item)=>sum+item.eventCounts.converted,0),
    paid:outcomes.filter((item)=>item.paymentState==='paid').length,
    complaints:outcomes.reduce((sum,item)=>sum+item.complaintCount,0),
  }), [outcomes])

  if (!canView && !canDraftRule && !canDraftCapacity) return null

  async function saveRule(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy('rule-draft'); setNotice('')
    try {
      const code = rule.code.trim().toUpperCase()
      if(!portionLimits.length)throw new Error('请明确每种新增商品的人均份量上限')
      await api.putEndpoint(`/api/staff/customer-experience/checkout-upgrade-rules/${encodeURIComponent(code)}`, {
        qualification:{maximumAddMinor:number(qualification.maximumAddMinor,'最多加价',0),maximumAddBasisPoints:qualification.maximumAddBasisPoints.trim()?number(qualification.maximumAddBasisPoints,'相对加价上限',0):null,
          minimumContributionMinor:number(qualification.minimumContributionMinor,'升级后最低贡献额',0),minimumIncrementalContributionMinor:number(qualification.minimumIncrementalContributionMinor,'最低新增贡献额',0),positiveFitReason:qualification.positiveFitReason.trim(),maximumQuantitiesPerPerson:portionLimits,excludedProductIds:excludedProducts},
        name:rule.name.trim(),sourceProductId:rule.sourceProductId,targetProductId:rule.targetProductId,
        minimumPartySize:number(rule.minimumPartySize,'最少人数',1),maximumPartySize:number(rule.maximumPartySize,'最多人数',1),
        occasionTags:tags(rule.occasionTags),alcoholPreferenceTags:tags(rule.alcoholPreferenceTags),
        promptTitle:rule.promptTitle.trim(),promptBody:rule.promptBody.trim(),callToAction:rule.callToAction.trim(),
        priority:number(rule.priority,'优先级',0),offerValidMinutes:number(rule.offerValidMinutes,'报价有效分钟',2),
        minimumGrossMarginBasisPoints:number(rule.minimumGrossMarginBasisPoints,'最低毛利基点',0),status:'draft',
      }, { idempotencyKey:operationKey('checkout-rule-draft') })
      setNotice('规则草稿已保存。须由另一人审批、第三人发布；保存草稿不会开启升级推荐。'); await load()
    } catch (error) { setNotice(message(error,'规则草稿没有保存')) }
    finally { setBusy('') }
  }

  async function ruleAction(item: RuleView, action:'approve'|'publish'|'rollback-draft') {
    const reason = (await promptAction({
      title: action==='approve' ? '审批升级规则' : action==='publish' ? '发布升级规则' : '复制回滚草稿',
      description: action==='approve' ? '填写审批依据后继续。' : action==='publish' ? '填写发布依据后继续。' : '填写回滚原因后继续。',
      label: action==='approve' ? '审批依据' : action==='publish' ? '发布依据' : '回滚原因',
      confirmLabel: action==='approve' ? '确认审批' : action==='publish' ? '确认发布' : '创建草稿',
    }))?.trim() || ''
    if (reason.length<2 || busy) return
    setBusy(`${item.id}:${action}`); setNotice('')
    try {
      const endpoint = action==='approve'
        ? `/api/staff/customer-experience/checkout-upgrade-rules/${encodeURIComponent(item.code)}/approve`
        : `/api/staff/customer-experience/checkout-upgrade-rule-versions/${encodeURIComponent(item.id)}/${action}`
      await api.postEndpoint(endpoint,{reason},{idempotencyKey:operationKey(`checkout-rule-${action}`)})
      setNotice(action==='approve'?'审批完成，仍需第三人发布。':action==='publish'?'新规则版本已发布；此操作不改变升级功能开关。':'已从历史版本复制新草稿，不会覆盖当前版本。')
      await load()
    } catch (error) { setNotice(message(error,'规则操作没有完成')) }
    finally { setBusy('') }
  }

  async function saveCapacity(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy('capacity-draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/customer-experience/fulfillment-capacity-policies', {
        stationCode:capacity.stationCode,reason:capacity.reason.trim(),windows:capacity.windows.map((item)=>({
          startsAt:localIso(item.startsAt,'开始时间'),endsAt:localIso(item.endsAt,'结束时间'),
          capacityLimitUnits:number(item.capacityLimitUnits,'产能上限',1),
        })),
      }, { idempotencyKey:operationKey('fulfillment-capacity-draft') })
      setNotice('产能草稿已保存。须由另一人审批、第三人发布后才成为运行事实。'); await load()
    } catch (error) { setNotice(message(error,'产能草稿没有保存')) }
    finally { setBusy('') }
  }

  async function capacityAction(item:CapacityView, action:'approve'|'publish') {
    const reason = (await promptAction({
      title: action==='approve' ? '审批产能版本' : '发布产能版本',
      description: action==='approve' ? '填写产能审批依据后继续。' : '填写产能发布依据后继续。',
      label: action==='approve' ? '审批依据' : '发布依据',
      confirmLabel: action==='approve' ? '确认审批' : '确认发布',
    }))?.trim() || ''
    if (reason.length<2 || busy) return
    setBusy(`${item.id}:${action}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/customer-experience/fulfillment-capacity-policies/${encodeURIComponent(item.id)}/${action}`,
        {reason},{idempotencyKey:operationKey(`fulfillment-capacity-${action}`)})
      setNotice(action==='approve'?'产能版本已审批，仍需第三人发布。':'产能版本已发布。'); await load()
    } catch (error) { setNotice(message(error,'产能操作没有完成')) }
    finally { setBusy('') }
  }

  return <section className="checkout-upgrade-management" aria-label="付款前升级与履约产能配置">
    <header><div><strong>付款前升级与产能</strong><small>规则、报价、成交和出品上限统一管理；三人分离发布，功能默认关闭。</small></div><button type="button" aria-expanded={expanded} onClick={()=>setExpanded((value)=>!value)}>{expanded?'收起':'配置'}<ChevronDown size={17}/></button></header>
    {expanded && <div className="checkout-upgrade-content">
      {notice && <p className="checkout-upgrade-notice" role="status">{notice}</p>}
      <div className="checkout-upgrade-toolbar"><span>建议 {outcomes.length} · 已接受 {summary.accepted} · 已提交 {summary.converted} · 已付款 {summary.paid} · 投诉 {summary.complaints}</span><button type="button" disabled={busy==='load'} onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div>
      <p>统计最近300次建议，生成建议不等于顾客已看到；接受后删除该份套餐不计提交。付款与退款为关联订单口径，不代表升级带来的增量收入；已付款包含后来退款的订单。</p>
      {canDraftRule && <details><summary>新建规则草稿</summary><form className="checkout-upgrade-form" onSubmit={(event)=>void saveRule(event)}>
        <label>规则代码<input required pattern={'[A-Z][A-Z0-9_\\-]{2,63}'} value={rule.code} onChange={(event)=>setRule({...rule,code:event.target.value.toUpperCase()})}/></label>
        <label>规则名称<input required minLength={2} maxLength={80} value={rule.name} onChange={(event)=>setRule({...rule,name:event.target.value})}/></label>
        <label>原商品<select aria-label="原商品" required value={rule.sourceProductId} onChange={(event)=>setRule({...rule,sourceProductId:event.target.value})}>{products.filter((item)=>item.productKind==='single'||item.productKind==='bundle').map((item)=><option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
        <label>升级套餐<select aria-label="升级套餐" required value={rule.targetProductId} onChange={(event)=>setRule({...rule,targetProductId:event.target.value})}>{products.filter((item)=>item.productKind==='bundle').map((item)=><option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
        <label>人数范围<div className="inline-fields"><input type="number" min={1} max={200} value={rule.minimumPartySize} onChange={(event)=>setRule({...rule,minimumPartySize:event.target.value})}/><span>至</span><input type="number" min={1} max={200} value={rule.maximumPartySize} onChange={(event)=>setRule({...rule,maximumPartySize:event.target.value})}/></div></label>
        <label>优先级<input type="number" min={0} max={10000} value={rule.priority} onChange={(event)=>setRule({...rule,priority:event.target.value})}/></label>
        <label>报价有效分钟<input type="number" min={2} max={30} value={rule.offerValidMinutes} onChange={(event)=>setRule({...rule,offerValidMinutes:event.target.value})}/></label>
        <label>最低毛利（基点）<input type="number" min={0} max={9999} value={rule.minimumGrossMarginBasisPoints} onChange={(event)=>setRule({...rule,minimumGrossMarginBasisPoints:event.target.value})}/></label>
        <label>场景标签<input value={rule.occasionTags} onChange={(event)=>setRule({...rule,occasionTags:event.target.value})} placeholder="friends,birthday"/></label>
        <label>酒水标签<input value={rule.alcoholPreferenceTags} onChange={(event)=>setRule({...rule,alcoholPreferenceTags:event.target.value})} placeholder="mixed,whisky"/></label>
        <label className="wide">顾客标题<input required value={rule.promptTitle} onChange={(event)=>setRule({...rule,promptTitle:event.target.value})}/></label>
        <label className="wide">顾客说明<textarea required rows={2} value={rule.promptBody} onChange={(event)=>setRule({...rule,promptBody:event.target.value})}/></label>
        <label>确认按钮<input required value={rule.callToAction} onChange={(event)=>setRule({...rule,callToAction:event.target.value})}/></label>
        <fieldset className="wide upgrade-qualification-fields"><legend>高度匹配准入条件</legend>
          <p>先满足全部条件，再按优先级排序。贡献额为成交额减商品成本，不是扣除房租工资后的净利润；未填写、成本未知或不适配时不能主动推荐。</p>
          <label>最多加价<NumberInputWithUnit required inputMode="numeric" unit="分" min={0} step={1} value={qualification.maximumAddMinor} onChange={event=>setQualification({...qualification,maximumAddMinor:event.target.value})}/></label>
          <label>相对加价上限（可留空，仅用绝对上限）<NumberInputWithUnit inputMode="numeric" unit="万分比" min={0} max={1000000} step={1} value={qualification.maximumAddBasisPoints} onChange={event=>setQualification({...qualification,maximumAddBasisPoints:event.target.value})}/></label>
          <label>升级后最低贡献额<NumberInputWithUnit required inputMode="numeric" unit="分" min={0} step={1} value={qualification.minimumContributionMinor} onChange={event=>setQualification({...qualification,minimumContributionMinor:event.target.value})}/></label>
          <label>最低新增贡献额<NumberInputWithUnit required inputMode="numeric" unit="分" min={0} step={1} value={qualification.minimumIncrementalContributionMinor} onChange={event=>setQualification({...qualification,minimumIncrementalContributionMinor:event.target.value})}/></label>
          <label>适配依据<textarea required minLength={2} maxLength={500} value={qualification.positiveFitReason} onChange={event=>setQualification({...qualification,positiveFitReason:event.target.value})} placeholder="说明保留什么、增加什么，以及为什么适合此人数和场景"/></label>
          <label>新增商品<select aria-label="份量上限商品" value={limitProduct} onChange={event=>setLimitProduct(event.target.value)}><option value="">选择需要限定份量的商品</option>{products.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>该商品每人最多<NumberInputWithUnit inputMode="numeric" unit="份 / 人" min={1} max={100} step={1} value={limitQuantity} onChange={event=>setLimitQuantity(event.target.value)}/></label>
          <button type="button" disabled={!limitProduct||!limitQuantity.trim()||!Number.isInteger(Number(limitQuantity))||Number(limitQuantity)<1||Number(limitQuantity)>100} onClick={()=>setPortionLimits(previous=>[...previous.filter(item=>item.productId!==limitProduct),{productId:limitProduct,quantity:Number(limitQuantity)}])}>保存此份量上限</button>
          {portionLimits.map(item=><div className="upgrade-qualification-entry" key={item.productId}><span>{products.find(product=>product.id===item.productId)?.name??item.productId} · {item.quantity}份 / 人</span><button type="button" onClick={()=>setPortionLimits(previous=>previous.filter(value=>value.productId!==item.productId))}>移除</button></div>)}
          <label>出现以下商品时不推荐<select aria-label="排除商品" value="" onChange={event=>{if(event.target.value)setExcludedProducts(previous=>[...new Set([...previous,event.target.value])])}}><option value="">按需添加排除商品</option>{products.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          {excludedProducts.map(id=><div className="upgrade-qualification-entry" key={id}><span>{products.find(product=>product.id===id)?.name??id}</span><button type="button" onClick={()=>setExcludedProducts(previous=>previous.filter(value=>value!==id))}>移除排除商品</button></div>)}
        </fieldset>
        <button type="submit" disabled={busy==='rule-draft'}>保存草稿</button>
      </form></details>}
      <div className="checkout-rule-list">{rules.map((item)=><article key={item.id}>
        <div><strong>{item.name}</strong><small>{item.code} · V{item.revision} · {status(item.status)}</small>
          <span>{item.sourceProductName} → {item.targetProductName} · {item.minimumPartySize}–{item.maximumPartySize}人</span>
          {item.qualification?<details className="upgrade-qualification-review"><summary>核对高度匹配条件</summary>
            <p>{item.qualification.positiveFitReason}</p>
            <p>最多加价 ¥{(item.qualification.maximumAddMinor/100).toFixed(2)}；相对上限 {item.qualification.maximumAddBasisPoints===null?'未另设':`${item.qualification.maximumAddBasisPoints/100}%`}。</p>
            <p>最低贡献额 ¥{(item.qualification.minimumContributionMinor/100).toFixed(2)}；最低新增贡献额 ¥{(item.qualification.minimumIncrementalContributionMinor/100).toFixed(2)}。</p>
            <p>人均上限：{item.qualification.maximumQuantitiesPerPerson.map(limit=>`${products.find(product=>product.id===limit.productId)?.name??limit.productId} ${limit.quantity}份/人`).join('；')}</p>
            <p>排除商品：{item.qualification.excludedProductIds.map(id=>products.find(product=>product.id===id)?.name??id).join('、')||'未另设'}。核心酒水和具体选择仍必须保留，不因没有排除商品而放宽。</p>
          </details>:<small>旧版本未配置新准入条件，须建立完整新草稿再验收。</small>}
        </div>
        <div>{item.status==='draft'&&canApproveRule&&item.draftedByEmployeeId!==auth.employee.id&&<button type="button" onClick={()=>void ruleAction(item,'approve')}>审批</button>}{item.status==='approved'&&canPublishRule&&item.draftedByEmployeeId!==auth.employee.id&&item.approvedByEmployeeId!==auth.employee.id&&<button type="button" onClick={()=>void ruleAction(item,'publish')}>发布</button>}{item.status==='retired'&&canPublishRule&&<button type="button" onClick={()=>void ruleAction(item,'rollback-draft')}>复制为回滚草稿</button>}</div>
      </article>)}</div>
      {canDraftCapacity && <details><summary>新建产能版本</summary><form className="checkout-capacity-form" onSubmit={(event)=>void saveCapacity(event)}>
        <label>出品站点<select value={capacity.stationCode} onChange={(event)=>setCapacity({...capacity,stationCode:event.target.value as typeof capacity.stationCode})}><option value="bar">吧台</option><option value="kitchen">厨房</option><option value="cashier">收银</option></select></label>
        <label>配置原因<input required minLength={2} maxLength={240} value={capacity.reason} onChange={(event)=>setCapacity({...capacity,reason:event.target.value})}/></label>
        <div className="capacity-window-list">{capacity.windows.map((item,index)=><div key={item.key}><label>开始<input required type="datetime-local" value={item.startsAt} onChange={(event)=>setCapacity({...capacity,windows:replaceWindow(capacity.windows,index,{...item,startsAt:event.target.value})})}/></label><label>结束<input required type="datetime-local" value={item.endsAt} onChange={(event)=>setCapacity({...capacity,windows:replaceWindow(capacity.windows,index,{...item,endsAt:event.target.value})})}/></label><label>上限单位<input required type="number" min={1} max={1000000} value={item.capacityLimitUnits} onChange={(event)=>setCapacity({...capacity,windows:replaceWindow(capacity.windows,index,{...item,capacityLimitUnits:event.target.value})})}/></label>{capacity.windows.length>1&&<button type="button" aria-label="删除时间窗" onClick={()=>setCapacity({...capacity,windows:capacity.windows.filter((_,position)=>position!==index)})}><Trash2 size={16}/></button>}</div>)}</div>
        <div className="capacity-actions"><button type="button" onClick={()=>setCapacity({...capacity,windows:[...capacity.windows,emptyWindow()]})}><Plus size={15}/>增加时间窗</button><button type="submit" disabled={busy==='capacity-draft'}>保存产能草稿</button></div>
      </form></details>}
      <div className="capacity-policy-list">{capacities.map((item)=><article key={item.id}><div><strong>{station(item.stationCode)} · V{item.policyVersion}</strong><small>{status(item.status)} · {item.reason}</small><span>{item.windows.length}个时段 · 占用 {item.windows.reduce((sum,window)=>sum+window.usedUnits,0)} 单位</span></div><div>{item.status==='draft'&&canApproveCapacity&&<button type="button" onClick={()=>void capacityAction(item,'approve')}>审批</button>}{item.status==='approved'&&canPublishCapacity&&<button type="button" onClick={()=>void capacityAction(item,'publish')}>发布</button>}</div></article>)}</div>
      <p className="checkout-upgrade-safety">规则、出品产能、库存与整笔下单验收通过后才可启用付款前升级；保存或发布规则不会改变功能开关。</p>
    </div>}
  </section>
}

function productOptions(value:unknown):ProductOption[] {
  const rows = Array.isArray(value)?value:typeof value==='object'&&value!==null&&Array.isArray((value as {products?:unknown}).products)?(value as {products:unknown[]}).products:[]
  return rows.flatMap((row)=>typeof row==='object'&&row!==null&&typeof (row as {id?:unknown}).id==='string'&&typeof (row as {name?:unknown}).name==='string'?[{
    id:(row as {id:string}).id,name:(row as {name:string}).name,code:String((row as {code?:unknown}).code||''),productKind:String((row as {productKind?:unknown}).productKind||'single'),status:String((row as {status?:unknown}).status||'active'),
  }]:[]).filter((item)=>item.status==='active')
}
function emptyWindow():CapacityWindowDraft { return {key:crypto.randomUUID(),startsAt:'',endsAt:'',capacityLimitUnits:'40'} }
function replaceWindow(rows:CapacityWindowDraft[],index:number,row:CapacityWindowDraft) { return rows.map((item,position)=>position===index?row:item) }
function number(value:string,label:string,min:number) { const result=Number(value); if(!value.trim()||!Number.isSafeInteger(result)||result<min) throw new Error(`${label}须填写有效整数`); return result }
function tags(value:string) { return [...new Set(value.split(',').map((item)=>item.trim()).filter(Boolean))] }
function localIso(value:string,label:string) { const parsed=Date.parse(value); if(!Number.isFinite(parsed)) throw new Error(`${label}不正确`); return new Date(parsed).toISOString() }
function operationKey(prefix:string) { return `${prefix}-${crypto.randomUUID()}` }
function message(error:unknown,fallback:string) { return error instanceof Error?error.message:fallback }
function status(value:string) { return ({draft:'草稿',approved:'已审批',active:'已发布',published:'已发布',retired:'已退役'} as Record<string,string>)[value]||value }
function station(value:string) { return ({bar:'吧台',kitchen:'厨房',cashier:'收银'} as Record<string,string>)[value]||value }
