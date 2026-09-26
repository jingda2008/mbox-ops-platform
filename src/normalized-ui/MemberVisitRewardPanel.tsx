import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import type { MemberVisitRewardRequest, MemberVisitRewardRule } from '../shared/member-visit-reward'
import { useConfirmationDialog } from './ConfirmationDialog'
import { executeRecoverableCommand } from './recoverable-command'
import { createIdempotencyKey } from './cashier-mutation'

type Campaign={id:string;name:string;status:string;products:Array<{name:string}>;rule:{trigger:string;pricingKind:string;dessertProductId?:string|null;quantityPerCustomer:number}}
type Page={businessDate:string;rules:MemberVisitRewardRule[];items:MemberVisitRewardRequest[];nextCursor:string|null}
const states:Record<string,string>={pending:'待审批',issued:'已发券',rejected:'已驳回',invalid:'签到撤回，已作废'}
export function MemberVisitRewardPanel({api,auth,campaigns}:{api:NormalizedApiClient;auth:StaffAuthView;campaigns:Campaign[]}){
  const [data,setData]=useState<Page|null>(null),[date,setDate]=useState(''),[status,setStatus]=useState('pending'),[selected,setSelected]=useState<string[]>([])
  const [campaign,setCampaign]=useState(''),[threshold,setThreshold]=useState('3'),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const active=useRef(true),operation=useRef(false),generation=useRef(0),{confirmAction}=useConfirmationDialog()
  useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++}},[])
  const canConfigure=auth.permissions.includes('loyalty.policy.publish')
  const canApprove=auth.permissions.includes('loyalty.configuration.approve')
  const canStop=auth.permissions.includes('loyalty.policy.publish')
  const path='/api/staff/member-visit-rewards'
  async function read(more=false){
    const current=++generation.current
    const query=new URLSearchParams({status,...(date?{date}:{}),...(more&&data?.nextCursor?{cursor:data.nextCursor}:{})})
    const response=await api.getEndpoint<{data:Page}>(`${path}?${query}`)
    if(!active.current||current!==generation.current)return
    setData(previous=>({...response.data,items:more&&previous?[...previous.items,...response.data.items]:response.data.items}));setSelected([])
  }
  async function load(more=false){
    if(operation.current)return;operation.current=true;setBusy(true);setMessage('')
    try{await read(more)}catch(error){if(active.current)setMessage(error instanceof Error?error.message:'读取失败')}
    finally{operation.current=false;if(active.current)setBusy(false)}
  }
  async function command(input:Record<string,unknown>,description:string){
    if(operation.current)return
    if(reason.trim().length<2){setMessage('请填写审批或配置原因（至少2字）');return}
    operation.current=true;setBusy(true);setMessage('')
    const body={...input,reason:reason.trim()}
    try{
      if(!await confirmAction({title:'确认签到奖励操作',description,confirmLabel:'确认执行'})||!active.current)return
      await executeRecoverableCommand(`${auth.employee.id}:${path}`,body,createIdempotencyKey('visit-reward'),key=>api.postEndpoint(path,body,{idempotencyKey:key}))
      if(!active.current)return
      setSelected([]);await read()
      if(active.current)setMessage(input.action==='approve'?'审批通过，所选奖励已发到会员券包；领取时仍须核销。': '操作已记录。')
    }catch(error){if(active.current)setMessage(error instanceof Error?error.message:'结果未确认，请读取核对；原请求重试不会重复发放')}
    finally{operation.current=false;if(active.current)setBusy(false)}
  }
  function filter(nextDate:string,nextStatus:string){generation.current++;setDate(nextDate);setStatus(nextStatus);setData(null);setSelected([]);setMessage('')}
  function decide(ids:string[],action:'approve'|'reject'){
    void command({action,ids},action==='approve'?`将审批并发放所选 ${ids.length} 轮奖励。重新检查有效签到、商品和预算；任何一条失败则本批全部不发放。`:`将驳回所选 ${ids.length} 轮。本轮计次保留，不会自动重新申请；请确认原因。`)
  }
  return <section aria-label="累计签到奖励"><h4>累计签到奖励</h4>
    <p>每个营业日最多计1次，无需消费。每累计设定次数可再领一轮，发放前必须审批。仅累计规则启用之后、活动发放期内的签到。</p>
    <label>签到奖励操作原因<input maxLength={300} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
    {canConfigure&&<details><summary>配置签到次数与赠品</summary><fieldset disabled={busy}>
      <p>先在上方创建并发布免费商品券活动，配置赠品、每轮份数、有效期和预算，再读取活动并在此绑定。</p>
      <label>赠品活动<select aria-label="签到赠品活动" value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">选择已发布活动</option>{campaigns.filter(c=>c.status==='published'&&c.rule.trigger==='targeted'&&c.rule.pricingKind==='free'&&!c.rule.dessertProductId).map(c=><option key={c.id} value={c.id}>{c.name} · {c.products.map(p=>p.name).join('、')} · 每轮 {c.rule.quantityPerCustomer} 份</option>)}</select></label>
      <label>每累计签到次数<input type="number" min={1} max={365} step={1} value={threshold} onChange={e=>setThreshold(e.target.value)}/></label>
      <p>重复达标可重复审批。规则启用后保留原门槛与赠品；调整时停用旧规则并创建新活动，旧记录保留。</p>
      <button type="button" disabled={!campaign||!/^\d+$/.test(threshold)||Number(threshold)<1||Number(threshold)>365} onClick={()=>void command({action:'configure',campaignVersionId:campaign,requiredVisits:Number(threshold)},`启用每累计 ${threshold} 次签到一轮奖励，管理审批通过后发券。不会补算启用前的签到。`)}>启用签到奖励</button>
    </fieldset></details>}
    <fieldset disabled={busy}><label>达标营业日（留空看全部）<input type="date" value={date} onChange={e=>filter(e.target.value,status)}/></label>
      <label>审批状态<select value={status} onChange={e=>filter(date,e.target.value)}><option value="pending">待审批</option><option value="issued">已发券</option><option value="rejected">已驳回</option><option value="invalid">签到撤回作废</option><option value="all">全部</option></select></label>
      <button type="button" onClick={()=>void load()}>读取签到奖励</button>
      {data&&<p>当前营业日：{data.businessDate}（每日早上6点切换）</p>}
      {data?.rules.map(rule=><p key={rule.id}>{rule.name} · 每累计 {rule.required_visits} 次 · {rule.products} {rule.quantity} 份 · {rule.status==='active'?'已启用':'已停用'}{canStop&&rule.status==='active'&&<button type="button" onClick={()=>void command({action:'stop',id:rule.id},'停止新计次和待审批发放；已发券仍按原规则使用。未发奖励需先核对处理。')}>停用此规则</button>}</p>)}
      {canApprove&&data?.items.some(q=>q.status==='pending')&&<><button type="button" onClick={()=>setSelected(data.items.filter(q=>q.status==='pending').slice(0,50).map(q=>q.id))}>选择已读取的待审批（最多50条）</button><button type="button" disabled={!selected.length} onClick={()=>decide(selected,'approve')}>批量批准并发券（{selected.length}）</button><button type="button" disabled={!selected.length} onClick={()=>decide(selected,'reject')}>批量驳回</button></>}
      {data?.items.map(q=><article key={q.id}>
        {canApprove&&q.status==='pending'&&<label><input type="checkbox" checked={selected.includes(q.id)} onChange={e=>setSelected(previous=>e.target.checked?[...previous,q.id].slice(0,50):previous.filter(id=>id!==q.id))}/>选择 {q.member_no}</label>}
        <strong>{q.member_no} · {q.name} · {states[q.status]}</strong><p>{q.earned_business_date} 达标 · {q.required_visits} 次 · {q.products} {q.quantity} 份</p><p>签到营业日：{q.visit_dates.join('、')}</p>
        {q.status==='issued'&&<p>已核销 {q.quantity_redeemed} 份；券状态：{({issued:'可使用',reserved:'订单占用中',redeemed:'已核销',expired:'已过期',revoked:'已撤销'} as Record<string,string>)[q.benefit_status??'']??'请核对券包'}</p>}
        {q.cancelled_sources>0&&<p role={q.status==='issued'?'alert':undefined}>{q.cancelled_sources} 次原签到已撤回。{q.status==='issued'?'已发权益保留；请管理人员核对，原计次不能再次领奖。':'请核对签到记录。'}</p>}{q.decision_reason&&<p>处理原因：{q.decision_reason}</p>}
        {canApprove&&q.status==='pending'&&<><button type="button" onClick={()=>decide([q.id],'approve')}>单独批准并发券</button><button type="button" onClick={()=>decide([q.id],'reject')}>单独驳回</button></>}
      </article>)}
      {data&&!data.items.length&&<p>当前筛选没有奖励记录。</p>}{data?.nextCursor&&<button type="button" onClick={()=>void load(true)}>读取更多签到奖励</button>}
    </fieldset>{message&&<p role="status">{message}</p>}
  </section>
}
