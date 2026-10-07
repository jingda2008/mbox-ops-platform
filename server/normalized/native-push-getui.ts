import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { NativePushDeliveryOutcome, NativePushSendRequest, NativePushSender } from './native-push-apns.js'
import type { GetuiPushConfig } from './native-push-config.js'

const ORIGIN = 'https://restapi.getui.com'
const MAX_RESPONSE_BYTES = 16_384
const AUTH_SKEW_MS = 60_000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export interface GetuiWireRequest { origin: string; path: string; headers: Record<string, string>; body: string }
export type GetuiWireResult = { kind: 'response'; status: number; body: string } | { kind: 'not_sent' } | { kind: 'unknown' }
export type GetuiTransport = (request: GetuiWireRequest) => Promise<GetuiWireResult>
type JsonObject = Record<string, unknown>
type AuthResult = { token: string; expiresAt: number; issuedAt: number } | { outcome: NativePushDeliveryOutcome }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const retry = (code: string): NativePushDeliveryOutcome => ({ status: 'retry', code, retryAfterSeconds: 30 })
const unknown = (): NativePushDeliveryOutcome => ({ status: 'unknown', code: 'GETUI_RESULT_UNKNOWN' })
const configuration = (): NativePushDeliveryOutcome => ({ status: 'rejected', code: 'GETUI_CONFIGURATION_REJECTED', configurationFailure: true })

/** Stable across retries; never rotate an ID after an uncertain provider response. */
export function getuiRequestId(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex').slice(0, 32)
}
function parseResponse(response: GetuiWireResult): JsonObject | null {
  if (response.kind !== 'response' || Buffer.byteLength(response.body) > MAX_RESPONSE_BYTES) return null
  try { const value: unknown = JSON.parse(response.body); return object(value) && Number.isInteger(value.code) ? value : null } catch { return null }
}

