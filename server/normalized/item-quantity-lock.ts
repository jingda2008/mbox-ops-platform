import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Quantity commands take the table-session lock before order/task/item locks.
 * A concurrent transfer is retried from its new identity, never followed using
 * an old session lock while mutating the order at its new table. */
export async function lockQuantityOrder(tx:ScopedTransaction,target:{kind:'item'|'case'|'order';id:string},includePaymentGroup=false){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const join=target.kind==='item'?'JOIN mbox.order_items source ON source.tenant_id=o.tenant_id AND source.store_id=o.store_id AND source.order_id=o.id'
    :target.kind==='case'?'JOIN mbox.item_after_sales_cases source ON source.tenant_id=o.tenant_id AND source.store_id=o.store_id AND source.order_id=o.id':''
  const lookup=(await tx.query<{id:string;table_session_id:string}>(`SELECT o.id,o.table_session_id FROM mbox.orders o ${join}
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND ${target.kind==='order'?'o':'source'}.id=$3`,[...scope,target.id])).rows[0]
  if(!lookup)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原订单或商品申请不存在')
  const related=async()=>includePaymentGroup?(await tx.query<{id:string;table_session_id:string}>(`SELECT original.id,original.table_session_id FROM mbox.orders original
    WHERE original.tenant_id=$1 AND original.store_id=$2 AND (original.id=$3 OR EXISTS(
      SELECT 1 FROM mbox.order_payment_allocations source JOIN mbox.order_payment_allocations peer
        ON peer.tenant_id=source.tenant_id AND peer.store_id=source.store_id AND peer.batch_id=source.batch_id
      JOIN mbox.payments payment ON payment.tenant_id=source.tenant_id AND payment.store_id=source.store_id AND payment.order_batch_id=source.batch_id
      WHERE source.tenant_id=original.tenant_id AND source.store_id=original.store_id AND source.order_id=$3 AND peer.order_id=original.id
        AND payment.status IN ('succeeded','partially_refunded','refunded'))) ORDER BY original.id`,[...scope,lookup.id])).rows:[lookup]
  const group=await related(),ids=group.map(order=>order.id).sort(),sessionIds=[...new Set(group.map(order=>order.table_session_id))].sort()
  const sessions=await tx.query(`SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`,[...scope,sessionIds])
  if(sessions.rowCount!==sessionIds.length)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原桌次记录不存在')
  const locked=(await tx.query<{id:string;table_session_id:string}>(`SELECT id,table_session_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,[...scope,ids])).rows
  const order=locked.find(order=>order.id===lookup.id)
  if(!order||locked.length!==group.length||locked.some(order=>group.find(original=>original.id===order.id)?.table_session_id!==order.table_session_id))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','订单刚刚转桌，请按新桌次读回后继续；本次尚未处理商品')
  if(includePaymentGroup&&JSON.stringify((await related()).map(order=>order.id).sort())!==JSON.stringify(ids))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原合并付款刚刚更新，请读取结果后继续')

  return {orderId:order.id,tableSessionId:order.table_session_id}
}
