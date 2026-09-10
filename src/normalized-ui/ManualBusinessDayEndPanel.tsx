import {useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import type {OperatingHistory} from '../shared/operating-history'
import {useConfirmationDialog} from './ConfirmationDialog'
import './operating-history-panel.css'

export function ManualBusinessDayEndPanel({api,businessDate,onCompleted}:{api:NormalizedApiClient;businessDate:string;onCompleted:()=>void}){
  const [preview,setPreview]=useState<OperatingHistory|null>(null),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const pending=useRef<{date:string;reason:string;key:string}|null>(null),writing=useRef(false)
  const {confirmAction}=useConfirmationDialog()
  async function read(){
    if(writing.current)return
    writing.current=true;setBusy(true);setMessage('');setPreview(null)
    try{const result=await api.getEndpoint<{data:OperatingHistory}>('/api/business-days/end-current/preview');setPreview(result.data)}
    catch(error){setMessage(error instanceof Error?error.message:'日结核对暂不可用')}
    finally{writing.current=false;setBusy(false)}
  }
  async function submit(){
    if(writing.current||!preview||reason.trim().length<2)return
    writing.current=true
    try{
      if(!await confirmAction({title:`提前结束 ${preview.businessDate} 营业日`,description:'确认后新订单计入下一营业日。旧单、未确认收款及退款继续保留，不代表已结清。收退款快照以确认成功时为准；打印失败不会阻断营业。',confirmLabel:'确认结束并切日'}))return
      setBusy(true);setMessage('')
      if(!pending.current||pending.current.date!==preview.businessDate||pending.current.reason!==reason.trim())pending.current={date:preview.businessDate,reason:reason.trim(),key:`day-end-${crypto.randomUUID()}`}
      const attempt=pending.current
      const result=await api.postEndpoint<{businessDate:string;nextBusinessDate:string;id:string}>('/api/business-days/end-current',
        {expectedBusinessDate:attempt.date,reason:attempt.reason},{idempotencyKey:attempt.key})
      pending.current=null;setPreview(null);setReason('')
      setMessage(`已结束 ${result.businessDate}，当前营业日为 ${result.nextBusinessDate}。旧账继续核对；日结票已交给后台按打印规则处理。`)
      onCompleted()
    }catch(error){setMessage(`${error instanceof Error?error.message:'日结结果尚未确认'}。请先重新读取核对；相同操作重试不会重复切日。`)}
    finally{writing.current=false;setBusy(false)}
  }
  return <details className="operating-history-panel" aria-label="提前结束营业日">
    <summary>提前结束营业日 · {businessDate}</summary><p>旧单不清空，支付查询不阻止新营业；当天不能连续跳过未来营业日。</p>
    <button type="button" disabled={busy} onClick={()=>void read()}>读取日结核对</button>
    {message&&<p role="status">{message}</p>}
    {preview&&<><p>核对营业日：{preview.businessDate}；以下为已入账流水，不含未知渠道款项。</p>
      {preview.summary&&<p>订单 {preview.summary.orderCount} 单 · 应收合计 ¥{minorText(preview.summary.orderAmountMinor)}<br/>
        未结 {preview.summary.unsettledCount} 单 · 尚欠 ¥{minorText(preview.summary.outstandingMinor)}<br/>
        支付待确认 {preview.summary.pendingPaymentCount} 笔 · 退款待处理 {preview.summary.pendingRefundCount} 笔</p>}
      {preview.receipts.map(row=><p key={row.provider}>{providerNames[row.provider]??row.provider}：收款 ¥{(row.receivedMinor/100).toFixed(2)} / 退款 ¥{(row.refundedMinor/100).toFixed(2)} / 净收 ¥{(row.netMinor/100).toFixed(2)}</p>)}
      {!preview.receipts.length&&<p>尚无已入账收退款流水。</p>}
      <p>未结订单及退款请结合收银待办核对；此操作不会把待办改为已处理。</p>
      <label>日结原因<input value={reason} maxLength={500} disabled={busy} onChange={event=>setReason(event.target.value)} placeholder="至少填写2个字"/></label>
      <button type="button" disabled={busy||reason.trim().length<2} onClick={()=>void submit()}>核对后提前结束</button>
    </>}
  </details>
}
function minorText(value:string){const n=BigInt(value);return `${n/100n}.${String(n%100n).padStart(2,'0')}`}
const providerNames:Record<string,string>={cash:'现金',postar:'星驿支付',wechat:'微信支付',physical_pos:'实体POS',external_manual:'线下登记',simulation:'测试支付'}