/** Fixed official REST v2 endpoint. Transport injection is for offline tests only. */
export class OfficialGetuiAdapter implements NativePushSender {
  private cached: Exclude<AuthResult, { outcome: NativePushDeliveryOutcome }> | null = null
  private pendingAuth: Promise<AuthResult> | null = null
  constructor(private readonly config: GetuiPushConfig, private readonly transport: GetuiTransport = sendGetuiHttps, private readonly now: () => number = Date.now) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.appId)) throw new Error('Getui configuration invalid')
  }
  private async call(path: '/auth' | '/push/single/cid', body: JsonObject, token?: string): Promise<GetuiWireResult> {
    try {
      return await this.transport({ origin: ORIGIN, path: `/v2/${this.config.appId}${path}`, headers: { 'content-type': 'application/json;charset=UTF-8', ...(token ? { token } : {}) }, body: JSON.stringify(body) })
    } catch { return { kind: 'unknown' } }
  }
  private async authenticate(): Promise<AuthResult> {
    const now = this.now()
    if (this.cached && now >= this.cached.issuedAt && now < this.cached.expiresAt - AUTH_SKEW_MS) return this.cached
    if (this.pendingAuth) return this.pendingAuth
    const run = async (): Promise<AuthResult> => {
      const timestamp = String(this.now())
      const sign = createHash('sha256').update(this.config.appKey + timestamp + this.config.masterSecret).digest('hex')
      const response = await this.call('/auth', { appkey: this.config.appKey, timestamp, sign })
      // Authentication cannot send a notification, so any transport uncertainty is safely retryable.
      if (response.kind !== 'response') return { outcome: retry('GETUI_AUTH_UNAVAILABLE') }
      const result = parseResponse(response)
      if (response.status >= 500 || response.status === 429 || result && [2, 10003, 10005, 30019, 30022, 5000].includes(Number(result.code))) return { outcome: retry('GETUI_AUTH_UNAVAILABLE') }
      if (response.status !== 200 || !result || result.code !== 0) return { outcome: configuration() }
      const data = result.data, receivedAt = this.now()
      if (!object(data) || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(data.token)
        || typeof data.expire_time !== 'string' || !/^\d{13}$/.test(data.expire_time)
        || Number(data.expire_time) <= receivedAt + AUTH_SKEW_MS) return { outcome: retry('GETUI_AUTH_INVALID_RESPONSE') }
      const auth = { token: data.token, expiresAt: Number(data.expire_time), issuedAt: receivedAt }
      this.cached = auth
      return auth
    }
    this.pendingAuth = run()
    try { return await this.pendingAuth } finally { this.pendingAuth = null }
  }
  async send(request: NativePushSendRequest): Promise<NativePushDeliveryOutcome> {
    const expires = Date.parse(request.expiresAt)
    if (!Number.isFinite(expires) || expires <= this.now()) return { status: 'rejected', code: 'EVENT_EXPIRED' }
    if (!/^[a-f0-9]{32}$/.test(request.token)) return { status: 'rejected', code: 'GETUI_TOKEN_INVALID', invalidToken: true }
    if (!UUID.test(request.deliveryId) || !request.requestId || request.requestId.length > 256) return { status: 'rejected', code: 'GETUI_REQUEST_REJECTED' }
    const auth = await this.authenticate()
    if ('outcome' in auth) return auth.outcome
    // The event can expire while acquiring a token. Never send with zero/default provider TTL.
    const ttl = Math.min(expires - this.now(), 3 * 24 * 3600_000)
    if (ttl <= 0) return { status: 'rejected', code: 'EVENT_EXPIRED' }
    const payload = JSON.stringify({ mbox: { protocol: 1, kind: 'service_task', deliveryId: request.deliveryId } })
    const intent = 'intent:#Intent;action=com.mbox.staff.nativeapp.NATIVE_PUSH;launchFlags=0x4000000;package=com.mbox.staff.nativeapp;component=com.mbox.staff.nativeapp/com.mbox.staff.MainActivity;S.payload=' + encodeURIComponent(payload) + ';end'
    const notification = { title: 'M-BOX 服务待办', body: '有待处理事项，请打开工作台核对最新状态', click_type: 'intent', intent }
    const response = await this.call('/push/single/cid', {
      request_id: getuiRequestId(request.requestId), settings: { ttl }, audience: { cid: [request.token] },
      push_message: { notification: { ...notification, channel_id: 'mbox-service-realtime', channel_name: '服务待办' } },
    }, auth.token)
    if (response.kind === 'not_sent') return retry('GETUI_NOT_SENT')
    if (response.kind === 'unknown') return unknown()
    const result = parseResponse(response)
    if (!result) return unknown()
    if (result.code === 10001 && response.status === 401) {
      if (this.cached?.token === auth.token) this.cached = null
      return retry('GETUI_AUTH_EXPIRED')
    }
    if ([2, 10003, 10005, 30019, 30022, 5000].includes(Number(result.code)) && [200, 401, 403].includes(response.status)) return retry('GETUI_RETRYABLE')
    if (response.status >= 500 || response.status < 200 || response.status >= 300 && ![400, 401, 403, 404, 405].includes(response.status)) return unknown()
    if (result.code === 0 && response.status === 200) {
      // A receipt for another CID, absent receipt, or a new undocumented status is not success.
      if (!object(result.data) || Object.keys(result.data).length !== 1) return unknown()
      const receipt = Object.values(result.data)[0]
      if (!object(receipt) || Object.keys(receipt).length !== 1 || !Object.hasOwn(receipt, request.token)) return unknown()
      const status = receipt[request.token]
      if (status === 'successed_online' || status === 'successed_offline') return { status: 'provider_accepted' }
      if (status === 'successed_ignore') return { status: 'rejected', code: 'GETUI_DEVICE_INACTIVE' }
      return unknown()
    }
    if (result.code === 20001 && response.status === 400 && ['target user is invalid', 'appid not match cid'].includes(String(result.msg))) return { status: 'rejected', code: 'GETUI_TOKEN_INVALID', invalidToken: true }
    if ([301, 10002, 10004, 404, 405].includes(Number(result.code)) || response.status === 403 || response.status === 401) return configuration()
    if ([1, 20001].includes(Number(result.code)) && [200, 400].includes(response.status)) return { status: 'rejected', code: 'GETUI_REQUEST_REJECTED' }
    return unknown()
  }
}

/** No redirects, host overrides, credentials in URLs or unbounded response buffering. */
export function sendGetuiHttps(wire: GetuiWireRequest): Promise<GetuiWireResult> {
  if (wire.origin !== ORIGIN || !/^\/v2\/[A-Za-z0-9_-]{1,128}\/(auth|push\/single\/cid)$/.test(wire.path)) return Promise.resolve({ kind: 'not_sent' })
  return new Promise(resolve => {
    let settled = false, sent = false
    const chunks: Buffer[] = []
    let length = 0
    const finish = (result: GetuiWireResult) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); resolve(result) }
    const failed = () => finish({ kind: sent ? 'unknown' : 'not_sent' })
    const req = httpsRequest(ORIGIN + wire.path, { method: 'POST', headers: wire.headers, rejectUnauthorized: true }, response => {
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_RESPONSE_BYTES) failed(); else chunks.push(chunk) })
      response.on('error', failed)
      response.on('aborted', failed)
      response.on('end', () => finish({ kind: 'response', status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(failed, 10_000)
    timer.unref()
    req.on('error', failed)
    req.on('socket', socket => socket.once('secureConnect', () => { sent = true }))
    // Once end() queues a request, a reused TLS socket can send it without secureConnect firing.
    sent = true
    req.end(wire.body)
  })
}
