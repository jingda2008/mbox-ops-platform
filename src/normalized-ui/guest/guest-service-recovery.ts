import type { GuestApiClient, GuestServiceResult } from './guest-api'
import { safeIdempotencyKey } from './guest-model'

type ServiceInput = Parameters<GuestApiClient['requestService']>[0]
export interface GuestServiceIntent {
  key: string
  input: ServiceInput
  retryAt: string | null
  createdAt: number
}
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// One unresolved intent per authenticated table/device. Persist the original
// body before sending; refresh, timeout, throttling and 401 never invent a key.
export class GuestServiceRecovery {
  private readonly storageKey: string
  private readonly storage: IntentStorage
  private flight: Promise<GuestServiceResult> | null = null
  constructor(storage: IntentStorage, cartScope: string, deviceKey: string) {
    if (!cartScope || !deviceKey) throw new Error('桌位连接尚未确认，请刷新后再试。')
    this.storage = storage
    this.storageKey = `mbox:guest-service:v1:${JSON.stringify([cartScope, deviceKey])}`
  }

  pending(): GuestServiceIntent | null {
    const text = this.storage.getItem(this.storageKey)
    if (text === null) return null
    const value = JSON.parse(text) as GuestServiceIntent
    if (!value || typeof value.key !== 'string' || !value.key || !value.input
      || !Number.isFinite(value.createdAt)
      || !['call_staff', 'complaint', 'custom'].includes(value.input.requestType)
      || (value.input.detail !== null && typeof value.input.detail !== 'string')) {
      throw new Error('本次服务请求记录需要核对，请联系服务员。')
    }
    return value
  }

  execute(input: ServiceInput | null, send: GuestApiClient['requestService']): Promise<GuestServiceResult> {
    if (this.flight) return this.flight
    const execute = async () => {
      let intent = this.pending()
      if (intent && input && JSON.stringify(intent.input) !== JSON.stringify(input)) {
        throw new Error('请先恢复上一条服务请求，确认结果后再提交新的需要。')
      }
      if (!intent) {
        if (!input) throw new Error('没有待恢复的服务请求。')
        intent = { key: safeIdempotencyKey(`guest-service-${input.requestType}`), input: { ...input }, retryAt: null, createdAt: Date.now() }
        const text = JSON.stringify(intent)
        this.storage.setItem(this.storageKey, text)
        if (this.storage.getItem(this.storageKey) !== text) throw new Error('无法保存本次请求，请允许本地存储后重试。')
      }
      const result = await send(intent.input, { idempotencyKey: intent.key })
      // A malformed success is still unknown, never permission to send anew.
      if (result.status === 'created' || result.status === 'merged') this.storage.removeItem(this.storageKey)
      else if (result.status === 'rate_limited') {
        this.storage.setItem(this.storageKey, JSON.stringify({ ...intent, retryAt: result.retryAt ?? null }))
      } else throw new Error('服务结果尚未确认，请恢复本次请求。')
      return result
    }
    this.flight = execute().finally(() => { this.flight = null })
    return this.flight
  }
}
