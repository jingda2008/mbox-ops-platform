import type {ScopedTransaction} from './transaction-runner.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemAfterSalesProgressRepository} from './item-after-sales-progress-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** A replacement is a new, normally priced order. Linking it never approves,
 * refunds, resumes or changes the original goods and their money. */
export class ItemAfterSalesReplacementRepository {
  constructor(private readonly tx:ScopedTransaction){}
  async lockSource(input:{caseId:string;employeeId:string;tableSessionId:string;previousOrderId?:string}) {
    await assertEmployeeEffectivePermission(this.tx,input.employeeId,'refund.request')
    await assertEmployeeEffectivePermission(this.tx,input.employeeId,'order.create')
    const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
    // Reject another visit before taking its locks. The authoritative assisted
    // order context has already verified the employee's access to this visit.
    const original=(await this.tx.query<{table_session_id:string}>(`SELECT original.table_session_id FROM mbox.item_after_sales_cases target
      JOIN mbox.orders original ON original.tenant_id=target.tenant_id AND original.store_id=target.store_id AND original.id=target.order_id
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3`,[...scope,input.caseId])).rows[0]
    if(!original||original.table_session_id!==input.tableSessionId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','换品新单必须关联原桌次，请重新打开原商品核对所在桌')
    const locked=await lockQuantityOrder(this.tx,{kind:'case',id:input.caseId})
    if(locked.tableSessionId!==input.tableSessionId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原订单刚刚转桌，请读回后继续换品')
    const visit=(await this.tx.query<{status:string}>('SELECT status FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,input.tableSessionId])).rows[0]
    if(visit?.status!=='open')throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原桌次已结束，请按客人本次到店正常点单，原售后仍保留')
    const current=await new ItemAfterSalesProgressRepository(this.tx).read(input.caseId)
    if(current.revisedByCaseId||!['requested','approved','completed'].includes(current.status)||current.heldQuantity+current.stoppedQuantity===0)
      throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原申请已经修改、撤回或恢复，请先核对原商品，再确定是否换品')
    if(current.replacementOrder&&(current.replacementOrder.status!=='cancelled'||input.previousOrderId!==current.replacementOrder.orderId))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`原申请已有换品新单 ${current.replacementOrder.publicId}，请从原桌订单继续处理`)
    if(!current.replacementOrder&&input.previousOrderId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原换品记录已变化，请读回后继续')
  }
  async link(input:{caseId:string;orderId:string;employeeId:string;previousOrderId?:string}) {
    await this.tx.query(`INSERT INTO mbox.item_after_sales_replacement_orders(tenant_id,store_id,root_case_id,case_id,order_id,employee_id,previous_order_id)
      VALUES($1,$2,mbox.item_after_sales_root_case_id($1,$2,$3),$3,$4,$5,$6)`,[this.tx.scope.tenantId,this.tx.scope.storeId,input.caseId,input.orderId,input.employeeId,input.previousOrderId??null])
  }
}
