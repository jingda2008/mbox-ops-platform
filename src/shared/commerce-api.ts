import { z } from 'zod'

export const quickOrderSchema = z.object({
  tableId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const cartOrderSchema = z.object({
  tableId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(50),
  })).min(1).max(50),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const kdsActionSchema = z.object({
  action: z.enum(['start', 'complete', 'pickUp', 'deliver']),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const authorizationRequestSchema = z.object({
  orderId: z.string().min(1),
  kind: z.enum(['discount', 'gift']),
  lineIds: z.array(z.string().min(1)).min(1),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const authorizationDecisionSchema = z.object({
  decision: z.enum(['granted', 'rejected']),
  actorId: z.string().min(1),
  reason: z.string().max(200).default(''),
  idempotencyKey: z.string().min(8).max(128),
})

export const authorityWriteSchema = z.object({
  actorId: z.string().trim().min(1),
  kinds: z.array(z.enum(['discount', 'gift'])).min(1).max(2),
  maxAmount: z.number().int().min(0).max(10_000_000),
  allowedSkuIds: z.array(z.string().trim().min(1)).nullable(),
  tableSessionIds: z.array(z.string().trim().min(1)).nullable(),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
})

export type QuickOrderInput = z.infer<typeof quickOrderSchema>
export type CartOrderInput = z.infer<typeof cartOrderSchema>
export type KdsActionInput = z.infer<typeof kdsActionSchema>
export type AuthorityWriteInput = z.infer<typeof authorityWriteSchema>
