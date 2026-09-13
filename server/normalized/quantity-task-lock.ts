import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Shared lock order for production, delivery and item after-sales. The scoped
 * task lookup stays bounded; display joins are not part of the lock query. */
export async function lockQuantityTaskOrders(tx:ScopedTransaction,taskIds:readonly string[]){
  if(!taskIds.length||taskIds.length>50||new Set(taskIds).size!==taskIds.length)throw new ItemQuantityConflict('QUANTITY_INVALID','制作任务选择无效')
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const targets=(await tx.query<{task_id:string;order_id:string;session_id:string}>(`SELECT task.id AS task_id,original.id AS order_id,original.table_session_id AS session_id
    FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
    JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=ANY($3::uuid[]) ORDER BY task.id`,[...scope,taskIds])).rows
  if(targets.length!==taskIds.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原制作任务不存在或不可访问')
  const sessions=[...new Set(targets.map(target=>target.session_id))].sort(),orders=[...new Set(targets.map(target=>target.order_id))].sort()
  await tx.query('SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE',[...scope,sessions])
  const locked=(await tx.query<{id:string;table_session_id:string}>('SELECT id,table_session_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[...scope,orders])).rows
  if(locked.length!==orders.length||targets.some(target=>locked.find(order=>order.id===target.order_id)?.table_session_id!==target.session_id))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','桌台归属已变化，请读取最新桌号后继续原任务')
}
