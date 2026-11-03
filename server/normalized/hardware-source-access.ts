import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {HardwarePolicyError} from './hardware-repository.js'
import {orderHistoryAccess} from './order-history-access.js'
import {currentRefundAttemptSql} from './refund-attempt-sql.js'
import {orderHasLegacyStockReturnSql} from './order-stock-return-capability.js'
import {profitPeriodRange} from './profit-query-service.js'

export class HardwareSourceAccessDeniedError extends Error {
  constructor(){super('当前员工无权访问此来源记录');this.name='HardwareSourceAccessDeniedError'}
}
export type HardwarePrintSource =
 | {kind:'order';id:string}
 | {kind:'table';id:string}
 | {kind:'day';date:string}
 | {kind:'operating';period:'day'|'month'|'year';anchorDate:string}

async function historyAuthority(tx:ScopedTransaction,employeeId:string,required:string[],requireHistory=true){
 const access=await new StaffAccessRepository(tx).resolve(employeeId)
 if(required.some(p=>!access.permissions.includes(p))||(requireHistory&&!access.permissions.some(p=>['order.history.view','order.history.all','reconciliation.view'].includes(p))))throw new HardwareSourceAccessDeniedError()
 const current=(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[tx.scope.tenantId,tx.scope.storeId])).rows[0]!.date
 return {access,current,earliest:orderHistoryAccess(access.permissions,current).earliestBusinessDate}
}
function unresolvedOrderSql(alias:string){
 return `(${alias}.status<>'cancelled' AND ${alias}.total_amount_minor>0 AND ${alias}.payment_status IN ('unpaid','pending','partially_paid'))
  OR EXISTS(SELECT 1 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
    WHERE p.tenant_id=${alias}.tenant_id AND p.store_id=${alias}.store_id AND COALESCE(r.order_id,p.order_id)=${alias}.id
      AND r.status IN ('requested','approved','processing','failed') AND ${currentRefundAttemptSql('r')})`
}

/** Shared by new commands, receipt replay and status tracking. Never generates a ticket. */
export async function authorizeHardwarePrintSource(tx:ScopedTransaction,employeeId:string,source:HardwarePrintSource){
 const required=['order.bill.print',...(source.kind==='day'?['reconciliation.view']:source.kind==='operating'?['commercial.profit.view']:[])]
 const {access,current,earliest}=await historyAuthority(tx,employeeId,required,source.kind!=='operating')
 const scope=[tx.scope.tenantId,tx.scope.storeId]
 if(source.kind==='order'){
  const visible=(await tx.query<{id:string}>(`SELECT o.id FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 AND o.status<>'draft'
    AND ($4::date IS NULL OR o.business_date>=$4::date OR ${unresolvedOrderSql('o')})`,[...scope,source.id,earliest])).rows[0]
  if(!visible)throw new HardwareSourceAccessDeniedError()
 }else if(source.kind==='table'){
  const hidden=(await tx.query<{count:string}>(`SELECT count(*)::text count FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status<>'draft' AND $4::date IS NOT NULL AND business_date<$4::date`,[...scope,source.id,earliest])).rows[0]!
  if(Number(hidden.count)>0)throw new HardwarePolicyError('本桌次含超出当前历史权限的订单，请由有全历史权限人员打印整桌账单；可继续查看本人权限内的单笔记录')
 }else{
  const start=source.kind==='day'?source.date:profitPeriodRange(source.period,source.anchorDate).startDate
  if(source.kind==='operating'&&start>current)throw new HardwarePolicyError('不提供未来实际经营期间')
  if(earliest&&start<earliest)throw new HardwarePolicyError('所选范围超出历史权限，请由有全历史权限的人员打印')
 }
 return access.displayName
}

export async function stockReturnSourceAccess(tx:ScopedTransaction,employeeId:string,itemId:string){
 const {earliest}=await historyAuthority(tx,employeeId,['inventory.receive'])
 const row=(await tx.query<{visible:boolean;work_exception:boolean}>(`SELECT
   ($4::date IS NULL OR o.business_date>=$4::date OR ${unresolvedOrderSql('o')} OR ${orderHasLegacyStockReturnSql('o')}) AS visible,
   (${unresolvedOrderSql('o')} OR ${orderHasLegacyStockReturnSql('o')}) AS work_exception
   FROM mbox.order_items item JOIN mbox.orders o ON o.tenant_id=item.tenant_id AND o.store_id=item.store_id AND o.id=item.order_id
   WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[tx.scope.tenantId,tx.scope.storeId,itemId,earliest])).rows[0]
 return {visible:row?.visible===true,workException:row?.work_exception===true}
}

/** A completed last-unit return removes the unfinished-work exception from the
 * order list. Preserve only that original, server-proven basis for its receipt;
 * current inventory/history permissions are still required on every replay. */
export async function authorizeStockReturnReplay(tx:ScopedTransaction,employeeId:string,itemId:string,authorization:unknown){
 const current=await stockReturnSourceAccess(tx,employeeId,itemId)
 if(current.visible)return
 if(!authorization||typeof authorization!=='object'||Array.isArray(authorization))throw new HardwareSourceAccessDeniedError()
 const proof=authorization as Record<string,unknown>
 if(proof.version!==1||proof.itemId!==itemId||proof.workException!==true||typeof proof.returnId!=='string')throw new HardwareSourceAccessDeniedError()
 const recorded=(await tx.query<{id:string}>(`SELECT id FROM mbox.order_stock_returns WHERE tenant_id=$1 AND store_id=$2
   AND id::text=$3 AND order_item_id=$4 AND created_by_employee_id=$5`,[tx.scope.tenantId,tx.scope.storeId,proof.returnId,itemId,employeeId])).rows[0]
 if(!recorded)throw new HardwareSourceAccessDeniedError()
}
