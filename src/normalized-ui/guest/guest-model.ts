export type GuestMood =
  | 'happy'
  | 'excited'
  | 'listening'
  | 'social'
  | 'celebrating'
  | 'quiet'
  | 'tired'
  | 'uncomfortable'

export function menuRequestDelayMs(initialMenuAlreadyRequested: boolean): number {
  return initialMenuAlreadyRequested ? 280 : 0
}

export interface GuestAccess {
  tableCode: string
  tableQrToken: string
}

export interface GuestMenuProduct {
  productId: string
  code: string
  name: string
  categoryCode: string
  categoryName: string
  beverageFamily: MenuBeverageFamily
  specification: string | null
  aliases: string[]
  tags: string[]
  imageUrl: string | null
  description: string | null
  sortOrder: number
  availableFrom: string | null
  availableUntil: string | null
  guestVisible: boolean
  requiresFulfillment: boolean
  maxOrderQuantity: number
  amountMinor: number
  currency: string
  fulfillmentStation: string
  productKind: 'single' | 'bundle'
  bundleComponents: Array<{ productId: string; name: string; quantity: number }>
  recommendation: MenuRecommendationConfig
  /** Added by the client from the server-returned order; never serialized by the API. */
  serverRecommendationOrder?: number
  available: boolean
}

export interface GuestCartLine {
  product: GuestMenuProduct
  quantity: number
}

export type GuestCart = Readonly<Record<string, GuestCartLine>>

export interface GuestAccessParseResult {
  access: GuestAccess | null
  error: string | null
}

export function guestCartStorageKey(session: Readonly<{
  status: 'active' | 'already_active' | 'waiting_for_table'
  table: { code: string }
  cartScope?: string | null
}>): string | undefined {
  if (session.status === 'waiting_for_table' || !session.cartScope) return undefined
  return `mbox:guest-cart:${session.table.code}:${session.cartScope}`
}

const TABLE_CODE_PATTERN = /^[A-Z0-9-]{1,24}$/
const TABLE_QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/

export function parseGuestAccess(rawUrl: string, base = 'https://mbox.invalid/'): GuestAccessParseResult {
  let url: URL
  try {
    url = new URL(rawUrl, base)
  } catch {
    return { access: null, error: '这个桌面入口无法识别，请重新扫描桌面二维码。' }
  }
  const tableCode = (url.searchParams.get('table') ?? '').trim().toUpperCase()
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const tableQrToken = (fragment.get('token') ?? '').trim()
  if (!TABLE_CODE_PATTERN.test(tableCode)) {
    return { access: null, error: '没有识别到桌号，请重新扫描桌面上的固定二维码。' }
  }
  if (!TABLE_QR_TOKEN_PATTERN.test(tableQrToken)) {
    return { access: null, error: '桌面二维码信息不完整，请用微信重新扫描。' }
  }
  return { access: { tableCode, tableQrToken }, error: null }
}

export function parseGuestTableCode(rawUrl: string, base = 'https://mbox.invalid/'): string | null {
  try {
    const value = (new URL(rawUrl, base).searchParams.get('table') ?? '').trim().toUpperCase()
    return TABLE_CODE_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

export function tokenFreeLocation(url: URL): string {
  return `${url.pathname}${url.search}`
}

export function addCartProduct(cart: GuestCart, product: GuestMenuProduct): GuestCart {
  if (!product.available) return cart
  const current = cart[product.productId]
  const quantity = Math.min(999, (current?.quantity ?? 0) + 1)
  return { ...cart, [product.productId]: { product, quantity } }
}

export function changeCartQuantity(cart: GuestCart, productId: string, delta: number): GuestCart {
  const current = cart[productId]
  if (current === undefined || !Number.isInteger(delta) || delta === 0) return cart
  const quantity = Math.max(0, Math.min(999, current.quantity + delta))
  if (quantity === 0) {
    const next = { ...cart }
    delete next[productId]
    return next
  }
  return { ...cart, [productId]: { ...current, quantity } }
}

export function cartLines(cart: GuestCart): GuestCartLine[] {
  return Object.values(cart)
}

export function cartItemCount(cart: GuestCart): number {
  return cartLines(cart).reduce((total, line) => total + line.quantity, 0)
}

export function cartTotalMinor(cart: GuestCart): number {
  return cartLines(cart).reduce((total, line) => total + line.product.amountMinor * line.quantity, 0)
}

export function cartOrderItems(cart: GuestCart): Array<{ productId: string; quantity: number }> {
  return cartLines(cart).map((line) => ({ productId: line.product.productId, quantity: line.quantity }))
}

export function categoryLabel(categoryCode: string): string {
  const labels: Record<string, string> = {
    recommended: '今夜推荐',
    combo: '组合精选',
    cocktail: '鸡尾酒',
    beer: '啤酒',
    wine: '葡萄酒',
    sparkling: '起泡酒',
    spirits: '洋酒',
    non_alcoholic: '无酒精',
    snack: '小食',
    food: '餐食',
    other: '其他',
  }
  return labels[categoryCode] ?? categoryCode
}

export function formatMoney(amountMinor: number, currency = 'CNY'): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return '--'
  if (currency === 'CNY') {
    return `¥${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(amountMinor / 100)}`
  }
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amountMinor / 100)
}

export function safeIdempotencyKey(prefix: string, randomUuid: () => string = () => crypto.randomUUID()): string {
  return `${prefix}-${randomUuid()}`
}
import type {
  MenuBeverageFamily,
  MenuRecommendationConfig,
} from '../../shared/contracts'
