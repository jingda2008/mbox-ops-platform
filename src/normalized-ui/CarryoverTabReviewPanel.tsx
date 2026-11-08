import {useState} from 'react'
import type {CashierWorkbenchOrder} from '../shared/cashier-workbench-contracts'

export function CarryoverTabReviewPanel({order,busyKey,onMutation}: {
  order:CashierWorkbenchOrder;busyKey:string|null
  onMutation(key:string,endpoint:string,body:unknown,successMessage:string):Promise<boolean>
}) {
  const [amount,setAmount]=useState('')
  const [reason,setReason]=useState('')
  const [confirmed,setConfirmed]=useState(false)
  const review=order.carryoverReview
  if (!review) return null
  const basis=review.basis
  const amountMinor=Math.round(Number(amount)*100)
  const valid=basis!==null && /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount.trim())
    && Number.isSafeInteger(amountMinor) && amountMinor>=0 && amountMinor<=basis.maximumAmountMinor && reason.trim().length>=4
  const submit=async()=>{
    if (!review.canConfirm || !valid || busyKey!==null) return
    if (!confirmed) {setConfirmed(true);return}
    await onMutation(`carryover-review-${order.id}`,`/api/orders/${encodeURIComponent(order.id)}/carryover-review`,
      {amountMinor,reason:reason.trim(),basis,confirmed:true},
      amountMinor===0?'已记录核对无欠款，未生成收款。':'已记录确认欠款，请选择收款方式；确认欠款本身不代表已经到账。')
  }
  return <div className="cashier-manual-collection is-blocked" aria-label="跨日挂账待核对">
    <div><strong>跨日挂账待核对</strong><small>原桌次已关闭。待核对金额不计入可收余额；确认后才开放收款。</small></div>
    {basis?.orderNote && <p>原单备注：{basis.orderNote}</p>}
    {!basis ? <p className="cashier-guidance">原单涉及付款尝试、优惠、金额调整或其他处理记录，请财务核对原记录；本页暂不能确认新欠款。</p>
      : !review.canConfirm ? <p className="cashier-guidance">请交给具备“收取历史欠款”和财务查看权限的员工核对。</p>
      : <>
        <p className="cashier-guidance">请核对实际消费、顾客约定及现金、POS、转账和渠道实收。原单 ¥{(basis.maximumAmountMinor/100).toFixed(2)} 仅为核对上限，不代表顾客实际欠款。确认不会重开桌次或重新出品。</p>
        <label className="cashier-field"><span>确认仍欠金额（元；无欠款填0）</span><input inputMode="decimal" value={amount} disabled={busyKey!==null}
          onChange={event=>{setAmount(event.target.value);setConfirmed(false)}} /></label>
        <label className="cashier-field"><span>核对依据</span><textarea value={reason} maxLength={500} disabled={busyKey!==null}
          placeholder="说明实际消费、与顾客约定及实收核对依据；测试单请明确说明"
          onChange={event=>{setReason(event.target.value);setConfirmed(false)}} /></label>
        {confirmed && <p role="alert">请再次确认：{amountMinor===0?'本单没有欠款，不生成应收或付款记录':`已核实仍欠 ¥${(amountMinor/100).toFixed(2)}，不是登记已收款`}。本次决定、核对依据和操作人将留存。</p>}
        <button type="button" className="cashier-primary-action" disabled={!valid||busyKey!==null} onClick={()=>void submit()}>{confirmed?'确认核对结果':'核对并继续'}</button>
      </>}
  </div>
}
