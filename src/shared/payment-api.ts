import { z } from 'zod'

export const createTablePaymentIntentSchema = z.object({
  tableSessionId: z.string().trim().min(1),
  channel: z.enum(['wechat_mock', 'physical_pos']),
  actorId: z.string().trim().min(1).default('emp-lin'),
  deviceId: z.string().trim().min(1).default('cashier-web'),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const simulatePaymentSuccessSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const physicalPosReportSchema = z.object({
  terminalId: z.string().trim().min(1).max(64),
  terminalTransactionId: z.string().trim().min(1).max(128),
  paymentMethod: z.string().trim().min(1).max(32),
  receiptReference: z.string().trim().max(128).optional(),
  actorId: z.string().trim().min(1).default('emp-lin'),
  deviceId: z.string().trim().min(1).default('cashier-web'),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const itemRefundRequestSchema = z.object({
  orderId: z.string().trim().min(1),
  orderItemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(99),
  reason: z.string().trim().min(2).max(200),
  actorId: z.string().trim().min(1).default('emp-lin'),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const completeRefundSchema = z.object({
  actorId: z.string().trim().min(1).default('emp-chen'),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export type CreateTablePaymentIntentInput = z.infer<typeof createTablePaymentIntentSchema>
export type PhysicalPosReportInput = z.infer<typeof physicalPosReportSchema>
export type ItemRefundRequestInput = z.infer<typeof itemRefundRequestSchema>
