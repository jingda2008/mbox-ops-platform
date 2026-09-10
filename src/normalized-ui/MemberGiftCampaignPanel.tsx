import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {NumberInputWithUnit} from './NumberInputWithUnit'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
import {useConfirmationDialog} from './ConfirmationDialog'
import {CouponRefundReviewPanel} from './CouponRefundReviewPanel'
import './member-gift-campaign-panel.css'
interface Option{id:string;name:string;code:string}
interface Campaign{id:string;code:string;name:string;version:number;status:string;calendar_code:string;calendar_version:number;card_project_name:string|null;created_by_employee_id:string;approved_by_employee_id:string|null;products:Array<{product_id:string;name:string;unit_cost_minor:string}>;rule:{pricingKind:'free'|'fixed_price';fixedPriceMinor:number|null;stackingVersionId:string|null;trigger:string;quantityPerCustomer:number;maximumQuantity:number;maximumDailyQuantity:number;maximumCostMinor:number;maximumDailyCostMinor:number;maximumUnitCostMinor:number;availableFrom:string;availableUntil:string;budgetDateBasis:string;budgetDayStartMinute:number;couponCalendarVersionId:string;audience:{minimumTier:string|null;cardCodes:string[];cardMatch:string;tierAndCards:string}}}
interface Job{id:string;name:string;status:string;quantity:number;customer_reference:string;attempts:number;last_error_code:string|null;estimated_cost_minor:string|null}
type Page<T>={items:T[];nextCursor:string|null}
const names:Record<string,string>={draft:'待审核',approved:'待发布',published:'发放中',stopped:'已停发',pending:'等待发放',blocked:'待补发核对',issued:'已发到券包',cancelled:'已取消',duplicate:'同一客户已领取'}
const errors:Record<string,string>={stacking_policy_closed:'叠加规则已停发，旧券仍保留',campaign_closed:'活动已结束，需另行审批补偿',coupon_calendar_closed:'券规则已停止发放',campaign_quantity_exceeded:'活动份数已达上限',daily_quantity_exceeded:'当日份数已达上限',campaign_cost_exceeded:'活动成本预算不足',daily_cost_exceeded:'当日成本预算不足',unit_cost_exceeded:'单份成本超出上限',audience_changed:'客户当前资格不符合',product_unavailable_or_cost_unknown:'商品停用或成本未核实',delivery_retry_required:'执行未完成，已保留重试任务'}
function Selector({api,kind,multiple,value,onChange,disabled,label}:{api:NormalizedApiClient;kind:string;multiple?:boolean;value:Option[];onChange:(value:Option[])=>void;disabled:boolean;label:string}){
  const [search,setSearch]=useState(''),[rows,setRows]=useState<Option[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const generation=useRef(0);useEffect(()=>()=>{generation.current++},[])
  async function load(more=false){const current=++generation.current;setBusy(true);setError('');try{const query=new URLSearchParams({kind,search,...(more&&cursor?{cursor}:{})});const response=await api.getEndpoint<{data:Page<Option>}>(`/api/staff/member-gifts/options?${query}`);if(current===generation.current){setRows(previous=>more?[...new Map([...previous,...response.data.items].map(r=>[r.id,r])).values()]:response.data.items);setCursor(response.data.nextCursor)}}catch(error){if(current===generation.current)setError(error instanceof Error?error.message:'读取失败，可重试')}finally{if(current===generation.current)setBusy(false)}}
  return <fieldset className="gift-option-picker" disabled={disabled}><legend>{label}</legend><div className="gift-search"><input aria-label={`${label}搜索`} value={search} placeholder={kind==='customers'?'会员号或客户编号（至少2字）':'输入名称或编号'} onChange={event=>{generation.current++;setBusy(false);setSearch(event.target.value);setRows([]);setCursor(null)}}/><button type="button" disabled={busy} onClick={()=>void load()}>查找</button></div>
    {value.length>0&&<div className="gift-selected">{value.map(item=><button type="button" key={item.id} onClick={()=>onChange(value.filter(v=>v.id!==item.id))}>{item.name} · 移除</button>)}</div>}
    <div className="gift-options">{rows.map(item=><button type="button" key={item.id} aria-pressed={value.some(v=>v.id===item.id)} onClick={()=>onChange(multiple?value.some(v=>v.id===item.id)?value.filter(v=>v.id!==item.id):[...value,item]:[item])}>{item.name}<small>{item.code}</small></button>)}</div>
    {cursor&&<button type="button" disabled={busy} onClick={()=>void load(true)}>更多{label}</button>}{error&&<p role="alert">{error}</p>}
  </fieldset>
}
export function MemberGiftCampaignPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const [campaigns,setCampaigns]=useState<Campaign[]>([]),[jobs,setJobs]=useState<Job[]>([]),[campaignCursor,setCampaignCursor]=useState<string|null>(null),[jobCursor,setJobCursor]=useState<string|null>(null)
  const [form,setForm]=useState({pricingKind:'free',fixedPriceMinor:'',code:'',name:'',trigger:'targeted',minimumTier:'member',cardMatch:'any',tierAndCards:'and',quantityPerCustomer:'1',maximumQuantity:'',maximumDailyQuantity:'',maximumCostMinor:'',maximumDailyCostMinor:'',maximumUnitCostMinor:'',budgetDateBasis:'natural',budgetDayStartMinute:'0',availableFrom:'',availableUntil:''})
  const [products,setProducts]=useState<Option[]>([]),[projects,setProjects]=useState<Option[]>([]),[audienceCards,setAudienceCards]=useState<Option[]>([]),[calendars,setCalendars]=useState<Option[]>([]),[customers,setCustomers]=useState<Option[]>([])
  const [stacking,setStacking]=useState<Option[]>([])
  const [target,setTarget]=useState(''),[cycleKey,setCycleKey]=useState(''),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const mounted=useRef(true),operation=useRef(false),generation=useRef(0),{confirmAction}=useConfirmationDialog()
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++}},[])
  const canEdit=auth.permissions.includes('loyalty.configuration.edit'),canPublish=auth.permissions.includes('loyalty.policy.publish')
  if(!auth.permissions.includes('loyalty.configuration.view'))return null
  const path='/api/staff/member-gifts'
  function change(key:keyof typeof form,value:string){setForm(previous=>({...previous,[key]:value}))}
  async function load(kind:'campaigns'|'jobs',more=false){
    if(operation.current)return;operation.current=true;setBusy(true);const current=++generation.current
    const cursor=kind==='campaigns'?campaignCursor:jobCursor
    try{const response=await api.getEndpoint<{data:Page<Campaign>|Page<Job>}>(`${path}/${kind}${more&&cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);if(current!==generation.current)return
      if(kind==='campaigns'){const data=response.data as Page<Campaign>;setCampaigns(previous=>more?[...new Map([...previous,...data.items].map(r=>[r.id,r])).values()]:data.items);setCampaignCursor(data.nextCursor)}
      else{const data=response.data as Page<Job>;setJobs(previous=>more?[...new Map([...previous,...data.items].map(r=>[r.id,r])).values()]:data.items);setJobCursor(data.nextCursor)}
    }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'读取失败，已读记录保留')}
    finally{operation.current=false;if(mounted.current)setBusy(false)}
  }
  async function command(url:string,data:unknown,description:string){
    if(operation.current)return
    if(reason.trim().length<2){setMessage('请填写本次操作原因');return}
    operation.current=true;setBusy(true);setMessage('');const current=generation.current
    try{
      if(!await confirmAction({title:'确认活动操作',description,confirmLabel:'确认执行'})||!mounted.current||generation.current!==current)return
      await executeRecoverableCommand(`${auth.employee.id}:${url}`,data,createIdempotencyKey('member-gift'),key=>api.postEndpoint(url,data,{idempotencyKey:key}))
      if(mounted.current)setMessage('操作已记录。请读取最新活动或任务核对；任务提交不等于已发券或已发送提醒。')
    }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'结果未确认，请读取核对；重试不会重复执行同一操作')}
    finally{operation.current=false;if(mounted.current)setBusy(false)}
  }
  function number(value:string,label:string){if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(`${label}请填写整数`);return Number(value)}
  async function save(){
    try{
      const numeric=Object.fromEntries((['quantityPerCustomer','maximumQuantity','maximumDailyQuantity','maximumCostMinor','maximumDailyCostMinor','maximumUnitCostMinor','budgetDayStartMinute'] as const).map(key=>[key,number(form[key],key)]))
      if(!form.availableFrom||!form.availableUntil||!calendars[0]||!products.length)throw new Error('请填写发放期限并选择券规则和赠品商品')
      const instant=(value:string)=>`${value.length===16?`${value}:00`:value}+08:00`
      const rule={...numeric,pricingKind:form.pricingKind,fixedPriceMinor:form.pricingKind==='fixed_price'?number(form.fixedPriceMinor,'固定兑换价'):null,stackingVersionId:form.pricingKind==='fixed_price'?stacking[0]?.id??null:null,trigger:form.trigger,cardProjectId:form.trigger==='card_entry'?projects[0]?.id??null:null,audience:{minimumTier:form.minimumTier||null,cardCodes:audienceCards.map(c=>c.code),cardMatch:form.cardMatch,tierAndCards:form.tierAndCards},currency:'CNY',budgetDateBasis:form.budgetDateBasis,availableFrom:instant(form.availableFrom),availableUntil:instant(form.availableUntil),couponCalendarVersionId:calendars[0].id,productIds:products.map(p=>p.id)}
      await command(`${path}/campaigns`,{code:form.code,name:form.name,rule,reason},'仅保存不可改写的活动草稿；未审核发布前不发券。预算按最高成本候选商品预留，不是商品售价或营业收入。')
    }catch(error){setMessage(error instanceof Error?error.message:'请核对规则')}
  }
  return <section className="member-gift-panel" aria-label="入卡礼与定向发券"><h3>入卡礼与定向发券</h3><p>卡审核、赠券发放、消息送达分别记录。活动停发不删除已发券；成本未知不自动放行。</p>
    <label>本次操作原因<input value={reason} maxLength={500} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
    {canEdit&&<details><summary>新建活动版本</summary><fieldset disabled={busy}><div className="gift-form-grid">
      <label>活动编号<input value={form.code} maxLength={40} onChange={event=>change('code',event.target.value.toUpperCase())}/></label><label>活动名称<input value={form.name} maxLength={120} onChange={event=>change('name',event.target.value)}/></label>
      <label>券价格方式<select value={form.pricingKind} onChange={event=>change('pricingKind',event.target.value)}><option value="free">免费商品券</option><option value="fixed_price">固定低价兑换券</option></select></label>
      {form.pricingKind==='fixed_price'&&<label>单份固定兑换价<NumberInputWithUnit unit="分" inputMode="numeric" value={form.fixedPriceMinor} onChange={event=>change('fixedPriceMinor',event.target.value)}/></label>}
      <label>发放触发<select value={form.trigger} onChange={event=>change('trigger',event.target.value)}><option value="targeted">员工选定人群后发放</option><option value="card_entry">该卡审核通过后自动赠送</option></select></label>
      <label>最低会员等级<select value={form.minimumTier} onChange={event=>change('minimumTier',event.target.value)}><option value="">仅按兴趣卡筛选</option><option value="member">普通会员及以上</option><option value="silver">银卡及以上</option><option value="gold">金卡及以上</option><option value="black">黑卡</option></select></label>
      <label>多张兴趣卡<select value={form.cardMatch} onChange={event=>change('cardMatch',event.target.value)}><option value="any">任一符合</option><option value="all">全部符合</option></select></label><label>等级与兴趣卡关系<select value={form.tierAndCards} onChange={event=>change('tierAndCards',event.target.value)}><option value="and">同时符合</option><option value="or">任一符合</option></select></label>
      {([['quantityPerCustomer','每人赠送','份'],['maximumQuantity','活动总上限','份'],['maximumDailyQuantity','每日上限','份'],['maximumCostMinor','活动成本预算','分'],['maximumDailyCostMinor','每日成本预算','分'],['maximumUnitCostMinor','单份最高成本','分']] as const).map(([key,label,unit])=><label key={key}>{label}<NumberInputWithUnit unit={unit} aria-label={label} inputMode="numeric" value={form[key]} onChange={event=>change(key,event.target.value)}/></label>)}
      <label>每日预算口径<select value={form.budgetDateBasis} onChange={event=>{change('budgetDateBasis',event.target.value);if(event.target.value==='natural')change('budgetDayStartMinute','0')}}><option value="natural">北京时间自然日</option><option value="business">营业日</option></select></label>
      <label>换日距零点<NumberInputWithUnit unit="分钟" value={form.budgetDayStartMinute} disabled={form.budgetDateBasis==='natural'} onChange={event=>change('budgetDayStartMinute',event.target.value)}/></label>
      <label>发放开始（北京时间）<input type="datetime-local" value={form.availableFrom} onChange={event=>change('availableFrom',event.target.value)}/></label><label>发放截止（北京时间）<input type="datetime-local" value={form.availableUntil} onChange={event=>change('availableUntil',event.target.value)}/></label>
    </div></fieldset>
      {form.trigger==='card_entry'&&<Selector api={api} kind="projects" label="入卡触发项目" value={projects} onChange={setProjects} disabled={busy}/>}
      <Selector api={api} kind="audience-cards" label="目标兴趣卡" multiple value={audienceCards} onChange={setAudienceCards} disabled={busy}/>
      <Selector api={api} kind="products" label="赠品商品池" multiple value={products} onChange={setProducts} disabled={busy}/>
      <Selector api={api} kind="calendars" label="已发布券时间规则" value={calendars} onChange={setCalendars} disabled={busy}/>
      {form.pricingKind==='fixed_price'&&<><Selector api={api} kind="stacking" label="已发布叠加规则" value={stacking} onChange={setStacking} disabled={busy}/><p>填写990分表示指定商品按9.90元兑换，不是减免9.90元。规则与商品池冻结到本活动版本；使用时须经过订单报价，不能走免费赠品核销。</p></>}
      <p>100分 = 1元。活动发放期与券可使用期分别配置；相同活动编号的多个版本共用已发份数和预算。</p><button type="button" disabled={busy} onClick={()=>void save()}>保存活动草稿</button>
    </details>}
    <button type="button" disabled={busy} onClick={()=>void load('campaigns')}>读取活动</button>
    <div className="gift-records">{campaigns.map(c=><article key={c.id}><strong>{c.name} · {names[c.status]}</strong><p>{c.code} · 第{c.version}版 · 每人{c.rule.quantityPerCustomer}份 · 总限{c.rule.maximumQuantity}份 · 成本预算¥{(c.rule.maximumCostMinor/100).toFixed(2)}</p>
      <details><summary>核对完整发放条件</summary><p>{c.rule.pricingKind==='fixed_price'?`固定兑换价：每份¥${((c.rule.fixedPriceMinor??0)/100).toFixed(2)}；叠加规则版本：${c.rule.stackingVersionId}`:'免费商品券：符合规则的商品按零元兑换。'}</p><p>触发：{c.rule.trigger==='card_entry'?'入卡审核通过':'员工定向选人'}；等级：{({member:'普通会员',silver:'银卡',gold:'金卡',black:'黑卡'} as Record<string,string>)[c.rule.audience.minimumTier??'']??'不按等级筛选'}及以上；兴趣卡：{c.rule.audience.cardCodes.join('、')||'不另限'}（{c.rule.audience.cardMatch==='all'?'全部符合':'任一符合'}）；等级和卡：{c.rule.audience.tierAndCards==='and'?'同时符合':'任一符合'}。</p>
        <p>每日{c.rule.maximumDailyQuantity}份；每日成本预算¥{(c.rule.maximumDailyCostMinor/100).toFixed(2)}；单份成本最高¥{(c.rule.maximumUnitCostMinor/100).toFixed(2)}。预算按{c.rule.budgetDateBasis==='natural'?'自然日':'营业日'}计算，距零点{c.rule.budgetDayStartMinute}分钟换日。</p>
        <p>北京时间发放期：{new Date(c.rule.availableFrom).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} 至 {new Date(c.rule.availableUntil).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>
        {c.card_project_name&&<p>入卡项目：{c.card_project_name}</p>}<p>候选赠品：{c.products.map(p=>`${p.name}（保存时成本¥${(Number(p.unit_cost_minor)/100).toFixed(2)}）`).join('、')}</p><p>券规则：{c.calendar_code} · 第{c.calendar_version}版。实际使用日历和次数按该已发布版本；审核前应在券规则管理核对。</p>
      </details><div className="gift-actions">
      {c.status==='draft'&&auth.permissions.includes('loyalty.configuration.approve')&&c.created_by_employee_id!==auth.employee.id&&<button type="button" disabled={busy} onClick={()=>void command(`${path}/campaigns/${c.id}/decision`,{action:'approve',reason},`审核 ${c.name} 的商品范围、预算及时间规则。`)}>审核</button>}
      {c.status==='approved'&&canPublish&&c.created_by_employee_id!==auth.employee.id&&c.approved_by_employee_id!==auth.employee.id&&<button type="button" disabled={busy} onClick={()=>void command(`${path}/campaigns/${c.id}/decision`,{action:'publish',reason},c.rule.trigger==='card_entry'?'发布后，符合活动的入卡审核将自动生成赠券任务。':'发布后，授权人员可以选定符合条件的客户发券。')}>发布</button>}
      {c.status==='published'&&canPublish&&<button type="button" disabled={busy} onClick={()=>void command(`${path}/campaigns/${c.id}/decision`,{action:'stop',reason},'停止新发券，已发券保留，未完成承诺保留供核对。')}>停止发放</button>}
    </div></article>)}</div>{campaignCursor&&<button type="button" disabled={busy} onClick={()=>void load('campaigns',true)}>更多活动</button>}
    {canPublish&&<details><summary>向选定会员发券</summary><fieldset disabled={busy}><label>已发布活动<select value={target} onChange={event=>setTarget(event.target.value)}><option value="">请先读取活动并选择</option>{campaigns.filter(c=>c.status==='published'&&c.rule.trigger==='targeted').map(c=><option key={c.id} value={c.id}>{c.name} · {c.code}</option>)}</select></label><label>发放批次编号<input value={cycleKey} maxLength={100} onChange={event=>setCycleKey(event.target.value)}/></label></fieldset><p>同一活动、同一批次、同一客户只领一次。改变批次意味着允许再次领取，不应用来绕过预算。每批最多50人。</p><Selector api={api} kind="customers" label="目标会员" multiple value={customers} onChange={setCustomers} disabled={busy}/><button type="button" disabled={busy||!target||!cycleKey||!customers.length||customers.length>50} onClick={()=>void command(`${path}/campaigns/${target}/target`,{customerIds:customers.map(c=>c.id),cycleKey,reason},`向选定的 ${customers.length} 名会员提交发券任务；逐笔核对资格和预算。不会自动发送营销消息。`)}>提交发券任务</button></details>}
    <button type="button" disabled={busy} onClick={()=>void load('jobs')}>读取发券任务</button><div className="gift-records">{jobs.map(j=><article key={j.id}><strong>{j.name} · {names[j.status]||'待核实'}</strong><p>{j.customer_reference} · {j.quantity}份 · 已尝试{j.attempts}次</p>{j.last_error_code&&<p>{errors[j.last_error_code]||'请核对发券记录'}</p>}{canPublish&&['pending','blocked'].includes(j.status)&&<div className="gift-actions"><button type="button" disabled={busy} onClick={()=>void command(`${path}/jobs/${j.id}/control`,{action:'retry',reason},'重新排队，仍检查活动状态、资格、成本和预算，不保证即时发出。')}>核对后重试</button><button type="button" disabled={busy} onClick={()=>void command(`${path}/jobs/${j.id}/control`,{action:'cancel',reason},'取消此未发任务并保留原因；如已对客户承诺权益，应先确认补偿安排。')}>取消未发任务</button></div>}</article>)}</div>{jobCursor&&<button type="button" disabled={busy} onClick={()=>void load('jobs',true)}>更多发券任务</button>}
    <CouponRefundReviewPanel api={api} auth={auth}/>
    {message&&<p role="status">{message}</p>}
  </section>
}
