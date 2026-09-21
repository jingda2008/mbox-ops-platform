import { describe, expect, it, vi } from 'vitest'
import { GuestApiClient } from './guest-api'
import { GuestServiceRecovery } from './guest-service-recovery'

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const input = { requestType: 'custom' as const, detail: '请送一张消费单据' }

describe('guest service original intent recovery', () => {
  it('actual client lost response, remount and concurrent retry preserve one key/body after staff completion', async () => {
    const saved = storage(), receipts = new Map<string, unknown>(), calls: Array<{ key: string; body: unknown }> = []
    let creates = 0
    const client = new GuestApiClient('device-one', { fetch: async (_url, options) => {
      const key = new Headers(options?.headers).get('idempotency-key')!
      const body = JSON.parse(String(options?.body))
      calls.push({ key, body })
      if (!receipts.has(key)) { creates++; receipts.set(key, { status: 'created', message: '收到' }) }
      if (calls.length === 1) throw new Error('committed response lost, staff finished task')
      return new Response(JSON.stringify({ data: receipts.get(key) }), { status: 200 })
    } })
    await expect(new GuestServiceRecovery(saved, 'table-one', 'device-one').execute(input, client.requestService.bind(client))).rejects.toThrow()
    const restarted = new GuestServiceRecovery(saved, 'table-one', 'device-one')
    const send = client.requestService.bind(client)
    await Promise.all([restarted.execute(null, send), restarted.execute(null, send)])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(creates).toBe(1)
    expect(restarted.pending()).toBeNull()
  })

  it('keeps throttled original input across reload and prevents changed intent or identity from consuming it', async () => {
    const saved = storage(), original = new GuestServiceRecovery(saved, 'table-one', 'device-one')
    const throttled = vi.fn(async () => ({ status: 'rate_limited' as const, message: '尚未受理', retryAt: '2026-09-21T10:01:00Z' }))
    await original.execute(input, throttled)
    const before = original.pending()
    const restored = new GuestServiceRecovery(saved, 'table-one', 'device-one')
    await expect(restored.execute({ ...input, detail: '新的需要' }, throttled)).rejects.toThrow('上一条')
    expect(throttled).toHaveBeenCalledTimes(1)
    expect(new GuestServiceRecovery(saved, 'table-two', 'device-one').pending()).toBeNull()
    expect(new GuestServiceRecovery(saved, 'table-one', 'device-two').pending()).toBeNull()
    const accepted = vi.fn(async () => ({ status: 'created' as const, message: '收到' }))
    await restored.execute(null, accepted)
    expect(accepted).toHaveBeenCalledWith(input, { idempotencyKey: before!.key })
    expect(restored.pending()).toBeNull()
  })

  it('retains the original identity even after the transport cache retention window', async () => {
    const saved = storage(), recovery = new GuestServiceRecovery(saved, 'table', 'device')
    await expect(recovery.execute(input, async () => { throw new Error('response lost') })).rejects.toThrow()
    const original = recovery.pending()!
    const [key, text] = [...saved.values.entries()][0]!
    saved.setItem(key, JSON.stringify({ ...JSON.parse(text), createdAt: Date.now() - 48 * 60 * 60 * 1000 }))
    const replay = vi.fn(async () => ({ status: 'created' as const, message: '原受理结果' }))
    await new GuestServiceRecovery(saved, 'table', 'device').execute(null, replay)
    expect(replay).toHaveBeenCalledWith(input, { idempotencyKey: original.key })
    expect(recovery.pending()).toBeNull()
  })

  it('cannot send without durable storage and keeps unknown/revoked results recoverable', async () => {
    const send = vi.fn(async () => { throw new Error('403') })
    const broken = { getItem: () => null, setItem: () => { throw new Error('storage full') }, removeItem: () => {} }
    await expect(new GuestServiceRecovery(broken, 'table', 'device').execute(input, send)).rejects.toThrow('storage full')
    expect(send).not.toHaveBeenCalled()
    const saved = storage(), recovery = new GuestServiceRecovery(saved, 'table', 'device')
    await expect(recovery.execute(input, send)).rejects.toThrow('403')
    expect(recovery.pending()?.input).toEqual(input)
  })
})
