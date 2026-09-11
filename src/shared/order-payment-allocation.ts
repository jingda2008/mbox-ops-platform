export interface CollectibleOrder {id:string;submittedAt:string;outstandingMinor:number}
export interface OrderPaymentAllocation {orderId:string;amountMinor:number}
/** A new collection uses the locked balance snapshot; it never reprices an order. */
export function allocateOrderPayment(orders:readonly CollectibleOrder[],amountMinor:number):OrderPaymentAllocation[]{
 if(!orders.length||orders.length>100)throw new TypeError('每次请选择1至100笔同桌次订单')
 if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new TypeError('收款金额必须为正整数分')
 const ids=new Set<string>();let total=0
 for(const order of orders){
  if(!order.id||ids.has(order.id))throw new TypeError('不能重复选择同一订单')
  ids.add(order.id)
  if(!Number.isFinite(Date.parse(order.submittedAt)))throw new TypeError('订单提交时间无效，暂不能确定分摊顺序')
  if(!Number.isSafeInteger(order.outstandingMinor)||order.outstandingMinor<0)throw new TypeError('订单待收金额无效，请刷新账单')
  total+=order.outstandingMinor
  if(!Number.isSafeInteger(total))throw new TypeError('合计金额超过安全范围')
 }
 if(amountMinor>total)throw new TypeError('本次收款超过所选订单实际剩余应收，请刷新账单')
 let remaining=amountMinor
 const allocations:OrderPaymentAllocation[]=[]
 for(const order of [...orders].sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt)||a.id.localeCompare(b.id))){
  const value=Math.min(remaining,order.outstandingMinor)
  if(value>0){allocations.push({orderId:order.id,amountMinor:value});remaining-=value}
  if(remaining===0)break
 }
 return allocations
}
