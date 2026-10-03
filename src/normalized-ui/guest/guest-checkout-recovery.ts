import { GuestApiError, type GuestApiClient, type GuestOrderResult, type GuestSharedCart } from './guest-api'
import { safeIdempotencyKey } from './guest-model'
import type { MenuCartItem } from '../../components/MenuOrderingWorkspace'

export type GuestCheckoutInput =
  | { protocol: 1; body: Parameters<GuestApiClient['submitOrder']>[0] }
  | { protocol: 2; body: Parameters<GuestApiClient['checkoutSharedCart']>[0] }
export interface GuestCheckoutIntent { key: string; input: GuestCheckoutInput; createdAt: number }
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Only transaction-level rejection proves this exact checkout did not commit.
// Auth, provider/configuration, transport, 5xx and idempotency errors may happen
// while recovering an already committed order and must retain the original key.
const uncommittedCodes = new Set([
  'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', 'PRODUCT_UNAVAILABLE',
  'SHARED_CART_VERSION_CONFLICT', 'SHARED_CART_EMPTY', 'SHARED_CART_OPERATION_CONFLICT',
  'SHARED_CART_LIMIT_EXCEEDED', 'SHARED_CART_WRITES_FROZEN', 'CART_NOTE_STALE',
  'CHECKOUT_COUPON_RECONFIRM_REQUIRED',
])

export class GuestCheckoutRecovery {
  private readonly storageKey: string
  private flight: Promise<GuestOrderResult> | null = null

  private readonly storage: IntentStorage

  constructor(storage: IntentStorage, cartScope: string, deviceKey: string) {
    this.storage = storage
    if (!cartScope || !deviceKey) throw new Error('请重新连接桌位后再提交订单。')
    this.storageKey = `mbox:guest-checkout:v1:${JSON.stringify([cartScope, deviceKey])}`
  }

  pending(): GuestCheckoutIntent | null {
    const text = this.storage.getItem(this.storageKey)
    if (text === null) return null
    const value: unknown = JSON.parse(text)
    if (!isIntent(value)) throw new Error('原下单记录无法读取，请联系服务员核对，暂不重复提交。')
    return value
  }

  execute(input: GuestCheckoutInput | null, send: (intent: GuestCheckoutIntent) => Promise<GuestOrderResult>): Promise<GuestOrderResult> {
    // Check changed requests even when another call is in flight.
    const execute = async () => {
      let intent = this.pending()
      if (intent && input && JSON.stringify(intent.input) !== JSON.stringify(input)) {
        throw new Error('上一笔下单结果尚未确认，请先恢复原订单。')
      }
      if (this.flight) return this.flight
      if (!intent) {
        if (!input) throw new Error('没有待恢复的订单。')
        intent = { key: safeIdempotencyKey('guest-checkout'), input: structuredClone(input), createdAt: Date.now() }
        const serialized = JSON.stringify(intent)
        this.storage.setItem(this.storageKey, serialized)
        if (this.storage.getItem(this.storageKey) !== serialized) throw new Error('原下单记录未能保存，请允许本地存储后重试。')
      }
      const original = intent
      this.flight = (async () => {
        try {
          const result = await send(original)
          this.storage.removeItem(this.storageKey)
          if (this.storage.getItem(this.storageKey) !== null) throw new Error('原订单已返回，但恢复记录未能清理，请恢复原订单核对。')
          return result
        } catch (error) {
          if (error instanceof GuestApiError && error.kind === 'http' && error.status !== null
            && error.status >= 400 && error.status < 500 && uncommittedCodes.has(error.code)) {
            this.storage.removeItem(this.storageKey)
          }
          throw error
        } finally { this.flight = null }
      })()
      return this.flight
    }
    return execute()
  }
}

function isIntent(value: unknown): value is GuestCheckoutIntent {
  if (!value || typeof value !== 'object') return false
  const intent = value as GuestCheckoutIntent
  if (typeof intent.key !== 'string' || !/^guest-checkout-[a-zA-Z0-9-]{8,100}$/.test(intent.key)
    || !Number.isFinite(intent.createdAt) || !intent.input || !intent.input.body) return false
  const input = intent.input
  if (input.body.note !== null && typeof input.body.note !== 'string') return false
  if (input.protocol === 1) return Array.isArray(input.body.items) && input.body.items.length > 0
    && input.body.items.every(item => typeof item.productId === 'string' && Number.isSafeInteger(item.quantity) && item.quantity > 0)
  return input.protocol === 2 && Number.isSafeInteger(input.body.expectedGeneration) && input.body.expectedGeneration > 0
    && Number.isSafeInteger(input.body.expectedVersion) && input.body.expectedVersion >= 0
    && (input.body.lineNotes === undefined || Array.isArray(input.body.lineNotes)
      && input.body.lineNotes.every(item => typeof item.portionId === 'string' && typeof item.note === 'string'))
}

/** Product-wide UI instructions bind to every stable portion in this reviewed cart. */
export function guestCheckoutLineNotes(cart: GuestSharedCart, items: readonly MenuCartItem[]): Array<{ portionId: string; note: string }> {
  return items.flatMap(item => {
    const note = item.note?.trim()
    if (!note) return []
    const line = cart.lines.find(candidate => candidate.productId === item.productId)
    if (!line || line.quantity !== item.quantity || !line.portionIds || line.portionIds.length !== item.quantity
      || new Set(line.portionIds).size !== item.quantity || note.length > 300) {
      throw new Error('商品份数已变化或备注暂不能保存，请刷新购物车后核对。')
    }
    return line.portionIds.map(portionId => ({ portionId, note }))
  })
}

export function resolveGuestDeviceKey(session: IntentStorage, persistent: IntentStorage): string {
  const key = 'mbox-normalized-guest-device-v1'
  const valid = (value: string | null) => value !== null && value.length >= 8 && value.length <= 256
  // Preserve already-bound tabs; new tabs/reopened pages recover the same
  // browser identity rather than orphaning a durable checkout receipt.
  let existing: string | null = null
  try { existing = session.getItem(key) } catch { /* Try durable browser storage. */ }
  if (!valid(existing)) { try { existing = persistent.getItem(key) } catch { /* Sending still requires durable intent storage. */ } }
  const device = valid(existing) ? existing! : `guest-web-${crypto.randomUUID()}`
  try { session.setItem(key, device) } catch { /* Durable storage is checked below by checkout. */ }
  try { persistent.setItem(key, device) } catch { /* Checkout persistence will fail closed. */ }
  return device
}
