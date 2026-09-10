import type {ScopedTransaction} from './transaction-runner.js'
import {DEFAULT_FULFILLMENT_SLA_SECONDS} from './fulfillment-sla.js'
import {UpgradeQualificationError} from './checkout-upgrade-eligibility.js'

export interface UpgradeOperationalPortion{productId:string;quantity:number;consumesInventory?:boolean;fulfillmentStation?:'bar'|'kitchen'|'cashier'|'none'}
/** Read-only snapshot, not a stock/capacity reservation or fulfillment promise.
 * Callers supply exact operational portions from authoritative quote expansion.
 * Keep duplicate product portions separate to match numeric(18,6) recipe
 * rounding in InventoryRepository.loadRecipeDemand before summing materials. */
export class CheckoutUpgradeAvailabilityRepository{
 constructor(private readonly tx:ScopedTransaction){}
 async assess(portions:readonly UpgradeOperationalPortion[]){
  if(!portions.length||portions.length>1000||portions.some(item=>!item||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(item.productId)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>100000||(item.consumesInventory!==undefined&&typeof item.consumesInventory!=='boolean')||(item.fulfillmentStation!==undefined&&!['bar','kitchen','cashier','none'].includes(item.fulfillmentStation))))throw new UpgradeQualificationError('实际制作商品或数量无效')
  const result=await this.tx.query<{available:boolean;inventory_known_and_sufficient:boolean;production_available:boolean}>(`
   WITH evaluated AS MATERIALIZED(SELECT clock_timestamp() AS at),requested AS(
    SELECT product_id,quantity,consumes_inventory,fulfillment_station FROM jsonb_to_recordset($3::jsonb) AS request(product_id uuid,quantity integer,consumes_inventory boolean,fulfillment_station text)
   ),products AS(
    SELECT p.id,p.status,p.inventory_control_mode,COALESCE(request.fulfillment_station,p.fulfillment_station) AS fulfillment_station,p.capacity_units,request.quantity,request.consumes_inventory,
      evaluated.at+make_interval(secs=>COALESCE(p.fulfillment_sla_seconds,($4::jsonb->>COALESCE(request.fulfillment_station,p.fulfillment_station))::integer)) AS due_at
    FROM requested request JOIN mbox.products p ON p.tenant_id=$1 AND p.store_id=$2 AND p.id=request.product_id CROSS JOIN evaluated
   ),recipes AS(
    SELECT p.id AS product_id,p.quantity,r.id AS recipe_id,r.yield_quantity
    FROM products p LEFT JOIN mbox.recipes r ON r.tenant_id=$1 AND r.store_id=$2 AND r.product_id=p.id AND r.status='active' AND r.effective_at<=(SELECT at FROM evaluated)
    WHERE p.inventory_control_mode='tracked' AND p.consumes_inventory
   ),demands AS(
    SELECT r.recipe_id,item.inventory_item_id,stock.status,
      (((item.quantity+item.expected_waste_quantity)*r.quantity::numeric)/r.yield_quantity::numeric)::numeric(18,6) AS required
    FROM recipes r LEFT JOIN mbox.recipe_items item ON item.tenant_id=$1 AND item.store_id=$2 AND item.recipe_id=r.recipe_id
    LEFT JOIN mbox.inventory_items stock ON stock.tenant_id=$1 AND stock.store_id=$2 AND stock.id=item.inventory_item_id
   ),materials AS(SELECT inventory_item_id,sum(required) AS required FROM demands GROUP BY inventory_item_id),
   production AS(
    SELECT p.id,p.quantity::bigint*p.capacity_units::bigint AS units,w.id AS window_id,w.capacity_limit_units
    FROM products p LEFT JOIN mbox.fulfillment_capacity_policy_versions policy ON policy.tenant_id=$1 AND policy.store_id=$2 AND policy.station_code=p.fulfillment_station AND policy.status='published'
    LEFT JOIN mbox.fulfillment_capacity_windows w ON w.tenant_id=$1 AND w.store_id=$2 AND w.policy_version_id=policy.id AND p.due_at>=w.starts_at AND p.due_at<w.ends_at
    WHERE p.fulfillment_station<>'none'
   ),capacity AS(SELECT window_id,max(capacity_limit_units) AS limit_units,sum(units) AS required FROM production GROUP BY window_id)
   SELECT (SELECT count(*) FROM products)=(SELECT count(*) FROM requested)
      AND NOT EXISTS(SELECT 1 FROM products WHERE status<>'active') AS available,
    NOT EXISTS(SELECT 1 FROM products WHERE consumes_inventory AND inventory_control_mode NOT IN('tracked','not_managed'))
      AND NOT EXISTS(SELECT 1 FROM recipes WHERE recipe_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM demands WHERE inventory_item_id IS NULL OR status IS DISTINCT FROM 'active' OR required IS NULL)
      AND NOT EXISTS(SELECT 1 FROM materials m LEFT JOIN mbox.inventory_balances b ON b.tenant_id=$1 AND b.store_id=$2 AND b.inventory_item_id=m.inventory_item_id WHERE b.inventory_item_id IS NULL OR b.on_hand_quantity-b.reserved_quantity<m.required) AS inventory_known_and_sufficient,
    NOT EXISTS(SELECT 1 FROM production WHERE window_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM capacity c WHERE c.required+COALESCE((SELECT sum(held.capacity_units) FROM mbox.fulfillment_capacity_reservations held WHERE held.tenant_id=$1 AND held.store_id=$2 AND held.capacity_window_id=c.window_id AND held.status IN('reserved','active')),0)>c.limit_units) AS production_available
  `,[this.tx.scope.tenantId,this.tx.scope.storeId,JSON.stringify(portions.map(item=>({product_id:item.productId,quantity:item.quantity,consumes_inventory:item.consumesInventory??true,fulfillment_station:item.fulfillmentStation??null}))),JSON.stringify(DEFAULT_FULFILLMENT_SLA_SECONDS)])
  const row=result.rows[0]
  return{inventoryReserved:false as const,capacityReserved:false as const,available:row?.available===true,inventoryKnownAndSufficient:row?.available===true&&row.inventory_known_and_sufficient===true,productionAvailable:row?.available===true&&row.production_available===true}
 }
}
