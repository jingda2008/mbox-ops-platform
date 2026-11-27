import {useRef,useState} from 'react'
import type {AssistedCashTicketOffer,StaffTicketCashApi} from './staff-actions-api'

const yuan=(minor:number)=>'¥'+(minor/100).toFixed(2)
export function AssistedCashTicketForm({api,tableSessionId,canCollect}:{api:StaffTicketCashApi;tableSessionId:string;canCollect:boolean}) {
  const [offers,setOffers]=useState<AssistedCashTicketOffer[]|null>(null)
  const [selected,setSelected]=useState('')
  const [quantity,setQuantity]=useState(1)
  const [order,setOrder]=useState<{registrationPublicId:string;amountMinor:number}|null>(null)
  const [paid,setPaid]=useState(false)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const dialog=useRef<HTMLDialogElement>(null)
  const running=useRef(false)
  const offer=offers?.find(row=>row.id===selected)
  async function run(action:()=>Promise<void>) {
    if(running.current)return
    running.current=true; setBusy(true); setError('')
    try{await action()}catch(e){setError(e instanceof Error?e.message:'请重新核对原单')}
    finally{running.current=false;setBusy(false)}
  }
  function load(){return run(async()=>{setOffers(await api.offers());setSelected('')})}
  return <><button type="button" onClick={()=>{dialog.current?.showModal();if(!order)void load()}}>代客现金购票</button>
    <dialog ref={dialog} className="staff-ticket-cash" aria-label="代客现金购票" onCancel={e=>{if(busy)e.preventDefault()}}>
      <div className="staff-ticket-cash-heading"><strong>代客现金购票</strong><button type="button" disabled={busy} onClick={()=>dialog.current?.close()}>关闭</button></div>
    {order?<section><p>购票单号 {order.registrationPublicId} · {yuan(order.amountMinor)}</p>
      {paid?<p role="status">已登记收现，可按原单核对门票和赠分。</p>:canCollect?
        <button type="button" disabled={busy} onClick={()=>void run(async()=>{await api.collect(order.registrationPublicId,order.amountMinor);setPaid(true)})}>确认已收到现金 {yuan(order.amountMinor)}</button>:
        <p>请收银员在「活动收银」按此购票单号登记实收。</p>}
      {(paid || !canCollect) && <button type="button" onClick={()=>{setOrder(null);setPaid(false);setQuantity(1);void load()}}>{paid?'办理下一单':'已交收银，办理下一单'}</button>}
    </section>:<form onSubmit={e=>{
      e.preventDefault();if(!offer)return
      const phone=String(new FormData(e.currentTarget).get('phone')??'').trim()
      void run(async()=>setOrder(await api.open({tableSessionId,offerId:offer.id,quantity,phone,termsAcknowledged:true,safetyVersion:offer.safetyVersion,refundVersion:offer.refundVersion})))
    }}>
      <fieldset disabled={busy}><label>场次和票档<select required value={selected} onChange={e=>{setSelected(e.target.value);setQuantity(1)}}>
        <option value="">{offers?.length===0?'当前没有在售票档':'选择票档'}</option>
        {offers?.map(row=><option key={row.id} value={row.id}>{row.title} · {new Date(row.startsAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {row.name} · {yuan(row.priceMinor)}/桌</option>)}
      </select></label>
      {offer && <div key={offer.id}><label>购票会员手机号<input name="phone" type="tel" required pattern="1[3-9][0-9]{9}" maxLength={11}/></label>
        <label>桌数<input type="number" required min={1} max={offer.remaining} value={quantity||''} onChange={e=>setQuantity(Number(e.target.value))}/></label>
        <p>应收 {yuan(offer.priceMinor*quantity)} · 赠 {offer.giftPoints*quantity} 分</p>
        <p>{offer.safetySummary}</p><p>{offer.refundSchedule}</p>
        <label><input type="checkbox" required/>已与顾客核对手机号、票款及购票须知</label>
        <button>建立现金待收单</button></div>}
      </fieldset><button type="button" disabled={busy} onClick={()=>void load()}>刷新票档</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </dialog></>
}
