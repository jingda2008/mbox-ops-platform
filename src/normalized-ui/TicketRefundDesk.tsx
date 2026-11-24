import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'

interface RefundTicket {
  id:string;previewVersion:string;ordinal:number;quantity:number;orderNo:string;name:string;memberNo:string;maskedPhone:string;tableName:string|null
  priceMinor:number;giftPoints:number;recoverable:number;consumedMinor:string;refundSchedule:string|null;refundLimit:number
  personalRefundClosed:boolean;plannedRefundMinor:number|null;autoReviewError:string|null;caseId:string|null;caseStatus:string|null;refundId:string|null;cashStatus:string|null;unresolved:boolean
}
interface TicketStatement {
  originalDishes:{orderNo:string;name:string;priceMinor:number;usedMinor:number}[]
  points:{kind:string;delta:number;remaining:number}[]
}
const yuan=(minor:number|string)=>(Number(minor)/100).toFixed(2)
export function TicketRefundDesk({api,auth,reference}:{api:NormalizedApiClient;auth:Pick<StaffAuthView,'permissions'>;reference:string}){
  const [rows,setRows]=useState<RefundTicket[]>([]),[selected,setSelected]=useState('')
  const [revision,setRevision]=useState(0),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const [reason,setReason]=useState(''),[cash,setCash]=useState(''),[share,setShare]=useState('')
  const [cause,setCause]=useState('customer')
  const [showDetails,setShowDetails]=useState(false),[statement,setStatement]=useState<TicketStatement|null>(null)
  useEffect(()=>{
    let active=true
    setStatement(null)
    if(selected && showDetails)api.getEndpoint<{data:TicketStatement}>('/api/staff/activity-operations/table-tickets/'+selected+'/statement')
      .then(response=>{if(active)setStatement(response.data)})
      .catch(error=>{if(active)setNotice(error instanceof Error?error.message:'核算明细读取失败')})
    return ()=>{active=false}
  },[api,selected,showDetails,revision])
  const receipt=useRef<{identity:string;key:string}|null>(null)
  const ticket=rows.find(row=>row.id===selected)
  useEffect(()=>{
    let active=true
    setRows([]);setNotice('正在核对原票…')
    api.getEndpoint<{data:RefundTicket[]}>('/api/staff/activity-operations/ticket-refund-preview?reference='+encodeURIComponent(reference))
      .then(result=>{if(!active)return;setRows(result.data);setSelected(old=>result.data.length===1?result.data[0]!.id:result.data.some(row=>row.id===old)?old:'');setNotice(result.data.length?'':'没有找到已出票记录，请核对原支付及出票状态。')})
      .catch(e=>{if(active)setNotice(e instanceof Error?e.message:'查票失败')})
    return ()=>{active=false}
  },[api,reference,revision])
  useEffect(()=>{setReason('');setCash('');setShare('');setCause('customer');receipt.current=null},[selected,reference])
  async function command(path:string,body:Record<string,unknown>){
    if(busy || !ticket)return
    const identity=JSON.stringify([ticket.id,path,body])
    if(receipt.current?.identity!==identity)receipt.current={identity,key:'tt-case-'+crypto.randomUUID()}
    setBusy(true)
    try{
      await api.postEndpoint('/api/staff/activity-operations/'+path,body,{idempotencyKey:receipt.current.key})
      receipt.current=null;setRevision(n=>n+1)
    }catch(e){setNotice(e instanceof Error?e.message:'请核对原案后重试')}finally{setBusy(false)}
  }
  const used=Number(ticket?.consumedMinor??0),amount=Math.round(Number(cash)*100),customer=Math.round(Number(share)*100)
  const canRequest=auth.permissions.includes('refund.request'),canReview=auth.permissions.includes('refund.approve')
  const validAmount=cash.trim()!=='' && Number.isSafeInteger(amount) && amount>0 && amount<=(ticket?.refundLimit??0)
  const zeroCash=cash.trim()!=='' && Number(cash)===0
  const planned=ticket?.plannedRefundMinor!=null && !ticket.autoReviewError
  const pendingAutoReview=planned && ticket?.caseStatus==='review'
  useEffect(()=>{
    if(!pendingAutoReview || busy)return
    let active=true,reading=false
    async function refresh(){
      if(reading || document.visibilityState!=='visible')return
      reading=true
      try{
        const result=await api.getEndpoint<{data:RefundTicket[]}>('/api/staff/activity-operations/ticket-refund-preview?reference='+encodeURIComponent(reference))
        if(active)setRows(result.data)
      }catch{if(active)setNotice('暂未读到最新退票进度，正在重试。')}
      finally{reading=false}
    }
    const timer=window.setInterval(()=>void refresh(),5000)
    return ()=>{active=false;window.clearInterval(timer)}
  },[api,busy,pendingAutoReview,reference,selected,revision])
  const personalBlocked=ticket?.personalRefundClosed && cause==='customer'
  const canMerchant=canRequest && auth.permissions.includes('community.activity.manage')
  const needsPlan=!personalBlocked && used>0 && cause==='customer' && !planned
  const amountField=ticket && <label>按原条款核定退票款（元）<input type="number" min={ticket.caseId?".01":"0"} max={yuan(ticket.refundLimit)} step=".01" disabled={busy} value={cash} onChange={e=>setCash(e.target.value)}/></label>
  return <section className="cashier-refund-form" aria-label="整桌门票退票办理">
    <strong>整桌门票退票办理</strong>
    {rows.length>1 && <label>选择原票<select disabled={busy} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">请选择</option>{rows.map(r=><option key={r.id} value={r.id}>第 {r.ordinal}／{r.quantity} 张 · {r.name} · {r.tableName??'待排桌'} · {r.memberNo} · {r.maskedPhone}</option>)}</select></label>}
    {ticket && <>
      <p>{ticket.name} · 第 {ticket.ordinal}／{ticket.quantity} 张 · 会员 {ticket.memberNo} · {ticket.maskedPhone} · {ticket.tableName??'待排桌'}</p>
      <p>票号 {ticket.id} · 购票单 {ticket.orderNo}</p>
      <p>本票实付 ¥{yuan(ticket.priceMinor)} · 原支付当前可退上限 ¥{yuan(ticket.refundLimit)}</p>
      <p>本票赠 {ticket.giftPoints} 分 · 当前可收回 {ticket.recoverable} 分 · 原餐单净抵扣 ¥{yuan(used)}</p>
      <p>购票时约定：{ticket.refundSchedule || '原单未保存可计算条款，需人工核实'}</p>
      <button type="button" aria-expanded={showDetails} onClick={()=>setShowDetails(!showDetails)}>{showDetails?'收起核算明细':'查看核算明细'}</button>
      {showDetails && statement && <div><strong>本票原餐单</strong>{statement.originalDishes.length?statement.originalDishes.map((line,index)=><p key={index}>{line.orderNo} · {line.name} · 原价 ¥{yuan(line.priceMinor)} · 本票实抵 ¥{yuan(line.usedMinor)}</p>):<p>无已生效的菜品抵扣</p>}
        <strong>本票积分流水</strong>{statement.points.map((line,index)=><p key={index}>本次 {line.delta>0?'+':''}{line.delta} 分 · 结余 {line.remaining} 分</p>)}</div>}
      {ticket.caseId && <p>原案 {ticket.caseId} · {ticket.cashStatus==='succeeded'?'已退款':ticket.cashStatus==='requested'?'已提交，等待独立复核':ticket.refundId?'已进入原渠道退款流程':ticket.caseStatus==='review'?'待核算':'已登记'}</p>}
      {ticket.autoReviewError && <p role="alert">{ticket.autoReviewError}</p>}
      {planned && ticket.caseStatus==='review' && <p>拟退票款 ¥{yuan(ticket.plannedRefundMinor!)}，顾客确认且补款收齐后自动提交复核。</p>}
      {ticket.personalRefundClosed && !canMerchant?<p>本票已验票入场，仅可由门店负责人按门店原因办理。</p>:ticket.unresolved?<p>积分归属或消费状态待核对，请由主管核对原票后继续。</p>:!ticket.refundId && (!ticket.caseId || ticket.caseStatus==='review') && <>
        <label>退票原因<select value={cause} disabled={busy} onChange={e=>setCause(e.target.value)}><option value="customer">顾客原因</option>{canMerchant && <option value="merchant">门店原因</option>}</select></label>
        {personalBlocked?<p>本票已验票入场，无法办理个人原因退票。</p>:<>
        <label>办理依据<input value={reason} maxLength={500} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
        {canRequest && (needsPlan || (ticket.caseId && (used===0 || cause==='merchant'))) && amountField}
        {!ticket.caseId?canRequest && <button disabled={busy||reason.trim().length<2||(needsPlan&&!validAmount&&!zeroCash)} onClick={()=>void command('table-tickets/'+ticket.id+'/refund-request',{reason:reason.trim(),previewVersion:ticket.previewVersion,...(cause==='merchant'?{cause:'merchant'}:{}),...(needsPlan&&validAmount?{refundAmountMinor:amount}:{})})}>受理本票退票</button>:<>
          {needsPlan && canRequest && <button disabled={busy||!validAmount||reason.trim().length<2} onClick={()=>void command('table-tickets/'+ticket.id+'/refund-request',{reason:reason.trim(),refundAmountMinor:amount})}>核定原票款，收齐后自动送审</button>}
          {needsPlan && !canRequest && <p>请有退款申请权限的同事在原案核定票款。</p>}

          {used>0 && cause==='customer' && canReview && <div><label>核定顾客应补（元）<input type="number" min="0" max={yuan(used)} step=".01" value={share} onChange={e=>setShare(e.target.value)}/></label>
            {share!=='' && customer>=0 && customer<=used && <p>门店承担 ¥{yuan(used-customer)}</p>}
            <button disabled={busy||(needsPlan&&!validAmount)||!share||!Number.isSafeInteger(customer)||customer<0||customer>used||reason.trim().length<2} onClick={()=>void command('table-ticket-refunds/'+ticket.caseId+'/dining',{customerMinor:customer,merchantMinor:used-customer,reason:reason.trim(),...(needsPlan?{refundAmountMinor:amount}:{})})}>确认分摊并发给顾客</button></div>}
          {canRequest && (used===0 || cause==='merchant') && <>
          <button disabled={busy||reason.trim().length<2||!Number.isSafeInteger(amount)||amount<=0||amount>ticket.refundLimit} onClick={()=>void command('table-ticket-refunds/'+ticket.caseId+'/submit',{amountMinor:amount,...(cause==='merchant'?{merchantReason:reason.trim()}:{})})}>提交原路退款复核</button></>}
        </>}
        </>}
      </>}
    </>}
    {notice && <p role="status">{notice}</p>}
    <button disabled={busy} onClick={()=>setRevision(n=>n+1)}>刷新原案</button>
  </section>
}
