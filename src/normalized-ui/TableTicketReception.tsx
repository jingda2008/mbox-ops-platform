import {TicketRefundDesk} from './TicketRefundDesk'
import {useEffect,useState,type FormEvent,type ReactNode} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

export interface TicketContact { orderId:string;maskedPhone:string;registrationStatus:string;contactVersionPublicId:string|null }
interface Ticket extends TicketContact {
  id:string;orderId:string;ordinal:number;name:string;areaId:string;tableName:string|null;maskedPhone:string
  originalReservation:string|null;originalTable:string|null;contactStatus:string;contactOwner:string|null;arrived:number
  deskClosed:boolean;showEnded:boolean;awaitingDuringShow:boolean;startsAt:string;endsAt:string;refundedAt:string|null;effectiveTitle:string|null;moveStatus:string|null;giftPoints:number;issuedPoints:number|null;remainingPoints:number|null;correctionId:string|null;correctionReason:string|null;correctionUsed:number|null;resolution:string|null;wrongGift:boolean
  refundCase:string|null;refundStatus:string|null;cashZero:boolean;needsReview:boolean;consumedMinor:string|null;priceMinor:number
}
interface Statement {
  ticket:{receipt:string;priceMinor:number;paidAt:string}
  points:{lot:string;kind:string;delta:number;remaining:number;at:string}[]
  originalDishes?:{orderNo:string;name:string;priceMinor:number;usedMinor:number;review:boolean}[]
  dining:{orderNo:string;amountMinor:string;merchantMinor:string|null;reason:string;confirmedAt:string|null;receipt:string|null;paymentStatus:string|null;returnNo:string|null;returnStatus:string|null;returns:{receipt:string;amountMinor:number;status:string}[]}[]
  refunds:{id:string;status:string;receipt:string|null;cashStatus:string|null;cashMinor:string|null;zeroCash:boolean;merchantAssumes:boolean;consumedMinor:string}[]
}
const money=(minor:number|string|null)=>'¥'+(Number(minor)/100).toFixed(2)
const statusText:Record<string,string>={requested:'待复核',review:'待核算',approved:'已批准',processing:'处理中',succeeded:'已完成',refunded:'已退',partially_refunded:'部分已退',cancelled:'已取消',rejected:'已拒绝',pending:'待支付',failed:'失败',grant:'发放',redeem:'抵扣',restore:'退回',reverse:'冲回',expire:'到期'}
type Queue={shows?:{id:string;activityPublicId:string;title:string;areaId:string;priceMinor:number;startsAt:string}[];orders:Ticket[];tables:{id:string;name:string;areaId:string}[]}
export function TableTicketReception({api,activityId,initiallyOpen=false,canRefund,canManage,canCorrect,canApproveCorrection,canApproveRefund,renderContact}:{
  initiallyOpen?:boolean
  renderContact:(contact:TicketContact)=>ReactNode
  api:NormalizedApiClient;activityId:string;canRefund:boolean;canManage:boolean;canCorrect:boolean;canApproveCorrection:boolean;canApproveRefund:boolean
}){
  const [open,setOpen]=useState(initiallyOpen),[refresh,setRefresh]=useState(0),[working,setWorking]=useState(false)
  const [message,setMessage]=useState(''),[queue,setQueue]=useState<Queue>({orders:[],tables:[]})
  const [statement,setStatement]=useState<{id:string;data:Statement}|null>(null)
  const [handling,setHandling]=useState('')
  const [day,setDay]=useState('')
  const [daily,setDaily]=useState<{day:string;amounts:Record<string,string>}|null>(null)
  async function inspectDay(){
    try{
      const result=await api.getEndpoint<{data:{day:string;amounts:Record<string,string>}}>('/api/staff/activity-operations/ticket-finance-day'+(day?'?day='+day:''))
      setDaily(result.data);setDay(result.data.day)
    }catch(error){setMessage(error instanceof Error?error.message:'营业日汇总读取失败')}
  }
  async function inspect(id:string){
    try{
      const result=await api.getEndpoint<{data:Statement}>('/api/staff/activity-operations/table-tickets/'+id+'/statement')
      setStatement({id,data:result.data})
    }catch(error){setMessage(error instanceof Error?error.message:'原票对账读取失败')}
  }
  useEffect(()=>{
    if(!open)return
    let active=true
    const load=async()=>{
      try{
        const r=await api.getEndpoint<{data:Queue}>('/api/staff/activity-operations/'+encodeURIComponent(activityId)+'/ticket-reception')
        if(active)setQueue(r.data)
      }catch(e){if(active)setMessage(e instanceof Error?e.message:'接待队列读取失败')}
    }
    void load()
    const interval=window.setInterval(()=>void load(),20000)
    return ()=>{active=false;window.clearInterval(interval)}
  },[api,activityId,open,refresh])
  async function handle(event:FormEvent<HTMLFormElement>,ticket:Ticket,mode:'assign'|'refund'|'open'|'move'){
    event.preventDefault()
    if(working)return
    const fields=new FormData(event.currentTarget)
    const endpoint=mode==='move'?'table-tickets/'+ticket.id+'/reschedule':mode==='assign'?'table-tickets/'+ticket.id+'/assign' :mode==='open'?'table-tickets/'+ticket.id+'/refund-request':'table-ticket-refunds/'+ticket.refundCase+'/submit'
    const body=mode==='move'?{offerId:fields.get('offerId'),tableId:fields.get('tableId'),reason:fields.get('reason')}:mode==='assign'?{tableId:fields.get('tableId'),reservationPublicId:String(fields.get('reservation')||'').trim()||null}:
      mode==='open'?{reason:fields.get('reason')}:{amountMinor:Math.round(Number(fields.get('yuan'))*100),merchantReason:String(fields.get('merchantReason')||'').trim()||null}
    setWorking(true);setMessage('')
    try{
      await api.postEndpoint('/api/staff/activity-operations/'+endpoint,body,{idempotencyKey:'ticket-'+crypto.randomUUID()})
      setRefresh(v=>v+1);setMessage(mode==='move'?'改期安排已送至购票会员，待本人确认':mode==='assign'?'桌号已确认':mode==='open'?'原票退票案已建立':'已提交收银复核，按原支付渠道退回')
    }catch(e){setMessage(e instanceof Error?e.message:'办理失败，请核对原单')}
    finally{setWorking(false)}
  }
  async function frontDesk(event:FormEvent<HTMLFormElement>,ticket:Ticket,door:boolean){
    event.preventDefault()
    const form=event.currentTarget,fields=new FormData(form)
    const payload=door?{quantity:Number(fields.get('quantity')),code:String(fields.get('code')).toUpperCase()}:{status:fields.get('status')}
    const fingerprint=JSON.stringify(payload)
    if(form.dataset.fingerprint!==fingerprint){form.dataset.operation=crypto.randomUUID();form.dataset.fingerprint=fingerprint}
    setWorking(true)
    try {
      const path=door?'table-tickets/'+ticket.id+'/admit':'ticket-reception/'+encodeURIComponent(ticket.orderId)+'/contact'
      await api.postEndpoint('/api/staff/activity-operations/'+path,payload,{idempotencyKey:form.dataset.operation!})
      form.reset();delete form.dataset.fingerprint;setRefresh(v=>v+1);setMessage(door?'本批已登记到场':'接待进度已保存')
    }catch(e){setMessage(e instanceof Error?e.message:'办理失败，请核对原记录')}
    finally{setWorking(false)}
  }
  async function disposition(event:FormEvent<HTMLFormElement>,ticket:Ticket){
    event.preventDefault()
    const form=new FormData(event.currentTarget);setWorking(true)
    try{const result=await api.postEndpoint<{data:{status:string}}>('/api/staff/activity-operations/table-tickets/'+ticket.id+'/disposition',
      {action:form.get('action'),reason:form.get('reason')},{idempotencyKey:'decision-'+crypto.randomUUID()})
      setRefresh(v=>v+1);setMessage(['requested','review'].includes(result.data.status)?'请在收银台核对原补菜款退款；到账后解除冻结':'原票售后决定已记录')
    }catch(e){setMessage(e instanceof Error?e.message:'原案处理失败')}finally{setWorking(false)}
  }
  async function proposeDining(event:FormEvent<HTMLFormElement>,ticket:Ticket){
    event.preventDefault()
    const form=event.currentTarget
    const fields=new FormData(form)
    const reason=fields.get('reason')
    const customer=String(fields.get('customer')??''), merchant=String(fields.get('merchant')??'')
    const split=customer!=='' || merchant!=='' ? {customerMinor:Math.round(Number(customer)*100),merchantMinor:Math.round(Number(merchant)*100)} : undefined
    if(split && (customer==='' || merchant==='' || split.customerMinor+split.merchantMinor!==Number(ticket.consumedMinor))){
      setMessage('请填齐两项金额，合计须等于本票已抵菜款');return
    }
    const payload={reason,...split}
    const fingerprint=JSON.stringify({caseId:ticket.refundCase,...payload})
    if(form.dataset.fingerprint!==fingerprint){
      form.dataset.fingerprint=fingerprint
      form.dataset.operation='dining-'+crypto.randomUUID()
    }
    setWorking(true)
    try{
      await api.postEndpoint('/api/staff/activity-operations/table-ticket-refunds/'+ticket.refundCase+'/dining',payload,{idempotencyKey:form.dataset.operation!})
      delete form.dataset.fingerprint
      delete form.dataset.operation
      setMessage('已发至购票会员的原退票案。会员确认后从原餐饮单收款。');setRefresh(v=>v+1)
    }catch(e){setMessage(e instanceof Error?e.message:'菜款核算失败')}
    finally{setWorking(false)}
  }
  async function correct(event:FormEvent<HTMLFormElement>,ticket:Ticket){
    event.preventDefault()
    const fields=new FormData(event.currentTarget)
    setWorking(true)
    try {
      await api.postEndpoint('/api/staff/activity-operations/table-tickets/'+ticket.id+'/correction',{
        reason:fields.get('reason'),action:fields.get('action'),caseId:ticket.correctionId,merchantAssumes:fields.get('resolution')==='merchant',buyerUse:fields.get('resolution')==='buyer'
      },{idempotencyKey:'correction-'+crypto.randomUUID()})
      setRefresh(v=>v+1);setMessage('原票冲正记录已更新')
    }catch(e){setMessage(e instanceof Error?e.message:'冲正办理失败')}
    finally{setWorking(false)}
  }
  return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>门票接待</summary>
    {open && <>{queue.orders.length===0 && <p>本场暂无已付款门票</p>}
    {(canRefund||canApproveRefund) && <details><summary>全店门票营业日对账</summary>
      <label>营业日<input type="date" value={day} onChange={e=>{setDay(e.target.value);setDaily(null)}}/></label>
      <button type="button" onClick={()=>void inspectDay()}>读取营业日</button>
      {daily && <div><p>{daily.day} · 票款实收 {money(daily.amounts.ticketCash??0)} · 退票实退 {money(daily.amounts.ticketRefund??0)}</p>
        <p>关联餐饮原单实收 {money(daily.amounts.originalDiningCash??0)} · 原预收分配 {money(daily.amounts.originalPrepay??0)} · 原菜款实退 {money(daily.amounts.originalDiningRefund??0)}</p>
        <p>补菜款实收 {money(daily.amounts.diningCash??0)} · 补菜款实退 {money(daily.amounts.diningRefund??0)} · 已办结退票的门店承担 {money(daily.amounts.merchantDining??0)}</p>
        <p>补款关联餐饮积分 · 发放 {daily.amounts.diningRewardEarn??0} 分 · 冲回 {daily.amounts.diningRewardReverse??0} 分</p>
        <p>赠分 {daily.amounts.points_grant??0} · 抵扣占用 {daily.amounts.points_redeem??0} · 原批次退回 {daily.amounts.points_restore??0} · 冲回 {daily.amounts.points_reverse??0} · 到期 {daily.amounts.points_expire??0}</p></div>}
    </details>}
    {queue.orders.map(ticket=><article key={ticket.id}><strong>{ticket.name} · 第{ticket.ordinal}桌</strong>
      <p>购票单 {ticket.orderId} · {queue.orders.find(row=>row.orderId===ticket.orderId)?.id===ticket.id?renderContact(ticket):ticket.maskedPhone} · {ticket.deskClosed?'本桌已清台':ticket.showEnded?(ticket.arrived?'场次已结束 · 已登记 '+ticket.arrived+' 人':'场次已结束 · 无到场登记'):ticket.tableName??(ticket.awaitingDuringShow?'演出已开始，请尽快排桌':'待排桌')}</p>
      {(canRefund || canApproveRefund) && <button type="button" onClick={()=>setHandling(handling===ticket.id?'':ticket.id)}>办理退票</button>}
      {handling===ticket.id && <TicketRefundDesk key={ticket.id} api={api} auth={{permissions:[...(canRefund?['refund.request']:[]),...(canApproveRefund?['refund.approve']:[]),...(canManage?['community.activity.manage']:[])]}} reference={ticket.id}/>}
      {(canRefund||canApproveRefund) && <button type="button" onClick={()=>void inspect(ticket.id)}>核对原票、积分和菜款</button>}
      {statement?.id===ticket.id && <section aria-label="原票对账"><p>本票票款 {money(statement.data.ticket.priceMinor)} · 原收款 {statement.data.ticket.receipt}</p>
        {statement.data.points.map((row,i)=><p key={row.lot+i}>积分{statusText[row.kind]??row.kind} {row.delta} 分 · 批次余额 {row.remaining} 分 · {new Date(row.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>)}
        {statement.data.originalDishes?.map((line,i)=><p key={line.orderNo+i+'-basis'}>原餐单 {line.orderNo} · {line.name} · 原价 {money(line.priceMinor)} · 本票已抵 {money(line.usedMinor)}{line.review && ' · 有售后记录待核实'}</p>)}
        {statement.data.dining.map((row,i)=><p key={row.orderNo+i}>原菜品单 {row.orderNo} · 顾客应补 {money(row.amountMinor)}{row.merchantMinor!=null && <> · 门店承担 {money(row.merchantMinor)} · {row.reason}</>} · {row.confirmedAt?'会员已确认':'待会员确认'} · {row.receipt??'尚无收款'} {statusText[row.paymentStatus??'']}{row.returns.map(back=><span key={back.receipt}> · 退款 {back.receipt} {money(back.amountMinor)} {statusText[back.status]??back.status}</span>)}</p>)}
        {statement.data.refunds.map(row=><p key={row.id}>退票 {row.receipt??row.id} · {row.zeroCash?'应退现金为零':row.receipt?money(row.cashMinor):'尚未提交渠道退款'} · {statusText[row.cashStatus??row.status]}{row.merchantAssumes && <> · 门店承担原抵扣 {money(row.consumedMinor)}</>}</p>)}
      </section>}
      {queue.orders.find(row=>row.orderId===ticket.orderId)?.id===ticket.id && <form onSubmit={e=>void frontDesk(e,ticket,false)}><label>本单接待 · {ticket.contactOwner??'待认领'}
        <select key={ticket.contactStatus} name="status" defaultValue={ticket.contactStatus}><option value="waiting">待联系或交班</option><option value="claimed">接单中</option><option value="called">已电话联系</option><option value="unreachable">未接通，待回拨</option><option value="onsite">现场安排</option></select></label><button disabled={working}>更新接待</button></form>}
      {!ticket.showEnded && ticket.tableName && !ticket.refundCase && <form onSubmit={e=>void frontDesk(e,ticket,true)}><label>客人出示的入场码<input name="code" required maxLength={12} minLength={12}/></label>
        <label>本批到场人数<input name="quantity" type="number" min={1} step={1} required/></label><button disabled={working}>登记到场</button> 已到 {ticket.arrived} 人</form>}
      {!ticket.deskClosed && !ticket.showEnded && !ticket.tableName && !ticket.refundCase && <form onSubmit={e=>void handle(e,ticket,'assign')}>
        <label>桌号<select name="tableId" required defaultValue={ticket.originalTable??''}><option value="" disabled>选择所购区域的桌号</option>
          {queue.tables.filter(t=>t.areaId===ticket.areaId).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>沿用原预约（如有）<input name="reservation" defaultValue={ticket.originalReservation??''}/></label><button disabled={working}>确认桌号</button>
      </form>}
      {ticket.effectiveTitle && <p>现安排 · {ticket.effectiveTitle} · {ticket.startsAt} 至 {ticket.endsAt}</p>}
      {canManage && !ticket.refundedAt && !ticket.refundCase && !ticket.arrived && <details><summary>联系购票人改期{ticket.moveStatus==='proposed'?' · 待本人确认':''}</summary>
        <form onSubmit={e=>void handle(e,ticket,'move')}><label>新场次<select name="offerId" required defaultValue=""><option value="">选择同价同区域场次</option>
          {(queue.shows??[]).filter(s=>s.areaId===ticket.areaId && s.priceMinor===ticket.priceMinor && s.activityPublicId!==activityId).map(s=><option key={s.id} value={s.id}>{s.title} · {s.startsAt}</option>)}</select></label>
        <label>拟排桌号<select name="tableId" required>{queue.tables.filter(t=>t.areaId===ticket.areaId).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>联系说明及变更原因<input name="reason" required minLength={2}/></label><button disabled={working}>发给购票会员确认</button></form></details>}
      {canRefund && !ticket.refundCase && <details><summary>代客申请退本票</summary><form onSubmit={e=>void handle(e,ticket,'open')}><label>联系结果及退票原因<input name="reason" required minLength={2} maxLength={500}/></label><button disabled={working}>建立原票退票案</button></form></details>}
      {ticket.correctionId && <p>原冲正申请 · {ticket.correctionReason} · 原票错户已用 {ticket.correctionUsed} 分{ticket.resolution==='merchant_assumes'?' · 申请门店承担':ticket.resolution==='buyer_use'?' · 购票会员确认消费归属':''}</p>}
      {canCorrect && ticket.wrongGift && (!ticket.refundCase || ticket.refundStatus==='review' || ticket.refundStatus==='refunded') && (!ticket.correctionId || canApproveCorrection) && <form onSubmit={e=>void correct(e,ticket)}>
        <p>原票应赠 {ticket.giftPoints} 分 · 实发 {ticket.issuedPoints} 分 · 批次剩余 {ticket.remainingPoints} 分</p><label>赠分差错依据<input name="reason" minLength={3} maxLength={240} required/></label>
        {!ticket.correctionId && canManage && <label>已用积分处理<select name="resolution"><option value="">未涉及已用错户赠分</option><option value="merchant">错户本人消费，申请门店承担</option><option value="buyer">由购票会员确认原消费，扣除已用部分</option></select></label>}
        <select name="action">{ticket.correctionId?<><option value="approve">{ticket.refundStatus==='refunded'?'已退票，复核收回错户余额':'按原票复核数量与归属'}</option><option value="reject">驳回</option></>:<option value="request">提交原票冲正申请</option>}</select>
        <button disabled={working}>办理原票冲正</button></form>}
      {ticket.refundCase && <p>原票售后 · {ticket.refundStatus==='review'?'待核算':ticket.cashZero?'退票办结，应退现金为零':ticket.refundStatus==='refunded'?'已退款':'收银复核中'} · 本票已抵菜款 ¥{(Number(ticket.consumedMinor)/100).toFixed(2)}</p>}
      {ticket.refundCase && ticket.refundStatus!=='refunded' && canApproveRefund && canRefund &&
        <details><summary>办理撤回或其他退票决定</summary><form onSubmit={e=>void disposition(e,ticket)}>
          <select name="action"><option value="cancelled">顾客撤回，按原收款退回补款</option><option value="rejected">拒绝申请，保留原票</option><option value="zero">终止票权，应退现金为零</option></select>
          <label>决定依据<input name="reason" minLength={3} required/></label><button disabled={working}>按依据办理</button></form></details>}
      {ticket.refundStatus==='review' && Number(ticket.consumedMinor)>0 && canApproveRefund && <form onSubmit={e=>void proposeDining(e,ticket)}>
        <label>顾客应补菜款（元）<input type="number" name="customer" min="0" step="0.01" required={Number(ticket.consumedMinor)>ticket.priceMinor}/></label>
        <label>门店承担金额（元）<input type="number" name="merchant" min="0" step="0.01" required={Number(ticket.consumedMinor)>ticket.priceMinor}/></label>
        <label>菜款核定依据<input name="reason" minLength={2} maxLength={500} required/></label><button disabled={working}>发给会员核对逐菜补款</button></form>}
      {ticket.refundStatus==='review' && canRefund && <form onSubmit={e=>void handle(e,ticket,'refund')}>
        <label>按原条款应退票款（元）<input required type="number" min=".01" max={ticket.priceMinor/100} step=".01" name="yuan"/></label>
        {canManage && <label>门店履约原因（门店原因单独处理应退票款时填写）<input name="merchantReason"/></label>}
        <button disabled={working}>提交原路退款复核</button></form>}
    </article>)}<p role="status">{message}</p><button type="button" onClick={()=>setRefresh(v=>v+1)}>刷新接待队列</button></>}
  </details>
}
