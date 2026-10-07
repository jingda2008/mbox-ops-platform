import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { OfficialGetuiAdapter, getuiRequestId, sendGetuiHttps, type GetuiWireRequest, type GetuiWireResult } from './native-push-getui.js'
import type { GetuiPushConfig } from './native-push-config.js'
const mockHttps = vi.hoisted(() => vi.fn())
vi.mock('node:https', () => ({ request: mockHttps }))
const now = Date.parse('2026-10-07T10:00:00Z')
const config: GetuiPushConfig = { appId: 'test-app', appKey: 'test-key', masterSecret: 'secret-sentinel', environment: 'production', topic: 'test-app', tokenKey: Buffer.alloc(32), tokenKeyId: 'test', eventTtlSeconds: 300 }
const input = { token: 'a'.repeat(32), requestId: '107d0c88-0660-4225-8ee5-e975dcfdac55', deliveryId: '756535ad-c6cd-49b2-a1a3-b1faac5b8431', expiresAt: new Date(now + 300_000).toISOString() }
const response = (body: unknown, status = 200): GetuiWireResult => ({ kind: 'response', status, body: JSON.stringify(body) })
const auth = (token = 'test-auth', at = now): GetuiWireResult => response({ code: 0, data: { token, expire_time: String(at + 86_400_000) } })
const accepted = (status = 'successed_online'): GetuiWireResult => response({ code: 0, data: { task: { [input.token]: status } } })
function harness(push: GetuiWireResult = accepted()) {
  const calls: GetuiWireRequest[] = []
  const adapter = new OfficialGetuiAdapter(config, async wire => { calls.push(wire); return wire.path.endsWith('/auth') ? auth() : push }, () => now)
  return { calls, adapter }
}
describe('official Getui sender with no live credentials or network', () => {
  it('signs official auth, pins app endpoint and sends privacy-minimal fixed component intents', async () => {
    const { calls, adapter } = harness()
    expect(await adapter.send(input)).toEqual({ status: 'provider_accepted' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.origin).toBe('https://restapi.getui.com')
    expect(calls[0]?.path).toBe('/v2/test-app/auth')
    expect(JSON.parse(calls[0]!.body)).toEqual({ timestamp: String(now), appkey: config.appKey, sign: createHash('sha256').update(config.appKey + now + config.masterSecret).digest('hex') })
    const push = JSON.parse(calls[1]!.body)
    expect(calls[1]?.path).toBe('/v2/test-app/push/single/cid')
    expect(calls[1]?.headers.token).toBe('test-auth')
    expect(push.request_id).toMatch(/^[a-f0-9]{32}$/)
    expect(push.settings).toEqual({ ttl: 300_000 })
    expect(push.audience).toEqual({ cid: [input.token] })
    const notification = push.push_message.notification
    expect(notification.click_type).toBe('intent')
    expect(push).not.toHaveProperty('push_channel')
    expect(notification.channel_id).toBe('mbox-service-realtime')
    const encoded = notification.intent.split('S.payload=')[1].split(';')[0]
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual({ mbox: { protocol: 1, kind: 'service_task', deliveryId: input.deliveryId } })
    expect(notification.intent).toContain('component=com.mbox.staff.nativeapp/com.mbox.staff.MainActivity;')
    expect(calls[1]!.body).not.toContain(config.masterSecret)
    expect(calls[1]!.body).not.toContain('staffSessionId')
    expect(calls[1]!.body).not.toContain('installationId')
    expect(notification.intent.length).toBeLessThan(2048)
  })
  it('keeps original request ID stable even if retry payload TTL changes', async () => {
    const { calls, adapter } = harness(response({ code: 10005 }, 401))
    await adapter.send(input); await adapter.send(input)
    expect(JSON.parse(calls[1]!.body).request_id).toBe(JSON.parse(calls[2]!.body).request_id)
    expect(getuiRequestId(input.requestId)).not.toBe(getuiRequestId(input.requestId + 'x'))
  })
  it('coalesces concurrent auth and reuses token', async () => {
    let authCalls = 0, release!: () => void
    const latch = new Promise<void>(resolve => { release = resolve })
    const adapter = new OfficialGetuiAdapter(config, async wire => { if (wire.path.endsWith('/auth')) { authCalls++; await latch; return auth() } return accepted() }, () => now)
    const a = adapter.send(input), b = adapter.send(input)
    expect(authCalls).toBe(1); release()
    await Promise.all([a, b]); await adapter.send(input)
    expect(authCalls).toBe(1)
  })
  it('refreshes before expiration and on backward wall clock', async () => {
    let time = now, authCalls = 0
    const adapter = new OfficialGetuiAdapter(config, async wire => { if (wire.path.endsWith('/auth')) { authCalls++; return auth('token' + authCalls, time) } return accepted() }, () => time)
    const send = () => adapter.send({ ...input, expiresAt: new Date(time + 300_000).toISOString() })
    await send(); time += 86_339_999; await send(); expect(authCalls).toBe(1)
    time++; await send(); expect(authCalls).toBe(2)
    time--; await send(); expect(authCalls).toBe(3)
  })
  it('refreshes rejected auth only on subsequent worker attempt without immediate duplicate push', async () => {
    let authCalls = 0, pushCalls = 0
    const adapter = new OfficialGetuiAdapter(config, async wire => { if (wire.path.endsWith('/auth')) return auth('token' + (++authCalls)); pushCalls++; return pushCalls === 1 ? response({ code: 10001 }, 401) : accepted() }, () => now)
    expect(await adapter.send(input)).toMatchObject({ status: 'retry', code: 'GETUI_AUTH_EXPIRED' }); expect(pushCalls).toBe(1)
    expect(await adapter.send(input)).toEqual({ status: 'provider_accepted' }); expect(authCalls).toBe(2)
  })
  it.each<[GetuiWireResult, object]>([
    [accepted('successed_offline'), { status: 'provider_accepted' }],
    [accepted('successed_ignore'), { status: 'rejected', code: 'GETUI_DEVICE_INACTIVE' }],
    [accepted('success'), { status: 'unknown' }],
    [response({ code: 0 }), { status: 'unknown' }],
    [response({ code: 0, data: { task: { ['b'.repeat(32)]: 'successed_online' } } }), { status: 'unknown' }],
    [response({ code: 20001, msg: 'target user is invalid' }, 400), { status: 'rejected', invalidToken: true }],
    [response({ code: 20001, msg: 'appid not match cid' }, 400), { status: 'rejected', invalidToken: true }],
    [response({ code: 20001, msg: 'channel_id is invalid' }, 400), { status: 'rejected', code: 'GETUI_REQUEST_REJECTED' }],
    [response({ code: 10002 }, 401), { status: 'rejected', configurationFailure: true }],
    [response({ code: 301 }), { status: 'rejected', configurationFailure: true }],
    [response({ code: 30009 }, 403), { status: 'rejected', configurationFailure: true }],
    [response({ code: 10005 }, 401), { status: 'retry' }],
    [response({ code: 30019 }, 403), { status: 'retry' }],
    [response({ code: 2 }), { status: 'retry' }],
    [response({ code: 5000 }), { status: 'retry' }],
    [response({ code: 0 }, 500), { status: 'unknown' }],
    [response({ code: 0 }, 302), { status: 'unknown' }],
    [{ kind: 'response', status: 200, body: 'SECRET-invalid-json' }, { status: 'unknown' }],
    [{ kind: 'response', status: 200, body: 'x'.repeat(16_385) }, { status: 'unknown' }],
    [{ kind: 'unknown' }, { status: 'unknown' }],
    [{ kind: 'not_sent' }, { status: 'retry' }],
  ])('distinguishes documented receipt from non-acceptance and uncertainty case %#', async (wire, expected) => {
    const actual = await harness(wire).adapter.send(input)
    expect(actual).toMatchObject(expected)
    expect(JSON.stringify(actual)).not.toContain('SECRET')
    if (!('invalidToken' in expected)) expect(actual).not.toHaveProperty('invalidToken')
  })
  it('sanitizes transport exceptions and never immediately replays an uncertain push', async () => {
    const transport = vi.fn(async (wire: GetuiWireRequest) => { if (wire.path.endsWith('/auth')) return auth(); throw new Error('SECRET-token-CID') })
    const result = await new OfficialGetuiAdapter(config, transport, () => now).send(input)
    expect(result).toEqual({ status: 'unknown', code: 'GETUI_RESULT_UNKNOWN' }); expect(transport).toHaveBeenCalledTimes(2)
  })
  it('can retry auth transport failure because no notification has been sent', async () => {
    expect(await new OfficialGetuiAdapter(config, async () => { throw new Error('SECRET') }, () => now).send(input)).toMatchObject({ status: 'retry', code: 'GETUI_AUTH_UNAVAILABLE' })
  })
  it('refuses invalid and expired delivery inputs before network activity', async () => {
    const { calls, adapter } = harness()
    for (const patch of [{ expiresAt: 'bad' }, { expiresAt: new Date(now).toISOString() }, { token: 'BAD' }, { deliveryId: 'x;component=evil' }, { requestId: '' }]) expect(await adapter.send({ ...input, ...patch })).toMatchObject({ status: 'rejected' })
    expect(calls).toHaveLength(0)
  })
  it('rechecks TTL after auth delay and does not send newly expired events', async () => {
    let time = now; const calls: string[] = []
    const adapter = new OfficialGetuiAdapter(config, async wire => { calls.push(wire.path); time += 300_000; return auth('token', time) }, () => time)
    expect(await adapter.send(input)).toEqual({ status: 'rejected', code: 'EVENT_EXPIRED' }); expect(calls).toHaveLength(1)
  })
  it('refuses invalid token response and never exposes response body', async () => {
    for (const data of [{ token: 'secret\r\nHeader:x', expire_time: String(now + 86_400_000) }, { token: 'SECRET', expire_time: String(now) }, { token: 'SECRET', expire_time: 'forever' }]) {
      expect(await new OfficialGetuiAdapter(config, async () => response({ code: 0, data }), () => now).send(input)).toEqual({ status: 'retry', code: 'GETUI_AUTH_INVALID_RESPONSE', retryAfterSeconds: 30 })
    }
  })
  it('rejects arbitrary hosts, path injection and configured application traversal without network', async () => {
    expect(() => new OfficialGetuiAdapter({ ...config, appId: '../auth' })).toThrow('Getui configuration invalid')
    for (const [origin, path] of [['http://localhost', '/v2/test/auth'], ['https://restapi.getui.com.evil', '/v2/test/auth'], ['https://restapi.getui.com', '/v2/test/../auth'], ['https://restapi.getui.com', '/v2/test/auth?evil=1']]) expect(await sendGetuiHttps({ origin: origin!, path: path!, headers: {}, body: '{}' })).toEqual({ kind: 'not_sent' })
  })
})


describe('bounded HTTPS transport without outbound sockets', () => {
  const wire = { origin: 'https://restapi.getui.com', path: '/v2/test-app/push/single/cid', headers: { token: 'test-auth' }, body: '{}' }
  function setup() {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() })
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    let receive!: (response: typeof res) => void
    mockHttps.mockImplementation((_url, _options, callback) => { receive = callback; return req })
    return { req, res, receive: () => receive(res) }
  }
  it('does not follow redirects and preserves TLS verification', async () => {
    const { req, res, receive } = setup()
    const pending = sendGetuiHttps(wire)
    receive(); res.statusCode = 302; res.emit('data', Buffer.from('{}')); res.emit('end')
    expect(await pending).toEqual({ kind: 'response', status: 302, body: '{}' })
    expect(req.destroy).toHaveBeenCalledTimes(1)
    expect(mockHttps).toHaveBeenLastCalledWith('https://restapi.getui.com/v2/test-app/push/single/cid', expect.objectContaining({ rejectUnauthorized: true, method: 'POST' }), expect.any(Function))
  })
  it('bounds bytes across chunks and destroys uncertain oversized responses', async () => {
    const { req, res, receive } = setup()
    const pending = sendGetuiHttps(wire)
    receive(); res.emit('data', Buffer.alloc(8192)); res.emit('data', Buffer.alloc(8193)); res.emit('end')
    expect(await pending).toEqual({ kind: 'unknown' }); expect(req.destroy).toHaveBeenCalledTimes(1)
  })
  it('imposes an absolute 10 second deadline despite a silent response', async () => {
    vi.useFakeTimers()
    try {
      const { req } = setup()
      const pending = sendGetuiHttps(wire)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toEqual({ kind: 'unknown' }); expect(req.destroy).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('does not mistake a truncated response for acceptance', async () => {
    const { res, receive } = setup()
    const pending = sendGetuiHttps(wire)
    receive(); res.emit('data', Buffer.from('{"code":0')); res.emit('aborted')
    expect(await pending).toEqual({ kind: 'unknown' })
  })
})
