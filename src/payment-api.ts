import { ApiError, getCurrentActorId } from './api'
import type {
  PaymentAllocationInput,
  ReviewCashierHandoverInput,
  SubmitCashierHandoverInput,
} from './shared/payment-api'
import type {
  CashierHandover,
  CashPaymentConfirmation,
  PaymentIntent,
  PaymentSettlementView,
  PhysicalPosReport,
  Refund,
} from './shared/payment-contracts'

export type PaymentCollectionChannel = 'cash' | 'wechat_mock' | 'physical_pos' | 'postar'

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

async function paymentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof navigator !== 'undefined' && !navigator.onLine && (init?.method ?? 'GET') !== 'GET') {
    throw new Error('当前处于离线状态，支付、退款与关账操作已禁止提交')
  }
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const sessionToken = window.localStorage.getItem('mbox.auth.token')
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`)
  } else {
    const actorId = getCurrentActorId()
    if (actorId) headers.set('x-mbox-actor-id', actorId)
    headers.set('x-mbox-store-id', 'mbox-lujiazui')
  }
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => null) as (T & { message?: string }) | null
  if (!response.ok) throw new ApiError(body?.message ?? '支付系统请求失败', response.status)
  if (!body) throw new ApiError('支付系统返回了无法识别的响应', response.status)
  return body
}

export function createTablePaymentIntent(
  tableSessionId: string,
  channel: PaymentCollectionChannel,
  allocation: PaymentAllocationInput,
  providerPayment?: { payWay: 'wechat' | 'alipay'; payerId: string; wxAppid?: string },
) {
  return paymentRequest<PaymentIntent>('/api/payments/table-intents', {
    method: 'POST',
    body: JSON.stringify({
      tableSessionId,
      channel,
      allocation,
      providerPayment,
      deviceId: 'cashier-web',
      idempotencyKey: idempotencyKey('payment-intent'),
    }),
  })
}

export function simulatePaymentSuccess(paymentIntentId: string) {
  return paymentRequest<PaymentIntent>(`/api/payments/${paymentIntentId}/dev-simulate-success`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: idempotencyKey('payment-simulate') }),
  })
}

export function confirmCashPayment(paymentIntentId: string) {
  return paymentRequest<CashPaymentConfirmation>(`/api/payments/${paymentIntentId}/cash-confirmations`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'cashier-web', idempotencyKey: idempotencyKey('cash-confirm') }),
  })
}

export function queryProviderPayment(paymentIntentId: string) {
  return paymentRequest(`/api/payments/${paymentIntentId}/provider-query`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: idempotencyKey('provider-query') }),
  })
}

export function reportPhysicalPos(
  paymentIntentId: string,
  terminalId: string,
  terminalTransactionId: string,
  paymentMethod: string,
  receiptReference: string,
) {
  return paymentRequest<PhysicalPosReport>(`/api/payments/${paymentIntentId}/physical-pos-reports`, {
    method: 'POST',
    body: JSON.stringify({
      terminalId,
      terminalTransactionId,
      paymentMethod,
      receiptReference,
      deviceId: 'cashier-web',
      idempotencyKey: idempotencyKey('pos-report'),
    }),
  })
}

export function requestItemRefund(
  paymentIntentId: string,
  orderId: string,
  orderItemId: string,
  quantity: number,
  reason: string,
) {
  return paymentRequest<Refund>(`/api/payments/${paymentIntentId}/refunds`, {
    method: 'POST',
    body: JSON.stringify({ orderId, orderItemId, quantity, reason, idempotencyKey: idempotencyKey('refund-request') }),
  })
}

export function approveAndCompleteRefund(refundId: string) {
  return paymentRequest<Refund>(`/api/payments/refunds/${refundId}/dev-approve-complete`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: idempotencyKey('refund-complete') }),
  })
}

export function completePhysicalPosRefund(refundId: string, terminalRefundTransactionId: string, reason: string) {
  return paymentRequest<Refund>(`/api/payments/refunds/${refundId}/physical-pos-complete`, {
    method: 'POST',
    body: JSON.stringify({ terminalRefundTransactionId, reason, idempotencyKey: idempotencyKey('physical-pos-refund') }),
  })
}

export function submitProviderRefund(refundId: string, reason: string) {
  return paymentRequest<Refund>(`/api/payments/refunds/${refundId}/provider-submit`, {
    method: 'POST',
    body: JSON.stringify({ reason, idempotencyKey: idempotencyKey('provider-refund-submit') }),
  })
}

export function queryProviderRefund(refundId: string) {
  return paymentRequest<Refund>(`/api/payments/refunds/${refundId}/provider-query`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: idempotencyKey('provider-refund-query') }),
  })
}

export function getPaymentSettlement(businessDate: string) {
  return paymentRequest<PaymentSettlementView>(`/api/business-days/${businessDate}/payment-settlement`)
}

export function submitCashierHandover(businessDate: string, input: Omit<SubmitCashierHandoverInput, 'idempotencyKey'>) {
  return paymentRequest<CashierHandover>(`/api/business-days/${businessDate}/cashier-handovers`, {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: idempotencyKey('cashier-handover') }),
  })
}

export function reviewCashierHandover(
  businessDate: string,
  handoverId: string,
  input: Omit<ReviewCashierHandoverInput, 'idempotencyKey'>,
) {
  return paymentRequest<CashierHandover>(`/api/business-days/${businessDate}/cashier-handovers/${handoverId}/review`, {
    method: 'POST',
    body: JSON.stringify({ ...input, idempotencyKey: idempotencyKey('cashier-handover-review') }),
  })
}

export function closeBusinessDay(businessDate: string, nextBusinessDate: string) {
  return paymentRequest(`/api/business-days/${businessDate}/close`, {
    method: 'POST',
    body: JSON.stringify({ nextBusinessDate, idempotencyKey: idempotencyKey('business-day-close') }),
  })
}
