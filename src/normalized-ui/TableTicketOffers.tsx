import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

import {useConfirmationDialog} from './ConfirmationDialog'

const ruleFields=[
  ['organizer','organizer','举办主体'],['seller','seller','售票主体'],['approvalReference','approval_reference','批准文件号或适用依据'],
  ['performers','performers','主要演员或团体'],['durationMinutes','duration_minutes','最低演出时长（分钟）'],['programNote','program_note','最低曲目数及适用说明'],
  ['serviceContact','service_contact','门店客服'],['refundSchedule','refund_schedule','各退票时段、费率或金额、计算基数和售后入口'],
] as const
interface Offer {
  terms:(Record<string,string|number|boolean>&{version:number})|null
  draftAuthor:string|null;creatorId:string; activityStatus:string
  recommendInCommunity:boolean; isOnSale:boolean; ticketTables?:{id:string;code:string}[]; draftTableIds?:string[]|null; rosterConfigured?:boolean; remaining:number; categoryVisible:boolean
  id:string|null
  categoryCode:string|null;categories:{code:string;name:string}[]
  areaId:string; areaName:string; version:number|null; name:string|null
  saleFrom:string|null;saleUntil:string|null;priceMinor:number|null; giftPoints:number|null; visibleFrom:string|null; visibleUntil:string|null
  status:'draft'|'published'|'withdrawn'|null
}
function localTime(value:string|null) {
  if (!value) return ''
  const date=new Date(value)
  return new Date(date.getTime()+8*3600000).toISOString().slice(0,16)
}
export function TableTicketOffers({api,activityId,employeeId,activityUpdatedAt,reviewSummary,initiallyOpen,onPublished,canManage,canPublish,canAssist}:{
  api:NormalizedApiClient;activityId:string;employeeId:string;activityUpdatedAt:string;reviewSummary:string;initiallyOpen:boolean;onPublished:()=>void;canManage:boolean;canPublish:boolean;canAssist:boolean
}) {
  const {confirmAction}=useConfirmationDialog()
  const rulesPanel=useRef<HTMLDetailsElement>(null)
  const [open,setOpen]=useState(initiallyOpen)
  const [areas,setAreas]=useState<Offer[]>([])
  const [selected,setSelected]=useState('')
  const [reload,setReload]=useState(0)
  const [saving,setSaving]=useState(false)
  const [loaded,setLoaded]=useState('')
  const confirmation=useRef<{endpoint:string;message:string}|null>(null)
  const [notice,setNotice]=useState('')
  const [invalidInput,setInvalidInput]=useState('')
  const endpoint='/api/staff/activity-operations/'+encodeURIComponent(activityId)+'/table-tickets'
  const readKey=endpoint+':'+reload
  const busy=saving || loaded!==readKey
  function reloadAfterSave(message:string){
    confirmation.current={endpoint,message}
    setNotice('已保存，正在核对最新版本…')
    setReload(n=>n+1)
  }
  useEffect(()=>{
    if (!open) return
    let active=true
    api.getEndpoint<{data:Offer[]}>(endpoint).then(result=>{
      if (!active) return
      setAreas(result.data)
      setLoaded(readKey)
      if(confirmation.current?.endpoint===endpoint){
        setNotice(confirmation.current.message)
        confirmation.current=null
      }
      setSelected(current=>result.data.some(row=>row.areaId===current)?current:(result.data.find(row=>row.status==='draft')??result.data[0])?.areaId??'')
    }).catch(error=>{
      if(active)setNotice(confirmation.current?.endpoint===endpoint?'已保存，最新版本读取失败。请点「刷新票档」后继续。':error instanceof Error?error.message:'票档读取失败')
    })
    return ()=>{active=false}
  },[api,endpoint,readKey,open])
  const area=areas.find(row=>row.areaId===selected)
  const needsReview=area?.activityStatus==='draft'
  const ownDraft=needsReview && area?.creatorId===employeeId
  const ownsTicketDraft=area?.status==='draft' && area.draftAuthor===employeeId
  const retry=useRef<{body:string;key:string}|null>(null)
  async function save(form:HTMLFormElement,status:'draft'|'published'|'withdrawn') {
    if (!area || busy) return
    const fields=new FormData(form)
    const value=(name:string)=>String(fields.get(name)??'').trim()
    const name=value('name'), yuan=value('price'), points=value('points')
    const draftTableIds=fields.getAll('draftTables').map(String)
    if(status==='draft' && (area.rosterConfigured || area.draftTableIds) && !draftTableIds.length){
      setNotice('请从本区已核对的桌台中至少选择一桌。')
      return
    }
    if(status==='published' && (area.rosterConfigured || area.draftTableIds)){
      setNotice('指定桌台的票档暂只可保存草稿。')
      return
    }
    const invalidField=!name?'name':(!/^\d+(\.\d{1,2})?$/.test(yuan) || Number(yuan)<=0)?'price':
      ((points!=='' && !/^\d+$/.test(points)) || (status==='published' && points===''))?'points':null
    if (invalidField) {
      const input=form.elements.namedItem(invalidField) as HTMLInputElement
      setInvalidInput(invalidField)
      setNotice(invalidField==='points'?'请填写非负整数的赠分，无赠分时填 0。':invalidField==='price'?'请填写有效的每桌售价。':'请填写票名。')
      input.focus()
      return
    }
    const reviewActivity=status==='published' && needsReview
    if (status==='published' && !area.terms) {
      setNotice('请先确认本场公示资料，再发布票档。')
      if(rulesPanel.current){rulesPanel.current.open=true;rulesPanel.current.querySelector('input')?.focus()}
      return
    }
    if (reviewActivity && !await confirmAction({title:'复核场次并发布票档',description:`${reviewSummary}。确认后发布“${name}”，${yuan} 元／桌，每张赠 ${points} 分。`,confirmLabel:'确认复核并发布'})) return
    const instant=(field:string)=>value(field)?new Date(value(field)+':00+08:00').toISOString():null
    const payload={...(status==='draft' && draftTableIds.length?{draftTableIds}:{}),recommendInCommunity:fields.has('recommend'),...(reviewActivity?{reviewActivity,activityUpdatedAt}:{}),
      ...(status==='published' && area.terms?{expectedTermsVersion:area.terms.version}:{}),areaId:area.areaId,expectedVersion:area.version??0,name,priceMinor:Math.round(Number(yuan)*100),
      saleFrom:instant('saleFrom'),saleUntil:instant('saleUntil'),categoryCode:value('category')||null,giftPoints:points===''?null:Number(points),visibleFrom:instant('from'),visibleUntil:instant('until'),status}
    const body=JSON.stringify(payload)
    if (retry.current?.body!==body) retry.current={body,key:'table-ticket-'+crypto.randomUUID()}
    setSaving(true);setNotice('')
    try {
      await api.postEndpoint(endpoint,payload,{idempotencyKey:retry.current.key})
      retry.current=null
      if(reviewActivity)onPublished()
      reloadAfterSave(status==='published'?'票档版本已发布':status==='withdrawn'?'票档已下架':(canPublish?'票档草稿已保存':'草稿已保存，发布人员可在本场核对并上架'))
    } catch(error) {setNotice(error instanceof Error?error.message:'保存失败，可重试')}
    finally {setSaving(false)}
  }
  const [skipDraftIds,setSkipDraftIds]=useState<string[]>([])
  const reviewable=areas.filter(row=>row.status==='draft' && row.draftAuthor!==employeeId && row.id && !row.rosterConfigured && !row.draftTableIds)
  const checked=reviewable.filter(row=>!skipDraftIds.includes(row.id!))
  async function publishBatch(){
    if(busy || ownDraft || !area?.terms || !checked.length)return
    const body={activityUpdatedAt,termsVersion:area.terms.version,drafts:checked.map(row=>({areaId:row.areaId,version:row.version}))}
    if(!await confirmAction({title:'复核并上架门票',description:reviewSummary+'。'+checked.map(row=>row.name+' · '+(row.priceMinor??0)/100+' 元／桌 · 赠 '+row.giftPoints+' 分').join('；'),confirmLabel:'确认上架'}))return
    const identity=JSON.stringify(body)
    if(retry.current?.body!==identity)retry.current={body:identity,key:'ticket-review-'+crypto.randomUUID()}
    setSaving(true);setNotice('')
    try{
      await api.postEndpoint('/api/staff/activity-operations/'+encodeURIComponent(activityId)+'/publish-ticket-drafts',body,{idempotencyKey:retry.current.key})
      retry.current=null
      if(needsReview)onPublished()
      setSkipDraftIds([])
      reloadAfterSave('所选票档已发布，顾客展示及开售时间按各档设置生效。')
    }catch(e){setNotice(e instanceof Error?e.message:'复核结果未读回，可重试原操作')}finally{setSaving(false)}
  }
  const [references,setReferences]=useState<{id:string;title:string;starts_at:string;organizer:string;seller:string;service_contact:string;refund_schedule:string}[]>([])
  const [referenceId,setReferenceId]=useState('')
  const ruleForm=useRef<HTMLFormElement>(null)
  async function loadReferences(){
    try{
      const r=await api.getEndpoint<{data:typeof references}>('/api/staff/activity-operations/ticket-rule-references')
      setReferences(r.data)
      if(!r.data.length)setNotice('本店暂无可沿用的公示，请填写本场资料。')
    }catch(e){setNotice(e instanceof Error?e.message:'无法读取往期公示')}
  }
  function applyReference(id:string){
    setReferenceId(id)
    const source=references.find(row=>row.id===id)
    if(!source || !ruleForm.current)return
    for(const [field,column] of [['organizer','organizer'],['seller','seller'],['serviceContact','service_contact'],['refundSchedule','refund_schedule']] as const){
      const input=ruleForm.current.elements.namedItem(field) as HTMLInputElement
      input.value=source[column]
    }
    setNotice('已带入主体、客服和退票规则；请核实本场适用内容后保存。')
  }
  async function saveRules(form:HTMLFormElement){
    const data=new FormData(form),terms=Object.fromEntries(ruleFields.map(([field])=>[field,field==='durationMinutes'?Number(data.get(field)):data.get(field)]))
    setSaving(true)
    try{
      await api.postEndpoint('/api/staff/activity-operations/'+encodeURIComponent(activityId)+'/table-ticket-terms',
        {...terms,version:area?.terms?.version??0,requiresNamedAttendees:data.get('named')==='yes'},{idempotencyKey:'terms-'+crypto.randomUUID()})
      if(rulesPanel.current)rulesPanel.current.open=false
      reloadAfterSave('场次公示已核实，发布的新票档将使用本版本')
    }catch(e){setNotice(e instanceof Error?e.message:'场次公示保存失败')}finally{setSaving(false)}
  }
  async function assist(form:HTMLFormElement){
    if(!area?.id || busy)return
    const fields=new FormData(form);setSaving(true)
    try{await api.postEndpoint('/api/staff/activity-operations/table-ticket-offers/'+area.id+'/assist',{
      phone:fields.get('phone'),quantity:Number(fields.get('quantity'))},{idempotencyKey:'ticket-assist-'+crypto.randomUUID()})
      form.reset();setNotice('已为该手机号留存选票信息。请客人打开小程序「我的门票」，授权本人手机号后确认付款。')
    }catch(e){setNotice(e instanceof Error?e.message:'代售办理失败')}finally{setSaving(false)}
  }
  return <details open={open} className="ticket-offer-editor" onToggle={event=>{
    if(event.target!==event.currentTarget)return
    setOpen(event.currentTarget.open)
    if(!event.currentTarget.open)setLoaded('')
  }}>
    <summary>整桌门票</summary>
    {open && <>{canPublish && area && <details ref={rulesPanel}><summary>{area.terms?'本场公示资料 · 版本 '+area.terms.version:'首次上架，先核实本场公示资料'}</summary>
      <button type="button" disabled={busy} onClick={()=>void loadReferences()}>从往期公示带入</button>
      {references.length>0 && <label>选择参考场次<select value={referenceId} onChange={e=>applyReference(e.target.value)}><option value="">选择场次</option>{references.map(r=><option value={r.id} key={r.id}>{r.title} · {localTime(r.starts_at).replace('T',' ')}</option>)}</select></label>}
      <form ref={ruleForm} key={area.terms?.version??0} onSubmit={e=>{e.preventDefault();void saveRules(e.currentTarget)}}>
        {ruleFields.map(([field,column,label])=><label key={field}>{label}<input disabled={busy} name={field} required type={field==='durationMinutes'?'number':'text'} defaultValue={String(area.terms?.[column]??'')}/></label>)}
        <label><input disabled={busy} type="checkbox" name="named" value="yes" defaultChecked={area.terms?.requires_named_attendees===true}/>本场要求逐人实名</label>
        <button disabled={busy}>确认资料并保存本场版本</button></form></details>}{canPublish && !ownDraft && reviewable.length>0 && <fieldset><legend>本场待复核票档</legend>
      {reviewable.map(row=><label key={row.id}><input type="checkbox" disabled={busy} checked={!skipDraftIds.includes(row.id!)} onChange={e=>setSkipDraftIds(ids=>e.target.checked?ids.filter(id=>id!==row.id):[...ids,row.id!])}/>
      {row.areaName} · {row.name} · {(row.priceMinor??0)/100} 元／桌 · 赠 {row.giftPoints??'待填写'} 分 · 当前可售 {row.remaining} 桌{row.categoryVisible===false?' · 分类当前隐藏':''}</label>)}
      <button type="button" disabled={busy || !area?.terms || !checked.length} onClick={()=>void publishBatch()}>复核并上架所选票档（{checked.length}）</button>
    </fieldset>}<label>演出桌区<select value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}>
      {areas.map(row=><option key={row.areaId} value={row.areaId}>{row.areaName}</option>)}
    </select></label>{area && !area.rosterConfigured && !area.draftTableIds && <p>原整区流程估算可售 {area.remaining} 桌，与下方草稿指定桌台无关{area.categoryVisible===false?' · 当前分类未对客展示':''}</p>}{area && (canManage || canPublish) && <form key={area.areaId+':'+area.version} onInput={e=>{
      if(invalidInput && (e.target as HTMLInputElement).name===invalidInput){setInvalidInput('');setNotice('')}
    }} onSubmit={e=>{
      e.preventDefault()
      setInvalidInput('')
      const button=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null
      void save(e.currentTarget,button?.value==='published'?'published':button?.value==='withdrawn'?'withdrawn':'draft')
    }}>
      <fieldset><legend>本票档指定桌台（仅草稿）</legend>
        {!area.rosterConfigured && <p>还没有经核对的当期桌号名单，不列出历史桌号。</p>}
        {area.rosterConfigured && !(area.ticketTables??[]).length && <p>本区尚无已核对的可选桌台。</p>}
        {(area.ticketTables??[]).map(table=><label key={table.id}>
          <input type="checkbox" name="draftTables" value={table.id} disabled={busy}
            defaultChecked={area.draftTableIds?.includes(table.id)??false}/>{table.code}
        </label>)}
        {area.draftTableIds?.some(id=>!(area.ticketTables??[]).some(table=>table.id===id)) &&
          <p role="alert">原草稿有桌台已移出当期名单，请重新选择并保存。</p>}
        {(area.rosterConfigured || area.draftTableIds) && <p>桌台范围保存到草稿；在库存、排桌和改期均支持前，不能按此范围上架售卖。</p>}
      </fieldset>
      <label>产品名称<textarea aria-label="产品名称" rows={2} disabled={busy} name="name" required maxLength={120} defaultValue={area.name??area.areaName+'整桌票'}/></label>
      <label>每桌售价（元）<input disabled={busy} required type="number" name="price" min=".01" step=".01" defaultValue={area.priceMinor===null?'':(area.priceMinor/100).toFixed(2)}/></label>
      <label>每张赠送积分<input disabled={busy} type="number" name="points" min="0" step="1" defaultValue={area.giftPoints??''}/></label>
      <label className="ticket-promotion"><input disabled={busy} type="checkbox" name="recommend" defaultChecked={area.recommendInCommunity}/>同时在超嗨推荐</label>
      <details><summary>分类、展示及售卖时间（选填，北京时间）</summary><label>大分类<select disabled={busy} name="category" defaultValue={area.categoryCode??''}><option value="">门票</option>{area.categories.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label><label>开始<input disabled={busy} type="datetime-local" name="from" defaultValue={localTime(area.visibleFrom)}/></label>
      <label>结束<input disabled={busy} type="datetime-local" name="until" defaultValue={localTime(area.visibleUntil)}/></label>
      <label>开售<input disabled={busy} type="datetime-local" name="saleFrom" defaultValue={localTime(area.saleFrom)}/></label><label>停售<input disabled={busy} type="datetime-local" name="saleUntil" defaultValue={localTime(area.saleUntil)}/></label></details>
      {ownDraft && <p>场次由你创建，保存票档草稿后由另一位发布人员复核上架。</p>}
      <div className="ticket-offer-actions">{canManage && <button disabled={busy} value="draft">{canPublish?'保存草稿':'保存并提交复核'}</button>}
      {canPublish && !ownDraft && !ownsTicketDraft && !area.rosterConfigured && !area.draftTableIds && <button disabled={busy} value="published">{needsReview?'复核场次并发布票档':'保存并发布票档'}</button>}
      {canPublish && area.isOnSale && <button disabled={busy} value="withdrawn">下架</button>}</div>
    </form>}{canAssist && area?.status==='published' && <form onSubmit={e=>{e.preventDefault();void assist(e.currentTarget)}}>
      <label>本人手机号<input disabled={busy} name="phone" required pattern="1[3-9][0-9]{9}" inputMode="tel"/></label><label>代选桌数<input disabled={busy} type="number" name="quantity" required min={1} defaultValue={1}/></label>
      <button disabled={busy}>由客人确认购票</button></form>}{notice && <p role="status">{notice}</p>}<button type="button" disabled={saving} onClick={()=>setReload(n=>n+1)}>刷新票档</button></>}
  </details>
}
