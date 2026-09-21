import type { LoyaltyRefundReviewAllocation, LoyaltyRefundReviewItem, LoyaltyRefundReviewCommandResult, LoyaltyRefundReviewDecisionInput, LoyaltyRefundReviewRequestInput, LoyaltyRefundReviewView } from '../shared/loyalty-refund-review'

export type RefundReviewCommand = {
  kind: 'request'; refundId: string; refundPublicId: string; body: LoyaltyRefundReviewRequestInput
} | {
  kind: 'decision'; refundId: string; refundPublicId: string; requestId: string; requestedByEmployeeId: string; body: LoyaltyRefundReviewDecisionInput
}
export type RefundReviewIntent = RefundReviewCommand & { version: 1; scopeKey: string; employeeId: string; key: string; createdAt: string }
type StoragePort = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const flights = new Map<string, Promise<LoyaltyRefundReviewCommandResult>>()
const definiteCodes = new Set(['INVALID', 'STALE', 'NOT_FOUND', 'SELF_APPROVAL', 'ORDER_BLOCKED', 'ALREADY_DECIDED', 'ALREADY_RESOLVED', 'SUPERSEDED'].map(code => `LOYALTY_REVIEW_${code}`))
export function reviewDefinitelyNotCommitted(error: unknown): boolean {
  const detail = error as { code?: string; commitDisposition?: string; status?: number } | null
  return detail?.commitDisposition === 'not_committed' && definiteCodes.has(detail.code ?? '') && [400, 404, 409, 422].includes(detail.status ?? 0)
}
export function refundReviewPermissions(permissions: readonly string[]) {
  const view = permissions.includes('reconciliation.view') && permissions.includes('loyalty.accrual.exception.view')
  return { view, request: view && permissions.includes('reconciliation.manage') && permissions.includes('loyalty.accrual.request'), approve: view && permissions.includes('reconciliation.manage') && permissions.includes('loyalty.accrual.approve') }
}
export function canSendRefundReview(command: RefundReviewCommand, employeeId: string, permissions: readonly string[]): boolean {
  const access = refundReviewPermissions(permissions)
  return command.kind === 'request' ? access.request : access.approve && command.requestedByEmployeeId !== employeeId
}

/** Save original actor, scope, target, body and key before sending; clear only after current readback or explicit rollback proof. */
export class LoyaltyRefundReviewRecovery {
  private readonly prefix: string
  private readonly scopeKey: string
  private readonly employeeId: string
  private readonly storage: StoragePort
  constructor(scopeKey: string, employeeId: string, storage: StoragePort) {
    this.scopeKey = scopeKey; this.employeeId = employeeId; this.storage = storage
    this.prefix = `mbox.loyalty-refund-review.v1:${scopeKey}:${employeeId}:`
  }
  pending(): RefundReviewIntent | null {
    const intents: RefundReviewIntent[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (!key?.startsWith(this.prefix)) continue
      let value: unknown
      try { value = JSON.parse(this.storage.getItem(key) ?? 'null') } catch { throw new Error('原退款核对记录无法读取，请保留记录并联系管理员') }
      if (!validIntent(value, this.scopeKey, this.employeeId) || key !== this.prefix + value.key) throw new Error('原退款核对记录无法读取，请保留记录并联系管理员')
      intents.push(value)
    }
    return intents.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))[0] ?? null
  }
  async execute(command: RefundReviewCommand | null, permissions: readonly string[], send: (intent: RefundReviewIntent) => Promise<{ data: LoyaltyRefundReviewCommandResult }>, readback: () => Promise<void>): Promise<LoyaltyRefundReviewCommandResult> {
    let intent = this.pending()
    if (intent && command) throw new Error('已有原操作待核对，请先恢复原结果，不能用新内容覆盖')
    if (!intent) {
      if (!command) throw new Error('没有待恢复的原操作，请重新读取退款记录')
      intent = JSON.parse(JSON.stringify({ ...command, version: 1, scopeKey: this.scopeKey, employeeId: this.employeeId, key: `loyalty-review-${crypto.randomUUID()}`, createdAt: new Date().toISOString() })) as RefundReviewIntent
      if (!validIntent(intent, this.scopeKey, this.employeeId)) throw new Error('请重新核对退款明细和说明')
      if (!canSendRefundReview(intent, this.employeeId, permissions)) throw new Error('当前员工无此操作权限，申请与复核必须由不同人员完成')
      const encoded = JSON.stringify(intent)
      this.storage.setItem(this.prefix + intent.key, encoded)
      if (this.storage.getItem(this.prefix + intent.key) !== encoded) throw new Error('原操作未能安全保存，请恢复浏览器存储后再提交')
    }
    if (!canSendRefundReview(intent, this.employeeId, permissions)) throw new Error('当前员工无权恢复此操作，请恢复原员工授权后核对')
    const key = this.prefix + intent.key, existing = flights.get(key)
    if (existing) return existing
    const original = intent
    let receiptConfirmed = false
    const flight = Promise.resolve().then(() => send(original)).then(async ({ data }) => {
      const expected = original.kind === 'request' ? 'requested' : original.body.decision === 'approve' ? 'approved' : 'rejected'
      if (!data || data.refundId !== original.refundId || data.status !== expected || !data.requestId || original.kind === 'decision' && data.requestId !== original.requestId || !Number.isSafeInteger(data.pointsDelta) || !Number.isSafeInteger(data.growthDelta)) throw new Error('原操作回执无法核对，请保留原记录继续恢复')
      receiptConfirmed = true
      await readback()
      this.storage.removeItem(key)
      return data
    }).catch((error: unknown) => {
      if (!receiptConfirmed && reviewDefinitelyNotCommitted(error)) this.storage.removeItem(key)
      throw error
    }).finally(() => { flights.delete(key) })
    flights.set(key, flight)
    return flight
  }
}

