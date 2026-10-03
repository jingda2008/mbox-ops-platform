import { describe, expect, it, vi } from 'vitest'
import { GuestApiError, type GuestOrderResult, type GuestSharedCart } from './guest-api'
import { GuestCheckoutRecovery, guestCheckoutLineNotes, resolveGuestDeviceKey, type GuestCheckoutInput } from './guest-checkout-recovery'

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const input: GuestCheckoutInput = { protocol: 2, body: { expectedGeneration: 3, expectedVersion: 7, note: '整单备注', lineNotes: [{ portionId: 'portion-one', note: '少冰' }] } }
const result = { order: { publicId: 'original-order' } } as GuestOrderResult

describe('durable guest checkout recovery', () => {
  it('reopens and retries the original key/body concurrently after a committed response is lost', async () => {
    const saved = storage(), original = new GuestCheckoutRecovery(saved, 'table', 'device')
    const calls: unknown[] = []
    await expect(original.execute(input, async intent => { calls.push(intent); throw new Error('lost response') })).rejects.toThrow()
    const restarted = new GuestCheckoutRecovery(saved, 'table', 'device')
    const send = vi.fn(async intent => { calls.push(intent); return result })
    await Promise.all([restarted.execute(null, send), restarted.execute(null, send)])
    expect(calls[0]).toEqual(calls[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(restarted.pending()).toBeNull()
  })

  it.each([new Error('offline'), new GuestApiError('bad payload', 'invalid_response', 200, 'INVALID_RESPONSE'), new GuestApiError('expired', 'http', 401, 'GUEST_SESSION_INVALID'), new GuestApiError('failed', 'http', 503, 'PROVIDER_UNAVAILABLE')])('retains uncertain failures and forbids changed requests: %s', async error => {
    const saved = storage(), recovery = new GuestCheckoutRecovery(saved, 'table', 'device')
    await expect(recovery.execute(input, async () => { throw error })).rejects.toThrow()
    const before = recovery.pending()
    const send = vi.fn(async () => result)
    await expect(recovery.execute({ protocol: 2, body: { expectedGeneration: 9, expectedVersion: 1, note: '' } }, send)).rejects.toThrow('恢复原订单')
    expect(send).not.toHaveBeenCalled()
    expect(recovery.pending()).toEqual(before)
    expect(new GuestCheckoutRecovery(saved, 'another-table', 'device').pending()).toBeNull()
    expect(new GuestCheckoutRecovery(saved, 'table', 'another-device').pending()).toBeNull()
  })

  it.each(['GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', 'SHARED_CART_VERSION_CONFLICT', 'CART_NOTE_STALE'])('permits corrected input only after definitive rejection: %s', async code => {
    const recovery = new GuestCheckoutRecovery(storage(), 'table', 'device')
    let firstKey = ''
    await expect(recovery.execute(input, async intent => { firstKey = intent.key; throw new GuestApiError('rejected', 'http', 409, code) })).rejects.toThrow()
    expect(recovery.pending()).toBeNull()
    await recovery.execute(input, async intent => { expect(intent.key).not.toBe(firstKey); return result })
  })

  it('fails closed before sending if persistence is unavailable or corrupt', async () => {
    const send = vi.fn(async () => result)
    const broken = { getItem: () => null, setItem: () => { throw new Error('storage full') }, removeItem: () => {} }
    await expect(new GuestCheckoutRecovery(broken, 'table', 'device').execute(input, send)).rejects.toThrow()
    const saved = storage(), recovery = new GuestCheckoutRecovery(saved, 'table', 'device')
    await expect(recovery.execute(input, async () => { throw new Error('offline') })).rejects.toThrow()
    saved.setItem([...saved.values.keys()][0]!, '{invalid')
    await expect(recovery.execute(null, send)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps legacy item notes and bundle selections unchanged during recovery', async () => {
    const recovery = new GuestCheckoutRecovery(storage(), 'table', 'device')
    const legacy: GuestCheckoutInput = { protocol: 1, body: { note: null, items: [{ productId: 'product', quantity: 1, note: '少冰' }] } }
    await expect(recovery.execute(legacy, async () => { throw new Error('offline') })).rejects.toThrow()
    await recovery.execute(null, async intent => { expect(intent.input).toEqual(legacy); return result })
  })

  it('binds notes to every reviewed portion and refuses stale quantities or missing identities', () => {
    const cart = { lines: [{ productId: 'drink', quantity: 2, portionIds: ['one', 'two'] }] } as GuestSharedCart
    expect(guestCheckoutLineNotes(cart, [{ productId: 'drink', quantity: 2, note: ' 少冰 ' }])).toEqual([{ portionId: 'one', note: '少冰' }, { portionId: 'two', note: '少冰' }])
    expect(() => guestCheckoutLineNotes(cart, [{ productId: 'drink', quantity: 1, note: '少冰' }])).toThrow()
    expect(() => guestCheckoutLineNotes({ lines: [{ productId: 'drink', quantity: 2 }] } as GuestSharedCart, [{ productId: 'drink', quantity: 2, note: '少冰' }])).toThrow()
  })

  it('keeps the browser identity after closing the tab and preserves already-bound legacy tabs', () => {
    const durable = storage(), tab = storage()
    const device = resolveGuestDeviceKey(tab, durable)
    expect(resolveGuestDeviceKey(storage(), durable)).toBe(device)
    const old = storage(); old.setItem('mbox-normalized-guest-device-v1', 'old-device-key')
    expect(resolveGuestDeviceKey(old, durable)).toBe('old-device-key')
  })
})
