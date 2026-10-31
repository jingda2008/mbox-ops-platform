import {useState} from 'react'
import {executeRecoverableCommand} from '../recoverable-command'
import type {GuestSharedCart,OnlinePaymentAction} from './guest-api'
export function GuestPrepaymentPanel({scope,summary,prepay,query,revoke,present,refresh}:{scope:string;summary:NonNullable<GuestSharedCart['prepayment']>;prepay:(amount:number,key:string)=>Promise<OnlinePaymentAction>;query:(id:string)=>Promise<void>;revoke:(id:string)=>Promise<void>;present:(action:OnlinePaymentAction)=>Promise<void>;refresh:()=>Promise<unknown>}){
 const [amount,setAmount]=useState(summary.initialFundingRequiredMinor>0?(summary.initialFundingRequiredMinor/100).toFixed(2):''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
 const submit=async()=>{if(busy)return
  const pending=summary.myPendingReceipts[0]
  const minor=pending?.amountMinor??Math.round(Number(amount)*100)
  if(!consent){setNotice('请先确认共享规则');return}
  if(!pending&&(!/^\d+(\.\d{1,2})?$/.test(amount)||!Number.isSafeInteger(minor)||minor<=0)){setNotice('请填写有效金额，最多两位小数');return}
  setBusy(true);setNotice('')
  try{const action=await executeRecoverableCommand(`guest-table-prepayment:${scope}`,{minor},`prepay-${crypto.randomUUID()}`,key=>prepay(minor,key))
   if(action.status==='resolved')setNotice(['succeeded','partially_refunded','refunded'].includes(action.terminalPaymentStatus??'')?'原预付款已确认，请查看最新余额':'原付款已经结束，本次未新增收款')
   else if(action.status==='pending'&&action.payload){await present(action);try{await query(action.paymentId)}catch{/* Original receipt remains resumable. */}setNotice('付款结果正在核对，请查看最新余额；未确认时继续原付款')}
   else setNotice('预付款尚未确认，请继续核对原付款或联系员工处理')
   await refresh()
  }catch(e){setNotice(e instanceof Error?e.message:'付款结果待核对，请继续原付款')}finally{setBusy(false)}
 }
 return <section aria-label="本桌预收款"><p role="status">{summary.message}</p><p>付款后允许本桌已加入成员共同点单。剩余款经结算退回原付款人，差额收费未启用。</p><label>预收或补充金额（元）<input inputMode="decimal" value={amount} disabled={busy||summary.myPendingReceipts.length>0} onChange={e=>setAmount(e.target.value)}/></label>{summary.myPendingReceipts[0]&&<p>原付款 ¥{(summary.myPendingReceipts[0].amountMinor/100).toFixed(2)} 待确认，将继续原付款。</p>}<label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我同意本桌已加入成员共享本次预收款</label><button type="button" disabled={busy} onClick={()=>void submit()}>{busy?'正在核对…':'预付／继续原付款'}</button>{(summary.mySharedReceipts??[]).map(receipt=><button key={receipt.id} type="button" disabled={busy} onClick={async()=>{setBusy(true);try{await revoke(receipt.id);await refresh();setNotice('已撤销这笔预收款的未来共享，已确认订单保持原记录。退款请联系员工办理。')}catch(e){setNotice(e instanceof Error?e.message:'撤销结果待核对')}finally{setBusy(false)}}}>停止共享预付款 {receipt.publicId.slice(-8)}</button>)}{notice&&<p role="status">{notice}</p>}</section>
}