export function refundReviewRequestBody(review: LoyaltyRefundReviewView, amounts: Readonly<Record<string, string>>, reason: string, historicalAmounts: Readonly<Record<string, Record<string, string>>> = {}): LoyaltyRefundReviewRequestInput {
  if (review.status !== 'pending' || review.blockingRefundPublicId) throw new Error('请先处理同订单更早的待核退款并刷新')
  const allocations = refundReviewAllocations(review, amounts)
  if (Object.keys(historicalAmounts).some(id => !review.historicalRefunds.some(row => row.refundId === id))) throw new Error('历史退款已变化，请重新读取')
  const historicalAllocations = review.historicalRefunds.map(row => ({ refundId: row.refundId, allocations: refundReviewAllocations(row, historicalAmounts[row.refundId] ?? {}) }))
  const cleanReason = reason.trim()
  if (cleanReason.length < 3 || cleanReason.length > 1000) throw new Error('核对依据请填写3至1000字')
  return { basisVersion: review.basisVersion, allocations, historicalAllocations, reason: cleanReason }
}
function refundReviewAllocations(review: { salesRefundAmountMinor: number; items: LoyaltyRefundReviewItem[] }, amounts: Readonly<Record<string, string>>): LoyaltyRefundReviewAllocation[] {
  const allocations = Object.entries(amounts).map(([orderItemId, value]) => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('退款金额须为非负金额，最多两位小数')
    const [whole, fraction = ''] = value.trim().split('.'), amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
    const item = review.items.find(row => row.orderItemId === orderItemId)
    if (!item || !Number.isSafeInteger(amount) || amount <= 0 || amount > item.maxSalesReturnAmountMinor) throw new Error('所选商品退款金额必须大于零且不超过当前可退上限')
    return { orderItemId, salesRefundAmountMinor: amount }
  })
  if (allocations.reduce((sum, row) => sum + row.salesRefundAmountMinor, 0) !== review.salesRefundAmountMinor) throw new Error('每笔所选真实退货商品金额合计必须等于该笔需核对的销售退款金额')
  return allocations
}
function validIntent(value: unknown, scopeKey: string, employeeId: string): value is RefundReviewIntent {
  if (!value || typeof value !== 'object') return false
  const row = value as RefundReviewIntent, body = row.body
  if (row.version !== 1 || row.scopeKey !== scopeKey || row.employeeId !== employeeId || typeof row.key !== 'string' || !/^loyalty-review-[0-9a-f-]{36}$/.test(row.key) || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.refundId !== 'string' || !row.refundId || typeof row.refundPublicId !== 'string' || !body || typeof body.basisVersion !== 'string' || !body.basisVersion || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 1000) return false
  if (row.kind === 'decision') return Boolean(row.requestId) && Boolean(row.requestedByEmployeeId) && ['approve', 'reject'].includes(row.body.decision)
  return row.kind === 'request' && Array.isArray(row.body.allocations) && row.body.allocations.every(item => typeof item.orderItemId === 'string' && item.orderItemId.length > 0 && Number.isSafeInteger(item.salesRefundAmountMinor) && item.salesRefundAmountMinor > 0)
}
