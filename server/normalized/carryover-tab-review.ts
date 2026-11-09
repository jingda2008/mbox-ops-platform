import type {JsonObject} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {RecollectionAuthorizationConflictError} from './recollection-authorization-repository.js'

export async function confirmCarryoverTabReview(tx:ScopedTransaction,input:Readonly<{
  orderId:string;employeeId:string;amountMinor:number;basis:JsonObject;reason:string
}>):Promise<JsonObject> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0 || input.reason.trim().length < 4 || input.reason.trim().length > 500) {
    throw new RecollectionAuthorizationConflictError('核对金额或依据无效')
  }
  try {
    const result=await tx.query<{result:JsonObject}>(
      'SELECT mbox.confirm_carryover_tab_review($1,$2,$3,$4,$5,$6::jsonb,$7) result',
      [tx.scope.tenantId,tx.scope.storeId,input.orderId,input.employeeId,input.amountMinor,JSON.stringify(input.basis),input.reason.trim()],
    )
    return result.rows[0]!.result
  } catch(error) {
    if (error && typeof error === 'object' && 'code' in error && ['55000','23505','42501'].includes(String(error.code))) {
      throw new RecollectionAuthorizationConflictError('挂账核对依据、权限或处理状态已变化，请刷新后核对原单')
    }
    throw error
  }
}

export function pendingTabReviewSql(order:string):string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order alias')
  return `EXISTS(SELECT 1 FROM mbox.order_carryover_reviews review
    WHERE (review.tenant_id,review.store_id,review.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_carryover_review_decisions decision
      WHERE (decision.tenant_id,decision.store_id,decision.order_id)=(review.tenant_id,review.store_id,review.order_id)))`
}

export interface DirectCarryoverCollection {
  basis: JsonObject
  receivableMinor: number
}

/** Runs only in the payment mutation, so a failed receipt rolls back the debt too. */
export async function prepareDirectCarryoverCollection(tx: ScopedTransaction, input: Readonly<{
  orderId: string; employeeId: string; provider: string; collection: DirectCarryoverCollection
}>): Promise<void> {
  const {receivableMinor,basis}=input.collection
  if(!Number.isSafeInteger(receivableMinor)||receivableMinor<=0)throw new RecollectionAuthorizationConflictError('收款原单金额无效')
  try {
    await tx.query('SELECT mbox.prepare_carryover_collection($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
      [tx.scope.tenantId,tx.scope.storeId,input.orderId,input.employeeId,receivableMinor,JSON.stringify(basis),
        '员工直接发起收款，按所展示原单金额建立应收；制作及桌次状态保持',input.provider])
  } catch(error) {
    if(error&&typeof error==='object'&&'code' in error&&['55000','23505','42501'].includes(String(error.code)))
      throw new RecollectionAuthorizationConflictError('原单金额或收款状态已变化，请刷新后发起收款')
    throw error
  }
}
