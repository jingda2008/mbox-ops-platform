import {ItemQuantityConflict} from './order-item-quantity-plan.js'

export interface RemakeMaterialFact {
  id:string;inventoryItemId:string;quantity:string;status:'consumed'|'used_loss'|'reserved'|'released'|'returned'
  consumptionMovementId:string|null
}
export interface RemakeUnitFact {
  id:string;index:number;productionState:'unmade'|'started'|'ready'|'delivered'
  held:boolean;stopped:boolean;hasActiveRemake:boolean;hasActiveRedelivery:boolean
  inventoryEvidence:'allocated'|'untracked'|'unresolved';materials:readonly RemakeMaterialFact[]
}

/** Plans a new physical production batch; never rewinds original fulfillment,
 * refunds a payment, charges a guest, or deducts the old materials again.
 * Execution must atomically record actual old loss, reserve the new material
 * lots and create the related production task. This planner alone is not an
 * enabled business path. */
export function planQuantityRemake(input:{units:readonly RemakeUnitFact[];quantity:number;originalGoodsLost:boolean}){
  if(!input.originalGoodsLost)throw new ItemQuantityConflict('PRODUCTION_REVIEW_REQUIRED','请先确认原商品确已无法交付；原实物仍在时使用补送')
  if(!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>999)throw new ItemQuantityConflict('QUANTITY_INVALID','请选择实际重新制作的份数')
  if(new Set(input.units.map(unit=>unit.id)).size!==input.units.length||new Set(input.units.map(unit=>unit.index)).size!==input.units.length)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原商品份数标识不完整')
  const eligible=input.units.filter(unit=>unit.productionState!=='unmade'&&!unit.held&&!unit.stopped&&!unit.hasActiveRemake&&!unit.hasActiveRedelivery).toSorted((a,b)=>a.index-b.index)
  if(eligible.length<input.quantity)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前可重新制作 ${eligible.length} 份，请先核对原商品或已有补救任务`)
  const selected=eligible.slice(0,input.quantity),materialIds=new Set<string>()
  for(const unit of selected){
    if(unit.inventoryEvidence==='unresolved'||unit.inventoryEvidence==='allocated'&&unit.materials.length===0||unit.inventoryEvidence==='untracked'&&unit.materials.length>0)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原材料记录尚未核对，不能猜测重做耗料')
    for(const material of unit.materials){
      if(materialIds.has(material.id))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原材料重复归入多份商品')
      materialIds.add(material.id)
      if(!['consumed','used_loss'].includes(material.status)||!material.consumptionMovementId)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原材料未有实际消耗或已退回，不能再次认定损耗')
      if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(material.quantity)||!/[1-9]/.test(material.quantity))throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原材料用量精度或数量无效')
    }
  }
  return {
    unitIds:selected.map(unit=>unit.id),quantity:selected.length,
    originalLossStockIds:selected.flatMap(unit=>unit.materials.filter(material=>material.status==='consumed').map(material=>material.id)),
    materials:selected.flatMap(unit=>unit.materials.map(material=>({sourceUnitId:unit.id,sourceStockId:material.id,inventoryItemId:material.inventoryItemId,quantity:material.quantity,originalConsumptionMovementId:material.consumptionMovementId!}))),
    inventoryAction:'reserve_new_batch' as const,financialAction:'none' as const,
  }
}
