/** These dates are operating-day labels, already resolved by the store clock.
 * Never subtract 72 hours from the client wall clock. */
export function orderHistoryAccess(permissions: readonly string[], currentBusinessDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentBusinessDate)
    || !Number.isFinite(Date.parse(currentBusinessDate))
    || new Date(currentBusinessDate).toISOString().slice(0,10) !== currentBusinessDate) {
    throw new TypeError('门店营业日无效')
  }
  const all = permissions.includes('order.history.all')
  return {
    earliestBusinessDate: all ? null : new Date(Date.parse(currentBusinessDate)-2*86400000).toISOString().slice(0,10),
    allowFinancialSummary: all || permissions.includes('reconciliation.view'),
  }
}
