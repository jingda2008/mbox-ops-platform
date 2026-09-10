import type {ScopedTransaction} from './transaction-runner.js'
import {InventoryConflictError} from './inventory-repository.js'

export class OrderStockReturnRepository {
 constructor(private readonly tx:ScopedTransaction){}
 async record(input:{orderItemId:string;quantity:number;disposition:'unmade'|'returned_unopened';reason:string;employeeId:string;unopenedConfirmed:boolean}){
  if(!Number.isSafeInteger(input.quantity)||input.quantity<1)throw new InventoryConflictError('退回数量必须为正整数')
  if(!['unmade','returned_unopened'].includes(input.disposition)||input.reason.trim().length<3||input.reason.length>1000)throw new InventoryConflictError('请选择退库原因并填写说明')
  if(input.disposition==='returned_unopened'&&!input.unopenedConfirmed)throw new InventoryConflictError('必须确认商品未开封且已实际退回')
  const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
  // All returns for an item serialize here; never infer units from refund money.
  const item=(await this.tx.query<{id:string;order_id:string;quantity:number;status:string}>(`
   SELECT id,order_id,quantity,status FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...scope,input.orderItemId])).rows[0]
  if(!item)throw new InventoryConflictError('商品记录不存在')
  const refunded=(await this.tx.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.refunds r JOIN mbox.payments p
   ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
   WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.order_id=$3 AND r.status='succeeded') AS ok`,[...scope,item.order_id])).rows[0]?.ok
  if(!refunded)throw new InventoryConflictError('尚无确认成功的退款；不会因退款申请直接恢复库存')
  const redemption=(await this.tx.query<{id:string}>('SELECT id FROM mbox.member_redemptions WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3',[...scope,item.order_id])).rows[0]
  if(redemption)throw new InventoryConflictError('积分兑换商品须使用兑换恢复流程，不能重复退库')
  const tasks=await this.tx.query<{status:string;accepted_at:string|null;ready_at:string|null}>(`
   SELECT status,accepted_at,ready_at FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY id FOR UPDATE`,[...scope,item.id])
  if(input.disposition==='unmade'&&(item.status!=='cancelled'||tasks.rows.some(task=>task.accepted_at!==null||task.ready_at!==null||!['cancelled','failed'].includes(task.status))))throw new InventoryConflictError('未制作退库须先停止出品；已有制作记录不能自动恢复原料')
  if(input.disposition==='returned_unopened'&&!['delivered','cancelled'].includes(item.status))throw new InventoryConflictError('商品仍在履约中，请先核对送达或停止出品，不能边制作边退库')
  const previous=Number((await this.tx.query<{quantity:string}>(`SELECT COALESCE(sum(quantity),0)::text AS quantity FROM mbox.order_stock_returns WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3`,[...scope,item.id])).rows[0]!.quantity)
  if(previous+input.quantity>item.quantity)throw new InventoryConflictError('累计退回数量超过原商品数量')
  const reservations=(await this.tx.query<{id:string;inventory_item_id:string;status:string;quantity:string}>(`
   SELECT id,inventory_item_id,status,quantity::text FROM mbox.inventory_order_reservations WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY inventory_item_id,id FOR UPDATE`,[...scope,item.id])).rows
  if(!reservations.length||reservations.some(row=>row.status!=='consumed'))throw new InventoryConflictError('没有可退的已扣减库存，或预留已释放/库存已经返还；不会重复加库存')
  if(input.disposition==='returned_unopened'){
   const packaged=(await this.tx.query<{ok:boolean}>(`SELECT count(*)=1 AND bool_and(
    CASE WHEN inventory.base_unit='ml' AND inventory.item_type='bottle' THEN inventory.package_volume_ml>0 AND mod(reservation.quantity/$4::numeric,inventory.package_volume_ml)=0
    WHEN inventory.base_unit IN ('bottle','piece') AND inventory.item_type IN ('bottle','food') THEN reservation.quantity/$4::numeric>=1 AND mod(reservation.quantity/$4::numeric,1)=0 ELSE false END) AS ok
    FROM mbox.inventory_order_reservations reservation JOIN mbox.inventory_items inventory
    ON inventory.tenant_id=reservation.tenant_id AND inventory.store_id=reservation.store_id AND inventory.id=reservation.inventory_item_id
    WHERE reservation.tenant_id=$1 AND reservation.store_id=$2 AND reservation.order_item_id=$3`,[...scope,item.id,item.quantity])).rows[0]?.ok
   if(!packaged)throw new InventoryConflictError('此商品不是可核对的整包装单一库存商品，不能把已制作配方或散装酒恢复成原料；请按库存盘点核实实际退回物')
  }
  const result=(await this.tx.query<{id:string}>(`INSERT INTO mbox.order_stock_returns(tenant_id,store_id,order_item_id,quantity,disposition,reason,created_by_employee_id)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[...scope,item.id,input.quantity,input.disposition,input.reason.trim(),input.employeeId])).rows[0]!
  for(const reservation of reservations){
   // Use database decimal arithmetic. Final partial return consumes the exact remaining fraction.
   const amount=(await this.tx.query<{quantity:string}>(`SELECT CASE WHEN $5::integer=$6::integer THEN $3::numeric-COALESCE(sum(quantity),0)
    ELSE round($3::numeric*$4::integer/$6::integer,6) END::text AS quantity
    FROM mbox.order_stock_return_movements WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$7`,
   [...scope,reservation.quantity,input.quantity,previous+input.quantity,item.quantity,reservation.id])).rows[0]!.quantity
   if(Number(amount)<=0)throw new InventoryConflictError('退库数量低于库存计量精度，请合并处理')
   const movement=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,reason,created_by_employee_id,unit_cost_minor)
    VALUES($1,$2,$3,'return',$4::numeric,'order_stock_return',$5,$6,$7,$8,
      (SELECT original.unit_cost_minor FROM mbox.inventory_order_reservations reservation JOIN mbox.inventory_movements original
       ON original.tenant_id=reservation.tenant_id AND original.store_id=reservation.store_id AND original.id=reservation.movement_id
       WHERE reservation.tenant_id=$1 AND reservation.store_id=$2 AND reservation.id=$9)) RETURNING id`,[...scope,reservation.inventory_item_id,amount,result.id,item.id,input.reason.trim(),input.employeeId,reservation.id])).rows[0]!
   const balance=await this.tx.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity+$4::numeric,last_movement_id=$5
    WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3`,[...scope,reservation.inventory_item_id,amount,movement.id])
   if(balance.rowCount!==1)throw new InventoryConflictError('库存余额记录缺失，退库未执行')
   await this.tx.query(`INSERT INTO mbox.order_stock_return_movements(tenant_id,store_id,return_id,reservation_id,movement_id,quantity) VALUES($1,$2,$3,$4,$5,$6::numeric)`,[...scope,result.id,reservation.id,movement.id,amount])
  }
  return {id:result.id,orderItemId:item.id,quantity:input.quantity,disposition:input.disposition}
 }
}
