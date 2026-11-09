import type {ScopedTransaction} from './transaction-runner.js'
import {lockClosedDebtRecovery,assertClosedDebtWritable} from './closed-debt-recovery.js'
import {NormalizedPaymentCapabilityAuthorization,assertCarryoverCollectionScope} from './payment-security-policy.js'
import {HistoricalCollectionChangedError} from './payment-command-service.js'

/** Session -> order -> payment, before taking the provider-action/payment lock. */
export async function lockCarryoverPaymentAdmission(tx:ScopedTransaction,paymentId:string,employeeId:string):Promise<boolean>{
  const row=(await tx.query<{order_id:string;amount_minor:string;status:string;retry_released_at:string|null}>(`
    SELECT p.order_id,p.amount_minor::text,p.status,p.retry_released_at::text
    FROM mbox.payments p JOIN mbox.order_carryover_debts d
      ON (d.tenant_id,d.store_id,d.order_id)=(p.tenant_id,p.store_id,p.order_id)
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3 AND p.payable_kind='order'`,[tx.scope.tenantId,tx.scope.storeId,paymentId])).rows[0]
  if(!row)return false
  const authority=new NormalizedPaymentCapabilityAuthorization()
  await authority.assertEmployeeCapability({transaction:tx,employeeId,capability:'payment.initiate.staff'})
  await assertCarryoverCollectionScope(tx,employeeId,row.order_id)
  const recovery=await lockClosedDebtRecovery(tx,row.order_id)
  if(!recovery?.carryover)throw new HistoricalCollectionChangedError('原历史欠款归属已变化，请核对原单')
  if(['created','pending'].includes(row.status)){
    assertClosedDebtWritable(recovery)
    if(row.retry_released_at||Number(row.amount_minor)>recovery.outstandingAmountMinor)throw new HistoricalCollectionChangedError('原付款金额或重试状态已变化，请先查询原付款，再按当前欠款收取')
  }
  return true
}
