import {ItemQuantityConflict} from './order-item-quantity-plan.js'

export interface RedeliveryUnitFact {
  id:string
  index:number
  productionState:'unmade'|'started'|'ready'|'delivered'
  held:boolean
  stopped:boolean
  hasActiveRedelivery:boolean
}

/** Correct a recorded delivery using the very same prepared goods. This is not
 * a remake or an inventory return. Ready goods use the existing delivery queue. */
export function planOriginalGoodsRedelivery(input:{units:readonly RedeliveryUnitFact[];quantity:number;originalGoodsAvailable:boolean}){
  if(!input.originalGoodsAvailable)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','请先确认原实物还在且可送；需要重新制作时不能使用原实物补送')
  if(!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>999)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择实际需要补送的份数')
  if(new Set(input.units.map(unit=>unit.id)).size!==input.units.length||new Set(input.units.map(unit=>unit.index)).size!==input.units.length)
    throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原份数记录不一致，请读回原商品')
  const available=input.units.filter(unit=>unit.productionState==='delivered'&&!unit.held&&!unit.stopped&&!unit.hasActiveRedelivery).sort((a,b)=>a.index-b.index)
  if(input.quantity>available.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前可登记原实物补送 ${available.length} 份；尚待送达的商品请继续原取送任务`)
  return {unitIds:available.slice(0,input.quantity).map(unit=>unit.id),quantity:input.quantity,inventoryAction:'reuse_original' as const}
}
