import { describe, expect, it, vi } from 'vitest'
import { NormalizedApiClient } from '../normalized-api'
import { canSendRefundReview, LoyaltyRefundReviewRecovery, refundReviewPermissions, refundReviewRequestBody, type RefundReviewCommand } from './loyalty-refund-review-recovery'
import type { LoyaltyRefundReviewView } from '../shared/loyalty-refund-review'
function storage() {
  const values = new Map<string, string>()
  return { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const rights = ['reconciliation.view', 'reconciliation.manage', 'loyalty.accrual.exception.view', 'loyalty.accrual.request', 'loyalty.accrual.approve']
const command: RefundReviewCommand = { kind: 'request', refundId: 'refund-a', refundPublicId: 'REF-A', body: { basisVersion: 'version-a', allocations: [{ orderItemId: 'food', salesRefundAmountMinor: 2000 }], historicalAllocations: [{ refundId: 'old-refund', allocations: [{ orderItemId: 'drink', salesRefundAmountMinor: 1000 }] }], reason: '已核对实际退品' } }
const decision: RefundReviewCommand = { kind: 'decision', refundId: 'refund-a', refundPublicId: 'REF-A', requestId: 'request-a', requestedByEmployeeId: 'requester', body: { basisVersion: 'version-a', decision: 'approve', reason: '核对原单后批准' } }
const receipt = { data: { requestId: 'request-a', refundId: 'refund-a', status: 'requested' as const, pointsDelta: 0, growthDelta: 0 } }
const view: LoyaltyRefundReviewView = { refundId: 'refund-a', refundPublicId: 'REF-A', orderPublicId: 'ORD-A', currency: 'CNY', refundAmountMinor: 3000, excessAmountMinor: 1000, salesRefundAmountMinor: 2000, basisVersion: 'version-a', status: 'pending', blockingRefundPublicId: null, requests: [], items: [{ orderItemId: 'food', productName: '食品', quantity: 2, refundAllocatedAmountMinor: 1500, maxSalesReturnAmountMinor: 2000, loyaltyEligible: true }, { orderItemId: 'drink', productName: '饮料', quantity: 1, refundAllocatedAmountMinor: 1500, maxSalesReturnAmountMinor: 1500, loyaltyEligible: false }], historicalRefunds: [{ refundId: 'old-refund', refundPublicId: 'REF-OLD', refundAmountMinor: 2000, excessAmountMinor: 1000, salesRefundAmountMinor: 1000, items: [{ orderItemId: 'drink', productName: '饮料', quantity: 1, refundAllocatedAmountMinor: 2000, maxSalesReturnAmountMinor: 2000, loyaltyEligible: false }] }] }

describe('financial refund review original intent and current authority', () => {
  it.each([command, decision])('restores the original $kind body including historical evidence after response loss and page reload', async original => {
    const saved = storage(), actor = original.kind === 'request' ? 'requester' : 'reviewer'
    const first = new LoyaltyRefundReviewRecovery('tenant:store', actor, saved)
    await expect(first.execute(original, rights, async () => { throw new Error('lost reply after commit') }, async () => {})).rejects.toThrow('lost reply')
    const persisted = first.pending()!, reload = new LoyaltyRefundReviewRecovery('tenant:store', actor, saved)
    const reply = { data: { ...receipt.data, status: original.kind === 'request' ? 'requested' as const : 'approved' as const, pointsDelta: original.kind === 'request' ? 0 : -20, growthDelta: original.kind === 'request' ? 0 : -20 } }
    const send = vi.fn(async () => reply), read = vi.fn(async () => {})
    await expect(reload.execute({ ...original, body: { ...original.body, reason: '后来改动不能覆盖' } } as RefundReviewCommand, rights, send, read)).rejects.toThrow('先恢复')
    expect(send).not.toHaveBeenCalled()
    await reload.execute(null, rights, send, read)
    expect(send).toHaveBeenCalledExactlyOnceWith(persisted); expect(read).toHaveBeenCalledTimes(1); expect(reload.pending()).toBeNull()
  })

  it('shares in-flight original recovery and does not clear until a fresh read succeeds', async () => {
    const saved = storage(), recovery = new LoyaltyRefundReviewRecovery('tenant:store', 'requester', saved)
    await expect(recovery.execute(command, rights, async () => receipt, async () => { throw new Error('read timeout') })).rejects.toThrow('read timeout')
    let finish!: (value: typeof receipt) => void
    const send = vi.fn(() => new Promise<typeof receipt>(resolve => { finish = resolve })), read = vi.fn(async () => {})
    const a = recovery.execute(null, rights, send, read), b = recovery.execute(null, rights, send, read)
    await Promise.resolve(); expect(send).toHaveBeenCalledTimes(1); expect(recovery.pending()).not.toBeNull()
    finish(receipt); await Promise.all([a, b]); expect(read).toHaveBeenCalledTimes(1); expect(recovery.pending()).toBeNull()
  })

  it('uses actual API error transport and clears only explicit not_committed proof on known business rejections', async () => {
    for (const [status, code, disposition, cleared] of [
      [409, 'LOYALTY_REVIEW_STALE', 'not_committed', true], [409, 'LOYALTY_REVIEW_STALE', undefined, false],
      [409, 'IDEMPOTENCY_CONFLICT', 'not_committed', false], [500, 'LOYALTY_REVIEW_STALE', 'not_committed', false],
      [403, 'LOYALTY_REVIEW_SELF_APPROVAL', 'not_committed', false], [401, 'AUTH_REQUIRED', undefined, false],
      [409, 'LOYALTY_REVIEW_INVALID', 'unknown', false], [409, 'LOYALTY_REVIEW_ORDER_BLOCKED', 'not_committed', true],
    ] as const) {
      const client = new NormalizedApiClient({ fetch: vi.fn(async () => new Response(JSON.stringify({ error: { code, message: '请重新核对', commitDisposition: disposition } }), { status })) as typeof fetch })
      const recovery = new LoyaltyRefundReviewRecovery('tenant:store', 'requester', storage())
      await expect(recovery.execute(command, rights, intent => client.postEndpoint('/api/staff/loyalty/refund-reviews/refund-a/requests', intent.body, { idempotencyKey: intent.key }), async () => {})).rejects.toMatchObject({ code, status, commitDisposition: disposition === 'not_committed' ? disposition : undefined })
      expect(recovery.pending() === null, `${status}:${code}:${disposition}`).toBe(cleared)
    }
  })

  it('retains committed intent and withholds a result when current readback rejects the actor', async () => {
    const recovery = new LoyaltyRefundReviewRecovery('tenant:store', 'requester', storage())
    await expect(recovery.execute(command, rights, async () => receipt, async () => { throw Object.assign(new Error('revoked'), { status: 403 }) })).rejects.toThrow('revoked')
    expect(recovery.pending()).not.toBeNull()
    const send = vi.fn(async () => receipt)
    await expect(recovery.execute(null, rights.filter(right => right !== 'reconciliation.manage'), send, async () => {})).rejects.toThrow('无权恢复')
    expect(send).not.toHaveBeenCalled(); expect(recovery.pending()).not.toBeNull()
  })

  it('separates store and actor, and prevents the requester from approving even with all permissions', async () => {
    const saved = storage(), recovery = new LoyaltyRefundReviewRecovery('tenant:store', 'requester', saved)
    await expect(recovery.execute(command, rights, async () => { throw new Error('unknown') }, async () => {})).rejects.toThrow('unknown')
    expect(new LoyaltyRefundReviewRecovery('tenant:other', 'requester', saved).pending()).toBeNull()
    expect(new LoyaltyRefundReviewRecovery('tenant:store', 'reviewer', saved).pending()).toBeNull()
    expect(refundReviewPermissions(['loyalty.accrual.exception.view']).view).toBe(false)
    expect(refundReviewPermissions(['reconciliation.view']).view).toBe(false)
    expect(canSendRefundReview(decision, 'requester', rights)).toBe(false)
    const send = vi.fn(async () => receipt)
    await expect(new LoyaltyRefundReviewRecovery('tenant:store', 'requester', storage()).execute(decision, rights, send, async () => {})).rejects.toThrow('不同人员')
    expect(send).not.toHaveBeenCalled()
  })

  it('does not transmit without persistent storage and refuses malformed or mismatched receipts', async () => {
    const saved = storage(); saved.setItem = () => { throw new Error('storage unavailable') }
    const send = vi.fn(async () => receipt)
    await expect(new LoyaltyRefundReviewRecovery('tenant:store', 'requester', saved).execute(command, rights, send, async () => {})).rejects.toThrow('storage unavailable')
    expect(send).not.toHaveBeenCalled()
    const recovery = new LoyaltyRefundReviewRecovery('tenant:store', 'requester', storage()), read = vi.fn(async () => {})
    await expect(recovery.execute(command, rights, async () => ({ data: { ...receipt.data, refundId: 'other' } }), read)).rejects.toThrow('回执无法核对')
    expect(read).not.toHaveBeenCalled(); expect(recovery.pending()).not.toBeNull()
  })

  it('requires explicit item allocations for every historical refund, preserves cents and rejects over/under allocation', () => {
    const body = refundReviewRequestBody(view, { food: '20.00' }, '退食品已核实', { 'old-refund': { drink: '10' } })
    expect(body.allocations).toEqual([{ orderItemId: 'food', salesRefundAmountMinor: 2000 }]); expect(body.historicalAllocations).toEqual(command.kind === 'request' ? command.body.historicalAllocations : [])
    expect(() => refundReviewRequestBody(view, { food: '20' }, '退食品已核实')).toThrow('每笔')
    for (const amounts of [{ food: '19.99' }, { food: '20.01' }, { food: '2e1' }, { food: '20.001' }, { other: '20' }, { drink: '20' }, { food: '-20' }]) expect(() => refundReviewRequestBody(view, amounts, '退食品已核实', { 'old-refund': { drink: '10' } })).toThrow()
    expect(() => refundReviewRequestBody({ ...view, blockingRefundPublicId: 'earlier' }, { food: '20' }, '退食品已核实')).toThrow('先处理')
    expect(refundReviewRequestBody({ ...view, excessAmountMinor: 3000, salesRefundAmountMinor: 0, historicalRefunds: [] }, {}, '核实全部为超收')).toMatchObject({ allocations: [], historicalAllocations: [] })
  })
})
