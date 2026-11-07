import type {ScopedTransaction} from './transaction-runner.js'

export interface CarryoverDebt {
  eligibility: 'confirmed' | 'review_required'
  receivableMinor: number
  reviewReason: string | null
}

const schemaAvailability=new WeakMap<ScopedTransaction,Promise<boolean>>()
/** Migration replay tests and rolling maintenance can still use pre-300 schemas. */
export function hasCarryoverDebtSchema(tx:ScopedTransaction):Promise<boolean>{
  let available=schemaAvailability.get(tx)
  if(!available){available=tx.query<{present:boolean}>("SELECT to_regclass('mbox.order_carryover_debts') IS NOT NULL AS present").then(result=>result.rows[0]?.present===true);schemaAvailability.set(tx,available)}
  return available
}

/** Read only; mutation callers must first lock session -> order. */
export async function readCarryoverDebt(tx: ScopedTransaction, orderId: string): Promise<CarryoverDebt | null> {
  if(!await hasCarryoverDebtSchema(tx))return null
  const result = await tx.query<{eligibility: CarryoverDebt['eligibility']; receivable_minor: string; review_reason: string | null}>(`
    SELECT mbox.carryover_collection_eligibility(tenant_id,store_id,order_id) AS eligibility,receivable_minor::text,
      COALESCE(review_reason,'存在退款或关桌后金额调整，请核对原单及实收后处理') AS review_reason FROM mbox.order_carryover_debts
    WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`, [tx.scope.tenantId,tx.scope.storeId,orderId])
  const row=result.rows[0]
  if (!row) return null
  const receivableMinor=Number(row.receivable_minor)
  if (!Number.isSafeInteger(receivableMinor) || receivableMinor<=0) throw new RangeError('历史应收金额无效')
  return {eligibility:row.eligibility,receivableMinor,reviewReason:row.review_reason}
}

export function carryoverDebtSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order alias')
  return `EXISTS(SELECT 1 FROM mbox.order_carryover_debts carry_debt
    WHERE (carry_debt.tenant_id,carry_debt.store_id,carry_debt.order_id)=(${order}.tenant_id,${order}.store_id,${order}.id))`
}
