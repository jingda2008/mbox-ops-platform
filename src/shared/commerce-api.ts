import { z } from 'zod'

export const quickOrderSchema = z.object({
  tableId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(9999),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const cartOrderSchema = z.object({
  tableId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(9999),
  })).min(1).max(50),
  fulfillmentNote: z.string().trim().max(300).default(''),
  settlementMode: z.enum(['immediate_payment', 'table_tab']).default('immediate_payment'),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

export const assistedPaymentLinkSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
})

export interface AssistedPaymentLink {
  orderId: string
  tableCode: string
  amount: number
  tableToken: string
  expiresAt: string
}

export const kdsActionSchema = z.object({
  action: z.enum(['start', 'complete', 'completeAndDeliver', 'pickUp', 'pickupAndDeliver', 'deliver']),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
})

const kdsExceptionReasonSchema = z.enum([
  'product_out_of_stock',
  'ingredient_out_of_stock',
  'equipment_unavailable',
  'quality_rejected',
  'wrong_product',
  'wrong_specification',
  'damaged',
  'other',
])

const kdsExceptionReasonsByKind = {
  shortage: new Set(['product_out_of_stock', 'ingredient_out_of_stock', 'equipment_unavailable', 'other']),
  production_rejection: new Set(['equipment_unavailable', 'quality_rejected', 'damaged', 'other']),
  wrong_item: new Set(['wrong_product', 'wrong_specification', 'quality_rejected', 'damaged', 'other']),
} as const

export const kdsExceptionReportSchema = z.object({
  exceptionKind: z.enum(['shortage', 'production_rejection', 'wrong_item']),
  reasonCode: kdsExceptionReasonSchema,
  reasonNote: z.string().trim().max(200).default(''),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
}).superRefine((input, context) => {
  if (!kdsExceptionReasonsByKind[input.exceptionKind].has(input.reasonCode)) {
    context.addIssue({ code: 'custom', path: ['reasonCode'], message: '异常类型与原因不匹配' })
  }
})

export const kdsExceptionDecisionSchema = z.object({
  disposition: z.enum(['cancelled', 'remake']),
  reasonCode: z.enum([
    'unavailable_confirmed',
    'guest_cancelled',
    'manager_cancelled',
    'service_recovery',
    'quality_recovery',
    'other',
  ]),
  reasonNote: z.string().trim().max(200).default(''),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
}).superRefine((input, context) => {
  const allowed = input.disposition === 'cancelled'
    ? ['unavailable_confirmed', 'guest_cancelled', 'manager_cancelled', 'other']
    : ['service_recovery', 'quality_recovery', 'other']
  if (!allowed.includes(input.reasonCode)) {
    context.addIssue({ code: 'custom', path: ['reasonCode'], message: '经理处置与原因不匹配' })
  }
  if (input.reasonCode === 'other' && !input.reasonNote) {
    context.addIssue({ code: 'custom', path: ['reasonNote'], message: '其他处置原因必须填写说明' })
  }
})

export const managerKdsCancellationSchema = z.object({
  reasonCode: z.enum(['unavailable_confirmed', 'guest_cancelled', 'manager_cancelled', 'other']),
  reasonNote: z.string().trim().max(200).default(''),
  idempotencyKey: z.string().min(8).max(128),
})

export const complimentaryOrderSchema = z.object({
  tableId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(9999),
  })).min(1).max(20),
  reason: z.string().trim().min(2).max(200),
  fulfillmentNote: z.string().trim().max(500).default(''),
  sourceKdsTaskId: z.string().min(1).nullable().default(null),
  idempotencyKey: z.string().min(8).max(128),
})

export interface ManagerKdsCancellationResult {
  cancellationEventId: string
  taskId: string
  orderId: string
  orderItemId: string
  itemName: string
  quantity: number
  accounting: {
    policy: 'manual_confirmation_required'
    mutationApplied: false
    recommendation: 'review_refund' | 'review_receivable' | 'no_financial_action'
    payableAmount: number
    paidAmount: number
    refundedAmount: number
    suggestedAmount: number
  }
}

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
  allowedCategoryIds: z.array(z.string().trim().min(1)).nullable().default(null),
  tableSessionIds: z.array(z.string().trim().min(1)).nullable(),
  maxPerTableAmount: z.number().int().min(0).max(100_000_000).nullable().default(null),
  maxPerShiftAmount: z.number().int().min(0).max(100_000_000).nullable().default(null),
  maxPerBusinessDayAmount: z.number().int().min(0).max(100_000_000).nullable().default(null),
  maxPerMonthAmount: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
  maxPerBusinessDayCount: z.number().int().min(1).max(10_000).nullable().default(null),
  maxQuantityPerOrder: z.number().int().min(1).max(10_000).nullable().default(null),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
})

export type QuickOrderInput = z.infer<typeof quickOrderSchema>
export type CartOrderInput = z.infer<typeof cartOrderSchema>
export type AssistedPaymentLinkInput = z.infer<typeof assistedPaymentLinkSchema>
export type KdsActionInput = z.infer<typeof kdsActionSchema>
export type KdsExceptionReportInput = z.infer<typeof kdsExceptionReportSchema>
export type KdsExceptionDecisionInput = z.infer<typeof kdsExceptionDecisionSchema>
export type ManagerKdsCancellationInput = z.infer<typeof managerKdsCancellationSchema>
export type ComplimentaryOrderInput = z.infer<typeof complimentaryOrderSchema>
export type AuthorityWriteInput = z.infer<typeof authorityWriteSchema>
