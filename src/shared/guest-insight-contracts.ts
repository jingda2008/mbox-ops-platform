import { z } from 'zod'

export const guestBehaviorEventTypes = [
  'session_started',
  'tab_viewed',
  'mood_selected',
  'service_requested',
  'service_feedback',
  'category_viewed',
  'recommendation_viewed',
  'quick_select_started',
  'quick_select_exited',
  'quick_select_answered',
  'quick_select_completed',
  'recommendation_reranked',
  'recommendation_result_updated',
  'shake_requested',
  'shake_result_viewed',
  'product_detail_viewed',
  'recommendation_accepted',
  'upgrade_accepted',
  'product_added',
  'product_removed',
  'cart_cleared',
  'cart_abandoned',
  'cart_submitted',
  'order_created',
  'checkout_started',
  'payment_completed',
  'singer_profile_viewed',
  'song_requested',
] as const

export type GuestBehaviorEventType = (typeof guestBehaviorEventTypes)[number]
export type GuestBehaviorValue = string | number | boolean | null

const metadataSchema = z.record(
  z.string().trim().min(1).max(64),
  z.union([z.string().trim().max(128), z.number().finite(), z.boolean(), z.null()]),
).superRefine((value, context) => {
  if (Object.keys(value).length > 20) context.addIssue({ code: 'custom', message: '行为属性最多20项' })
})

export const guestBehaviorEventSchema = z.object({
  tableToken: z.string().trim().min(20).max(2048),
  eventType: z.enum(guestBehaviorEventTypes),
  metadata: metadataSchema.default({}),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type GuestBehaviorEventInput = z.infer<typeof guestBehaviorEventSchema>

export interface GuestIdentityView {
  anonymousId: string
  memberLinked: boolean
  wechatLinked: boolean
}

export interface GuestBehaviorAccepted {
  accepted: true
  anonymousId: string
}
