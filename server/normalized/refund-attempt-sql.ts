/** Retain failed-attempt history, but only its current replacement can remain
 * operationally outstanding. This does not ignore an unlinked failure. */
export function currentRefundAttemptSql(refund:string):string {
  if(!/^[a-z_]+$/.test(refund))throw new TypeError('Invalid refund SQL alias')
  return `NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries superseded
    WHERE superseded.tenant_id=${refund}.tenant_id AND superseded.store_id=${refund}.store_id AND superseded.previous_refund_id=${refund}.id)`
}

/** A failed execution does not revoke its still-approved quantity decision.
 * Reserve only the current attempt; replacing it transfers, not duplicates, the amount. */
export function approvedFailedRefundReservesSql(refund:string):string {
  const current=currentRefundAttemptSql(refund)
  return `(${refund}.status='failed' AND ${current} AND EXISTS(
    SELECT 1 FROM mbox.item_after_sales_case_refunds amount_link
    JOIN mbox.item_after_sales_cases amount_case ON amount_case.tenant_id=amount_link.tenant_id
      AND amount_case.store_id=amount_link.store_id AND amount_case.id=amount_link.case_id
    WHERE amount_link.tenant_id=${refund}.tenant_id AND amount_link.store_id=${refund}.store_id
      AND amount_link.refund_id=${refund}.id AND amount_case.status='approved'))`
}

export function refundReservesAmountSql(refund:string):string {
  return `(${refund}.status IN ('requested','approved','processing','succeeded') OR ${approvedFailedRefundReservesSql(refund)})`
}
