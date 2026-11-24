import {useEffect,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import type {CashierWorkbenchView} from '../shared/cashier-workbench-contracts'
import {refundReviewBlockReason} from '../shared/refund-review-availability'

interface Review {
  ticketId:string;refundId:string;requestedByEmployeeId:string;amountMinor:number;currency:string
  ordinal:number;quantity:number;name:string;reason:string;automatic:boolean|null
}
interface Props {
  api:NormalizedApiClient;employeeId:string;actions:CashierWorkbenchView['actions'];busy:boolean
  onOpenTicket(ticket:string):void
  onMutation(key:string,endpoint:string,body:unknown,success:string):Promise<boolean>
}
export function TicketRefundReviewQueue({api,employeeId,actions,busy,onOpenTicket,onMutation}:Props){
  const [rows,setRows]=useState<Review[]>([]),[failed,setFailed]=useState(false)
  const [selected,setSelected]=useState(''),[reason,setReason]=useState(''),[refresh,setRefresh]=useState(0)
  useEffect(()=>{
    let active=true,running=false
    async function read(){
      if(running)return
      running=true
      try{
        const {data}=await api.getEndpoint<{data:Review[]}>('/api/staff/activity-operations/ticket-refund-reviews')
        if(!Array.isArray(data))throw Error()
        if(active){setRows(data);setFailed(false)}
      }catch{if(active){setRows([]);setFailed(true)}}finally{running=false}
    }
    void read()
    const timer=window.setInterval(()=>void read(),10000)
    return ()=>{active=false;window.clearInterval(timer)}
  },[api,employeeId,refresh])
  async function decide(row:Review,action:'approve'|'reject'){
    if(busy||row.refundId!==selected||reason.trim().length<2||refundReviewBlockReason(actions,row,employeeId))return
    const success=await onMutation('refund-'+action+'-'+row.refundId,'/api/refunds/'+row.refundId+'/'+action,{reason:reason.trim()},
      action==='approve'?'原票退款复核通过，请按原支付渠道核对结果。':'原票退款已驳回。')
    if(success){setRows(previous=>previous.filter(item=>item.refundId!==row.refundId));setSelected('');setReason('')}
    setRefresh(n=>n+1)
  }
  if(failed)return <p role="status">门票退款复核待办读取失败，正在重试。</p>
  if(!rows.length)return null
  return <section aria-label="门票退款待复核"><h3>门票退款待复核</h3>{rows.map(row=>{
    const block=refundReviewBlockReason(actions,row,employeeId)
    return <div key={row.refundId} className="cashier-refund-form">
      <button disabled={busy} aria-expanded={selected===row.refundId} onClick={()=>{setSelected(row.refundId===selected?'':row.refundId);setReason('')}}>
        {row.automatic?'补款已收齐，原票应退':'原票应退'} ¥{(row.amountMinor/100).toFixed(2)} · {row.name} · 第 {row.ordinal}／{row.quantity} 张
      </button>
      {selected===row.refundId && <><p>票号 {row.ticketId} · {row.reason}</p><button disabled={busy} onClick={()=>onOpenTicket(row.ticketId)}>查看原票核算明细</button>
        {block?<p>{block}</p>:<><label>复核意见<input maxLength={500} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
          <button disabled={busy||reason.trim().length<2} onClick={()=>void decide(row,'approve')}>复核通过</button>
          <button disabled={busy||reason.trim().length<2} onClick={()=>void decide(row,'reject')}>复核驳回</button></>}
      </>}
    </div>
  })}</section>
}
