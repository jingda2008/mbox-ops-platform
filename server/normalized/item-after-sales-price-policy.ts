/** Store policy confirmed 2026-09-13. All values are original order facts in
 * minor currency units. This module neither issues money nor changes stock. */
export function remainingRefundCapacity(paidMinor:number,succeededRefundMinor:number,reservedRefundMinor:number):number{
  for(const amount of [paidMinor,succeededRefundMinor,reservedRefundMinor])money(amount)
  return Math.max(0,paidMinor-succeededRefundMinor-reservedRefundMinor)
}
export function pricePlainItemStop(input:{selectedOriginalMinor:number;paidMinor:number;succeededRefundMinor:number;reservedRefundMinor:number}){
  money(input.selectedOriginalMinor)
  const capacity=remainingRefundCapacity(input.paidMinor,input.succeededRefundMinor,input.reservedRefundMinor)
  return {cancelledAmountMinor:input.selectedOriginalMinor,refundAmountMinor:Math.min(input.selectedOriginalMinor,capacity)}
}
export function priceBrokenBundle(input:{components:readonly {originalSinglePriceMinor:number|null;retainedQuantity:number}[];otherEffectiveChargesMinor:number;paidMinor:number;succeededRefundMinor:number;reservedRefundMinor:number}){
  money(input.otherEffectiveChargesMinor)
  if(!input.components.length)throw new Error('原套餐组成缺失，须核对原单')
  let retained=0n
  for(const part of input.components){
    if(!Number.isSafeInteger(part.retainedQuantity)||part.retainedQuantity<0)throw new Error('套餐保留数量无效')
    if(part.retainedQuantity===0)continue
    if(part.originalSinglePriceMinor===null)throw new Error('缺少下单时单点原价，须核对原单，不能使用当前菜单价')
    money(part.originalSinglePriceMinor)
    retained+=BigInt(part.originalSinglePriceMinor)*BigInt(part.retainedQuantity)
  }
  const total=retained+BigInt(input.otherEffectiveChargesMinor)
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('重算金额超出安全范围')
  const capacity=remainingRefundCapacity(input.paidMinor,input.succeededRefundMinor,input.reservedRefundMinor)
  const effectiveAmountMinor=Number(total)
  return {retainedBundleAmountMinor:Number(retained),effectiveAmountMinor,
    refundAmountMinor:Math.max(0,capacity-effectiveAmountMinor),
    outstandingAmountMinor:Math.max(0,effectiveAmountMinor-capacity)}
}
function money(value:number){if(!Number.isSafeInteger(value)||value<0)throw new Error('原金额必须是非负整数分')}
