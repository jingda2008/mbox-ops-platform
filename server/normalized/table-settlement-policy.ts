/** Pure settlement calculation. No payment or refund is executed here. */
export interface TableSettlementInput {
  minimumMinor:number
  waiverMinor:number
  qualifyingGoodsMinor:number
  goodsPayableMinor:number
  receivedMinor:number
  refundedMinor:number
  pendingRefundMinor:number
  differenceDisposition:'not_authorized'|'collect'|'disputed'
}
export function tableSettlement(input:TableSettlementInput){
  for(const [key,value] of Object.entries(input)){
    if(key==='differenceDisposition')continue
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new TypeError(`Invalid settlement amount: ${key}`)
  }
  if(!['not_authorized','collect','disputed'].includes(input.differenceDisposition))throw new TypeError('Invalid difference disposition')
  if(input.waiverMinor>input.minimumMinor)throw new TypeError('Waiver exceeds minimum')
  if(BigInt(input.refundedMinor)+BigInt(input.pendingRefundMinor)>BigInt(input.receivedMinor))throw new TypeError('Refund exceeds receipts')
  const effectiveMinimumMinor=input.minimumMinor-input.waiverMinor
  const shortfallMinor=Math.max(0,effectiveMinimumMinor-input.qualifyingGoodsMinor)
  const differenceMinor=input.differenceDisposition==='collect'?shortfallMinor:0
  const due=BigInt(input.goodsPayableMinor)+BigInt(differenceMinor)
  if(due>BigInt(Number.MAX_SAFE_INTEGER))throw new TypeError('Settlement overflow')
  const outstanding=due-(BigInt(input.receivedMinor)-BigInt(input.refundedMinor))
  // Unknown or in-flight money must be reconciled before another settlement action.
  const blocked=input.pendingRefundMinor>0||(shortfallMinor>0&&input.differenceDisposition!=='collect')
  return {effectiveMinimumMinor,shortfallMinor,differenceMinor,totalDueMinor:Number(due),
    status:shortfallMinor===0?'goods_qualified':input.differenceDisposition==='collect'?'difference_required':'review_required',
    actionRequired:blocked?'review':outstanding>0?'collect':outstanding<0?'refund':'none',
    collectMinor:blocked?0:Math.max(0,Number(outstanding)),refundMinor:blocked?0:Math.max(0,-Number(outstanding))}
}
