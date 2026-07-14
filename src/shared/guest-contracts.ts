import { z } from 'zod'
import type { ServiceTask, ServiceTypeConfig } from './contracts.js'
import type { ItemFulfillmentStatus, OrderStatus } from './order-contracts.js'
import type { SongRequestStatus } from './song-contracts.js'

export interface TableAccessClaims {
  version: 1
  storeId: string
  tableCode: string
  tokenVersion: number
  issuedAt: number
}

export interface GuestServiceType extends Pick<ServiceTypeConfig, 'id' | 'code' | 'name' | 'icon' | 'priority'> {}

export interface GuestTaskView extends Pick<
  ServiceTask,
  'id' | 'serviceTypeId' | 'status' | 'priority' | 'createdAt' | 'updatedAt' | 'customerReply'
> {
  ownerName: string | null
}

export interface GuestSessionResponse {
  store: { id: string; name: string; businessDate: string }
  table: { code: string; displayName: string; status: string; occupied: boolean }
  primaryServiceName: string | null
  serviceTypes: GuestServiceType[]
  tasks: GuestTaskView[]
  account: {
    tableSessionId: string | null
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
  }>
  songRequests: Array<{
    id: string
    status: SongRequestStatus
    songTitle: string
    singerName: string
    priceAmount: number
    currency: string
    createdAt: string
  }>
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

export type GuestTaskCreateInput = z.infer<typeof guestTaskCreateSchema>
export type GuestTaskFeedbackInput = z.infer<typeof guestTaskFeedbackSchema>
export type GuestSongRequestInput = z.infer<typeof guestSongRequestSchema>
