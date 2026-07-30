import { z } from 'zod'

const paymentAllocationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({
    mode: z.literal('items'),
    items: z.array(z.object({
      orderId: z.string().trim().min(1),
      orderItemId: z.string().trim().min(1),
      quantity: z.number().int().min(1).max(999),
    }).strict()).min(1).max(100),
  }).strict(),
  z.object({
    mode: z.literal('amount'),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
])

export const createTablePaymentIntentSchema = z.object({
  tableSessionId: z.string().trim().min(1),
  channel: z.enum(['cash', 'wechat_mock', 'physical_pos', 'postar']),
  allocation: paymentAllocationSchema.default({ mode: 'all' }),
  providerPayment: z.union([
    z.object({
      presentation: z.literal('jsapi').default('jsapi'),
      payWay: z.enum(['wechat', 'alipay']),
      payerId: z.string().trim().min(1).max(128),
      wxAppid: z.string().trim().min(1).max(64).optional(),
    }).strict(),
    z.object({ presentation: z.literal('qr') }).strict(),
    z.object({
      presentation: z.literal('barcode'),
      customerAuthCode: z.string().trim().regex(
        /^(?:1[0-5]\d{16}|(?:2[5-9]|30)\d{14,22}|62\d{17})$/,
        '仅支持有效的微信、支付宝或云闪付付款码',
      ),
    }).strict(),
  ]).optional(),
  deviceId: z.string().trim().min(1).default('cashier-web'),
  sourceRefundId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((input, context) => {
  if (input.channel === 'postar' && !input.providerPayment) {
    context.addIssue({ code: 'custom', path: ['providerPayment'], message: '星驿下单必须提供JSAPI、客扫支付码或付款码方式' })
  }
  if (input.channel !== 'postar' && input.providerPayment) {
    context.addIssue({ code: 'custom', path: ['providerPayment'], message: '非星驿渠道不能携带星驿下单参数' })
  }
  if (input.providerPayment?.presentation === 'jsapi' && input.providerPayment.payWay === 'wechat' && !input.providerPayment.wxAppid) {
    context.addIssue({ code: 'custom', path: ['providerPayment', 'wxAppid'], message: '微信JSAPI下单必须提供wxAppid' })
  }
})

export const simulatePaymentSuccessSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const cashPaymentConfirmationSchema = z.object({
  deviceId: z.string().trim().min(1).default('cashier-web'),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export const physicalPosReportSchema = z.object({
  terminalId: z.string().trim().min(1).max(64),
  terminalTransactionId: z.string().trim().min(1).max(128),
  paymentMethod: z.string().trim().min(1).max(32),
  receiptReference: z.string().trim().max(128).optional(),
  deviceId: z.string().trim().min(1).default('cashier-web'),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const itemRefundRequestSchema = z.object({
  orderId: z.string().trim().min(1),
  orderItemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(99),
  reason: z.string().trim().min(2).max(200),
  orderDisposition: z.enum(['cancel_items', 'retain_order']).default('cancel_items'),
  receivableDisposition: z.enum(['reduce_receivable', 'reopen_receivable']).default('reduce_receivable'),
  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((input, context) => {
  if (input.orderDisposition === 'cancel_items' && input.receivableDisposition === 'reopen_receivable') {
    context.addIssue({
      code: 'custom',
      path: ['receivableDisposition'],
      message: '退掉商品后不能恢复同一笔应收；如需重新收款，请选择保留订单',
    })
  }
})

export const completeRefundSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
})

export const physicalPosRefundCompletionSchema = z.object({
  terminalRefundTransactionId: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
})

const settlementAmountsSchema = z.object({
  cash: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  physical_pos: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  wechat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  alipay: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unionpay: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const submitCashierHandoverSchema = z.object({
  confirmedActualAmounts: settlementAmountsSchema,
  issues: z.array(z.object({
    channel: z.enum(['cash', 'physical_pos', 'wechat', 'alipay', 'unionpay']),
    reason: z.string().trim().min(2).max(300),
    nextDayOwnerId: z.string().trim().min(1).max(128),
  }).strict()).max(5).default([]),
  note: z.string().trim().max(500).optional(),
  deviceId: z.string().trim().min(1).default('cashier-web'),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export const reviewCashierHandoverSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict().superRefine((input, context) => {
  if (input.decision === 'reject' && (!input.note || input.note.length < 2)) {
    context.addIssue({ code: 'custom', path: ['note'], message: '驳回时必须填写复核说明' })
  }
})

export const providerPaymentQuerySchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export const providerRefundSubmissionSchema = z.object({
  reason: z.string().trim().min(2).max(300),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export const providerRefundQuerySchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type CreateTablePaymentIntentInput = z.infer<typeof createTablePaymentIntentSchema>
export type PaymentAllocationInput = z.infer<typeof paymentAllocationSchema>
export type PhysicalPosReportInput = z.infer<typeof physicalPosReportSchema>
export type ItemRefundRequestInput = z.infer<typeof itemRefundRequestSchema>
export type PhysicalPosRefundCompletionInput = z.infer<typeof physicalPosRefundCompletionSchema>
export type SubmitCashierHandoverInput = z.infer<typeof submitCashierHandoverSchema>
export type ReviewCashierHandoverInput = z.infer<typeof reviewCashierHandoverSchema>
