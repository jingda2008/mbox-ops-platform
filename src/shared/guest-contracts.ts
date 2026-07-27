import { z } from 'zod'
import type { CommunityBrandPresentation, MenuProduct, ServiceTask, ServiceTypeConfig } from './contracts.js'
import type { PaymentIntentStatus } from './payment-contracts.js'
import type { PaymentIntent } from './payment-contracts.js'
import type { Order } from './order-contracts.js'
import type { ItemFulfillmentStatus, OrderStatus } from './order-contracts.js'
import type { SongRequestStatus } from './song-contracts.js'
import type { SongRequestMode } from './song-contracts.js'
import type { GuestIdentityView } from './guest-insight-contracts.js'
import type { OrderSafetyConfig } from './commercial-ops-contracts.js'

interface TableTokenClaimsBase {
  version: 2
  storeId: string
  tableCode: string
  tokenVersion: number
  issuedAt: number
}

/** Long-lived credential printed on the physical table. It can only start a guest session. */
export interface StaticTableQrClaims extends TableTokenClaimsBase {
  tokenType: 'table_qr'
}

/** Short-lived write credential bound to one open visit of a table. */
export interface GuestSessionClaims extends TableTokenClaimsBase {
  tokenType: 'guest_session'
  tableSessionId: string
  expiresAt: number
}

export type TableAccessClaims = StaticTableQrClaims | GuestSessionClaims

export interface GuestServiceType extends Pick<ServiceTypeConfig, 'id' | 'code' | 'name' | 'icon' | 'priority'> {}

export interface GuestTaskView extends Pick<
  ServiceTask,
  'id' | 'serviceTypeId' | 'status' | 'priority' | 'createdAt' | 'updatedAt' | 'customerReply'
> {
  serviceTypeName: string
  ownerName: string | null
}

export interface GuestSessionResponse {
  store: { id: string; name: string; businessDate: string; timezone: string }
  communityBrand: CommunityBrandPresentation | null
  table: { code: string; displayName: string; status: string; occupied: boolean; guestCount: number }
  primaryServiceName: string | null
  orderSafety: OrderSafetyConfig
  serviceTypes: GuestServiceType[]
  products: MenuProduct[]
  tasks: GuestTaskView[]
  account: {
    tableSessionId: string | null
    sessionBusinessDate: string
    frozen: boolean
    frozenReason: string | null
    requiresManagerHandover: boolean
    balanceAmount: number
    orders: Array<{
      id: string
      status: OrderStatus
      createdAt: string
      payableAmount: number
      items: Array<{
        id: string
        name: string
        specification: string
        quantity: number
        amount: number
        fulfillmentStatus: ItemFulfillmentStatus
      }>
    }>
    payments: Array<{
      id: string
      orderIds: string[]
      amount: number
      status: PaymentIntentStatus
      channel: string
      paidAt: string | null
    }>
  }
  songOffers: Array<{
    id: string
    performanceSessionId: string
    appearanceId: string
    singerId: string
    songId: string
    songTitle: string
    songArtist: string
    singerName: string
    priceAmount: number
    currency: string
    startsAt: string
    endsAt: string
    durationSeconds: number
    requestMode: SongRequestMode | null
    requestAvailable: boolean
    requestUnavailableReason: string | null
    scheduleVersion: number
    repertoireVersion: number
  }>
  stageSchedule: Array<{
    performanceSessionId: string
    performanceTitle: string
    appearanceId: string
    singerId: string
    singerName: string
    startsAt: string
    endsAt: string
    acceptingRequests: boolean
    scheduleVersion: number
    advanceBookingEnabled: boolean
    extensionNegotiationEnabled: boolean
    extensionThresholdMinutes: number
    profile: {
      photoUrl: string
      headline: string
      bio: string
      styleTags: string[]
    }
  }>
  songRequests: Array<{
    id: string
    status: SongRequestStatus
    songTitle: string
    singerName: string
    priceAmount: number
    currency: string
    createdAt: string
    requestMode: SongRequestMode
  }>
  guestSession: {
    tableSessionId: string
    expiresAt: string
    tokenVersion: number
  }
  guestIdentity: GuestIdentityView
  tableToken: string
  serverNow: string
}

export const guestTaskCreateSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  serviceTypeId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const guestTaskFeedbackSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  action: z.enum(['confirm', 'unresolved']),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const guestSongRequestSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  appearanceId: z.string().trim().min(1).max(128),
  singerId: z.string().trim().min(1).max(128),
  songId: z.string().trim().min(1).max(128),
  customerNote: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const guestCartOrderSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(128),
    quantity: z.number().int().min(1).max(9999),
  })).min(1).max(50),
  confirmedDuplicateOrderId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const guestCheckoutSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  orderId: z.string().trim().min(1).max(128),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export interface WechatJsapiParameters {
  appId: string
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

export interface GuestCheckoutResponse {
  paymentIntent: PaymentIntent
  order: Order
  providerRequired: boolean
  wechatJsapiParameters: WechatJsapiParameters | null
  paymentUrl: string | null
}

export type GuestTaskCreateInput = z.infer<typeof guestTaskCreateSchema>
export type GuestTaskFeedbackInput = z.infer<typeof guestTaskFeedbackSchema>
export type GuestSongRequestInput = z.infer<typeof guestSongRequestSchema>
export type GuestCartOrderInput = z.infer<typeof guestCartOrderSchema>
export type GuestCheckoutInput = z.infer<typeof guestCheckoutSchema>
