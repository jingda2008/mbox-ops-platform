import {createHash} from 'node:crypto'
import type {SubmitOrderLineInput} from './order-repository.js'

/** Internal quote authority only. HTTP order lines cannot provide discounts. */
export interface PricingLineAllocation{
  requestIndex:number
  productId:string
  quantity:number
  unitPriceMinor:number
  discountAmountMinor:number
  lineFingerprint:string
}
export function pricingLineFingerprint(line:SubmitOrderLineInput):string{
  return createHash('sha256').update(JSON.stringify({
    productId:line.productId,quantity:line.quantity,note:line.note?.trim()||null,
    bundleSelections:(line.bundleSelections??[]).map(unit=>({groups:unit.groups.map(group=>({
      groupId:group.groupId,productIds:[...group.productIds],
    }))})),
  })).digest('hex')
}
/** Snapshot and validate the full allocation before freezing authority. Omitting
 * zero-discount lines would allow unrelated items to be silently substituted. */
export function verifyPricingLineAllocations(
  value:readonly PricingLineAllocation[],lines:readonly SubmitOrderLineInput[],amountMinor:number,
):readonly Readonly<PricingLineAllocation>[] {
  if(!Array.isArray(value)||value.length!==lines.length||value.length<1||value.length>100)throw new TypeError('报价分摊必须覆盖全部订单行')
  let total=0n
  const frozen=value.map((row,index)=>{
    const line=lines[index]!
    if(!row||row.requestIndex!==index||row.productId!==line.productId||row.quantity!==line.quantity
      ||row.lineFingerprint!==pricingLineFingerprint(line))throw new TypeError('报价商品、份数或选项已变化，请重新确认')
    if(!Number.isSafeInteger(row.unitPriceMinor)||row.unitPriceMinor<0
      ||!Number.isSafeInteger(row.discountAmountMinor)||row.discountAmountMinor<0
      ||!Number.isSafeInteger(row.quantity)||row.quantity<1)throw new TypeError('报价分摊金额无效')
    const gross=BigInt(row.unitPriceMinor)*BigInt(row.quantity)
    if(gross>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(row.discountAmountMinor)>gross)throw new TypeError('报价分摊不能超过对应商品金额')
    total+=BigInt(row.discountAmountMinor)
    return Object.freeze({requestIndex:index,productId:row.productId,quantity:row.quantity,
      unitPriceMinor:row.unitPriceMinor,discountAmountMinor:row.discountAmountMinor,lineFingerprint:row.lineFingerprint})
  })
  if(!Number.isSafeInteger(amountMinor)||amountMinor<0||total!==BigInt(amountMinor))throw new TypeError('报价分摊与授权优惠总额不一致')
  return Object.freeze(frozen)
}
