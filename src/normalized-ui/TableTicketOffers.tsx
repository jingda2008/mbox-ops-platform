import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

const ruleFields=[
  ['organizer','organizer','举办主体'],['seller','seller','售票主体'],['approvalReference','approval_reference','批准文件号或适用依据'],
  ['performers','performers','主要演员或团体'],['durationMinutes','duration_minutes','最低演出时长（分钟）'],['programNote','program_note','最低曲目数及适用说明'],
  ['serviceContact','service_contact','门店客服'],['refundSchedule','refund_schedule','各退票时段、费率或金额、计算基数和售后入口'],
] as const
interface Offer {
  terms:(Record<string,string|number|boolean>&{version:number})|null
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
export function TableTicketOffers({api,activityId,canManage,canPublish,canAssist}:{
  api:NormalizedApiClient;activityId:string;canManage:boolean;canPublish:boolean;canAssist:boolean
}) {
  const [open,setOpen]=useState(false)
  const [areas,setAreas]=useState<Offer[]>([])
  const [selected,setSelected]=useState('')
  const [reload,setReload]=useState(0)
  const [saving,setSaving]=useState(false)
  const [loaded,setLoaded]=useState('')
  const confirmation=useRef<{endpoint:string;message:string}|null>(null)
  const [notice,setNotice]=useState('')
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
      setSelected(current=>result.data.some(row=>row.areaId===current)?current:result.data[0]?.areaId??'')
    }).catch(error=>{
      if(active)setNotice(confirmation.current?.endpoint===endpoint?'已保存，最新版本读取失败。请点「刷新票档」后继续。':error instanceof Error?error.message:'票档读取失败')
    })
    return ()=>{active=false}
  },[api,endpoint,readKey,open])
  const area=areas.find(row=>row.areaId===selected)
  const retry=useRef<{body:string;key:string}|null>(null)
  async function save(form:HTMLFormElement,status:'draft'|'published'|'withdrawn') {
    if (!area || busy) return
    const fields=new FormData(form)
    const value=(name:string)=>String(fields.get(name)??'').trim()
    const name=value('name'), yuan=value('price'), points=value('points')
    const invalidField=!name?'name':(!/^\d+(\.\d{1,2})?$/.test(yuan) || Number(yuan)<=0)?'price':
      ((points!=='' && !/^\d+$/.test(points)) || (status==='published' && points===''))?'points':null
    if (invalidField) {
      const input=form.elements.namedItem(invalidField) as HTMLInputElement
      setNotice(invalidField==='points'?'请填写非负整数的赠分，无赠分时填 0。':invalidField==='price'?'请填写有效的每桌售价。':'请填写票名。')
      input.focus()
      return
    }
    const instant=(field:string)=>value(field)?new Date(value(field)+':00+08:00').toISOString():null
    const payload={areaId:area.areaId,expectedVersion:area.version??0,name,priceMinor:Math.round(Number(yuan)*100),
      saleFrom:instant('saleFrom'),saleUntil:instant('saleUntil'),categoryCode:value('category')||null,giftPoints:points===''?null:Number(points),visibleFrom:instant('from'),visibleUntil:instant('until'),status}
    const body=JSON.stringify(payload)
    if (retry.current?.body!==body) retry.current={body,key:'table-ticket-'+crypto.randomUUID()}
    setSaving(true);setNotice('')
    try {
      await api.postEndpoint(endpoint,payload,{idempotencyKey:retry.current.key})
      retry.current=null
      reloadAfterSave(status==='published'?'票档版本已发布':status==='withdrawn'?'票档已下架':(canPublish?'票档草稿已保存':'草稿已保存，发布人员可在本场核对并上架'))
    } catch(error) {setNotice(error instanceof Error?error.message:'保存失败，可重试')}
    finally {setSaving(false)}
  }
  async function saveRules(form:HTMLFormElement){
    const data=new FormData(form),terms=Object.fromEntries(ruleFields.map(([field])=>[field,field==='durationMinutes'?Number(data.get(field)):data.get(field)]))
    setSaving(true)
    try{
      await api.postEndpoint('/api/staff/activity-operations/'+encodeURIComponent(activityId)+'/table-ticket-terms',
        {...terms,version:area?.terms?.version??0,requiresNamedAttendees:data.get('named')==='yes'},{idempotencyKey:'terms-'+crypto.randomUUID()})
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
  return <details onToggle={event=>{
    if(event.target!==event.currentTarget)return
    setOpen(event.currentTarget.open)
    if(!event.currentTarget.open)setLoaded('')
  }}>
    <summary>整桌门票</summary>
    {open && <>{canPublish && area && <details><summary>{area.terms?'本场公示资料 · 版本 '+area.terms.version:'首次上架，先核实本场公示资料'}</summary>
      <form key={area.terms?.version??0} onSubmit={e=>{e.preventDefault();void saveRules(e.currentTarget)}}>
        {ruleFields.map(([field,column,label])=><label key={field}>{label}<input disabled={busy} name={field} required type={field==='durationMinutes'?'number':'text'} defaultValue={String(area.terms?.[column]??'')}/></label>)}
        <label><input disabled={busy} type="checkbox" name="named" value="yes" defaultChecked={area.terms?.requires_named_attendees===true}/>本场要求逐人实名</label>
        <button disabled={busy}>确认资料并保存本场版本</button></form></details>}<label>演出桌区<select value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}>
      {areas.map(row=><option key={row.areaId} value={row.areaId}>{row.areaName}</option>)}
    </select></label>{area && (canManage || canPublish) && <form key={area.areaId+':'+area.version} onSubmit={e=>{
      e.preventDefault()
      const button=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null
      void save(e.currentTarget,button?.value==='published'?'published':button?.value==='withdrawn'?'withdrawn':'draft')
    }}>
      <label>产品名称<input disabled={busy} name="name" required maxLength={120} defaultValue={area.name??area.areaName+'整桌票'}/></label>
      <label>每桌售价（元）<input disabled={busy} required type="number" name="price" min=".01" step=".01" defaultValue={area.priceMinor===null?'':(area.priceMinor/100).toFixed(2)}/></label>
      <label>每张赠送积分<input disabled={busy} type="number" name="points" min="0" step="1" defaultValue={area.giftPoints??''}/></label>
      <details><summary>分类、展示及售卖时间（选填，北京时间）</summary><label>大分类<select disabled={busy} name="category" defaultValue={area.categoryCode??''}><option value="">门票</option>{area.categories.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label><label>开始<input disabled={busy} type="datetime-local" name="from" defaultValue={localTime(area.visibleFrom)}/></label>
      <label>结束<input disabled={busy} type="datetime-local" name="until" defaultValue={localTime(area.visibleUntil)}/></label>
      <label>开售<input disabled={busy} type="datetime-local" name="saleFrom" defaultValue={localTime(area.saleFrom)}/></label><label>停售<input disabled={busy} type="datetime-local" name="saleUntil" defaultValue={localTime(area.saleUntil)}/></label></details>
      {canManage && <button disabled={busy} value="draft">{canPublish?'保存草稿':'保存并提交复核'}</button>}
      {canPublish && <button disabled={busy} value="published">保存并发布票档</button>}
      {canPublish && area.version!==null && <button disabled={busy} value="withdrawn">下架</button>}
    </form>}{canAssist && area?.status==='published' && <form onSubmit={e=>{e.preventDefault();void assist(e.currentTarget)}}>
      <label>本人手机号<input disabled={busy} name="phone" required pattern="1[3-9][0-9]{9}" inputMode="tel"/></label><label>代选桌数<input disabled={busy} type="number" name="quantity" required min={1} defaultValue={1}/></label>
      <button disabled={busy}>由客人确认购票</button></form>}{notice && <p role="status">{notice}</p>}<button type="button" disabled={saving} onClick={()=>setReload(n=>n+1)}>刷新票档</button></>}
  </details>
}
