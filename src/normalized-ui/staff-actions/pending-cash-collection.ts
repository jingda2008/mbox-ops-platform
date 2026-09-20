export interface PendingCashCollection {
  employeeId: string
  orderId: string
  orderIds: string[]
  amountMinor: number
  provider: 'cash'
  receiptReference: string
  idempotencyKey: string
}
export interface CashCollectionRecovery { attempt: PendingCashCollection | null; error: string | null }
const key = (tableSessionId: string) => `mbox.cash-collection.v1:${tableSessionId}`
export function readPendingCashCollection(tableSessionId: string): CashCollectionRecovery {
  try {
    const stored = sessionStorage.getItem(key(tableSessionId))
    if (stored === null) return { attempt: null, error: null }
    const value: unknown = JSON.parse(stored)
    if (typeof value !== 'object' || value === null) throw new Error('invalid')
    const item = value as Partial<PendingCashCollection>
    if (typeof item.employeeId !== 'string' || typeof item.orderId !== 'string'
      || !Array.isArray(item.orderIds) || item.orderIds.length === 0 || !item.orderIds.every(id => typeof id === 'string')
      || !Number.isSafeInteger(item.amountMinor) || item.amountMinor! <= 0 || item.provider !== 'cash'
      || typeof item.receiptReference !== 'string' || typeof item.idempotencyKey !== 'string') throw new Error('invalid')
    return { attempt: item as PendingCashCollection, error: null }
  } catch {
    return { attempt: null, error: '本机现金登记记录暂时无法读取，请到收银页面核对后办理。' }
  }
}
export function rememberCashCollection(tableSessionId: string, attempt: PendingCashCollection): void {
  const current = readPendingCashCollection(tableSessionId)
  if (current.error) throw new Error(current.error)
  if (current.attempt && current.attempt.idempotencyKey !== attempt.idempotencyKey) {
    throw new Error('上次现金登记结果尚未确认，请先核对上次登记。')
  }
  try {
    sessionStorage.setItem(key(tableSessionId), JSON.stringify(attempt))
    if (sessionStorage.getItem(key(tableSessionId)) !== JSON.stringify(attempt)) throw new Error('not stored')
  } catch { throw new Error('无法保存本次现金登记的恢复记录，请到收银页面办理。') }
}
export function completeCashCollection(tableSessionId: string, attempt: PendingCashCollection): void {
  if (readPendingCashCollection(tableSessionId).attempt?.idempotencyKey !== attempt.idempotencyKey) return
  sessionStorage.removeItem(key(tableSessionId))
}
