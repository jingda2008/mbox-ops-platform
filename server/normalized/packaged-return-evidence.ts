import type {ScopedTransaction} from './transaction-runner.js'
export interface PackagedReturnEligibility {canReturn:boolean;reason:string|null}
interface Fact extends Record<string,unknown>{unit_id:string;quantity:string;base_unit:string;item_type:string;package_volume_ml:string|null;trusted:boolean;sales_spec:string|null}
/** Shares the exact read-only eligibility calculation between preview and execution. */
export async function readPackagedReturnEligibility(tx:ScopedTransaction,unitIds:readonly string[],remake=false):Promise<Map<string,PackagedReturnEligibility>>{
  if(!unitIds.length)return new Map()
  const table=remake?'quantity_remake_stocks':'order_item_unit_inventory',unitColumn=remake?'remake_unit_id':'unit_id'
  const snapshot=remake?'stock.packaging_snapshot':"COALESCE(reservation.packaging_snapshot,CASE WHEN stock.reservation_id IS NULL THEN movement.metadata->'packagingEvidence' END)"
  const facts=(await tx.query<Fact>(`SELECT stock.${unitColumn} AS unit_id,stock.quantity::text,
    COALESCE((${snapshot})->>'baseUnit',inventory.base_unit) AS base_unit,
    COALESCE((${snapshot})->>'itemType',inventory.item_type) AS item_type,
    CASE WHEN ${snapshot} IS NOT NULL THEN (${snapshot})->>'packageVolumeMl' ELSE inventory.package_volume_ml::text END AS package_volume_ml,
    (${snapshot} IS NOT NULL OR inventory.updated_at<=COALESCE(${remake?'stock.created_at':'reservation.reserved_at'},movement.occurred_at)) AS trusted,
    item.product_snapshot->'source'->>'salesSpecificationType' AS sales_spec
    FROM mbox.${table} stock
    JOIN mbox.inventory_items inventory ON inventory.tenant_id=stock.tenant_id AND inventory.store_id=stock.store_id AND inventory.id=stock.inventory_item_id
    ${remake?`JOIN mbox.quantity_remake_units unit ON unit.tenant_id=stock.tenant_id AND unit.store_id=stock.store_id AND unit.id=stock.remake_unit_id
    JOIN mbox.order_item_quantity_units original_unit ON original_unit.tenant_id=unit.tenant_id AND original_unit.store_id=unit.store_id AND original_unit.id=unit.unit_id`:`JOIN mbox.order_item_quantity_units original_unit ON original_unit.tenant_id=stock.tenant_id AND original_unit.store_id=stock.store_id AND original_unit.id=stock.unit_id
    LEFT JOIN mbox.inventory_order_reservations reservation ON reservation.tenant_id=stock.tenant_id AND reservation.store_id=stock.store_id AND reservation.id=stock.reservation_id`}
    JOIN mbox.order_items item ON item.tenant_id=original_unit.tenant_id AND item.store_id=original_unit.store_id AND item.id=original_unit.order_item_id
    LEFT JOIN mbox.inventory_movements movement ON movement.tenant_id=stock.tenant_id AND movement.store_id=stock.store_id AND movement.id=${remake?'stock.consumption_movement_id':'COALESCE(stock.consumption_movement_id,stock.original_movement_id)'}
    WHERE stock.tenant_id=$1 AND stock.store_id=$2 AND stock.${unitColumn}=ANY($3::uuid[])`,[tx.scope.tenantId,tx.scope.storeId,unitIds])).rows
  return new Map(unitIds.map(id=>[id,packagedReturnEligibility(facts.filter(fact=>fact.unit_id===id))]))
}
function decimal(value:string):bigint|null{if(!/^\d+(?:\.\d{1,6})?$/.test(value))return null;const [whole,fraction='']=value.split('.');return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,'0'))}
export function packagedReturnEligibility(facts:readonly Fact[]):PackagedReturnEligibility{
  const fail=(reason:string)=>({canReturn:false,reason})
  if(!facts.length)return fail('缺少原库存扣减证据，请交库存负责人核对；不能凭退款回库。')
  if(facts.length!==1)return fail('该份涉及多项库存材料，配方成品不能恢复为原料；请核对实物去向。')
  const fact=facts[0]!
  if(!fact.trusted)return fail('原包装规格缺少可靠记录或已变更，请交库存负责人核对原批次，不按当前档案猜测回库。')
  if(fact.sales_spec&&['glass','cup','shot','pitcher','custom'].includes(fact.sales_spec))return fail('原单为分装或配方商品，不能按整包装回库；请核对实物去向。')
  const quantity=decimal(fact.quantity)
  if(fact.base_unit==='ml'&&fact.item_type==='bottle'){
    const volume=fact.package_volume_ml&&decimal(fact.package_volume_ml)
    if(!volume||volume<=0n)return fail('原包装容量缺失，请交库存负责人核对。')
    if(quantity===null||quantity<=0n||quantity%volume!==0n)return fail(`原记录扣减${Number(fact.quantity)}毫升，与包装记录${Number(fact.package_volume_ml)}毫升/瓶不一致，暂不能确认退库，请交库存负责人核对。`)
    return {canReturn:true,reason:null}
  }
  if(['bottle','piece'].includes(fact.base_unit)&&['bottle','food'].includes(fact.item_type)&&quantity!==null&&quantity>=1000000n&&quantity%1000000n===0n)return {canReturn:true,reason:null}
  return fail('仅可核对的单一整包装商品能退回原库存，配方成品不能恢复为原料。')
}
