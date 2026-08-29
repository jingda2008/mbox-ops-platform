const PENDING_GUEST_PAYMENT_ABANDONMENT_KEY = 'mbox.pending.guest.payment.abandon.v1'

// The Mini Program is intentionally conservative while the native WeChat
// sheet is visible, but once the page has a definitive cancellation or a
// non-presentable action it asks the server to query/close the rail. The
// server, not this local marker, decides whether the operational order can be
// retired.
function canAbandonPendingGuestPayment(pendingPayment, tableScope) {
  // rc.160 stored the same customer-only local key without the explicit
  // checkout kind/presentation fields.  Treat that narrowly-defined legacy
  // shape as this same self-checkout flow so an old cancelled attempt cannot
  // survive forever after the upgrade.  We never infer this from a table-wide
  // order row; callers only persist it for `isMine` guest QR orders.
  const legacyCustomerCheckout = pendingPayment
    && pendingPayment.checkoutKind === undefined
    && typeof pendingPayment.retryIdempotencyKey === 'string'
    && pendingPayment.retryIdempotencyKey.length >= 8
  const checkoutKindValid = pendingPayment
    && (pendingPayment.checkoutKind === 'guest_immediate_payment' || legacyCustomerCheckout)
  const presentationState = pendingPayment && (pendingPayment.paymentPresentationState || 'ready_not_presented')
  return Boolean(
    pendingPayment
      && checkoutKindValid
      && typeof pendingPayment.orderPublicId === 'string'
      && pendingPayment.orderPublicId.length >= 8
      && pendingPayment.tableScope === tableScope
      && pendingPayment.wechatAcceptedAt === undefined
      && pendingPayment.paymentPresentationInFlight !== true
      && ['ready_not_presented', 'action_failed', 'cancelled', 'result_unknown']
        .includes(presentationState),
  )
}

function createGuestPaymentAbandonmentRecord(pendingPayment, tableScope, createIdempotencyKey) {
  if (!canAbandonPendingGuestPayment(pendingPayment, tableScope)) return null
  const idempotencyKey = typeof pendingPayment.abandonmentIdempotencyKey === 'string'
    && pendingPayment.abandonmentIdempotencyKey.length >= 8
    ? pendingPayment.abandonmentIdempotencyKey
    : createIdempotencyKey(pendingPayment.orderPublicId)
  return {
    version: 1,
    orderPublicId: pendingPayment.orderPublicId,
    tableScope,
    idempotencyKey,
    reason: pendingPayment.paymentPresentationState || 'ready_not_presented',
    createdAt: new Date().toISOString(),
  }
}

function isRetryableGuestPaymentAbandonment(record, tableScope, order) {
  return Boolean(
    record
      && record.version === 1
      && typeof record.orderPublicId === 'string'
      && typeof record.idempotencyKey === 'string'
      && record.idempotencyKey.length >= 8
      && record.tableScope === tableScope
      && record.state !== 'reconciliation_required'
      && order
      && order.publicId === record.orderPublicId
      && Number(order.payableAmountMinor || 0) > 0
      && order.paymentStatus !== 'paid'
      && ['available', 'payment_in_progress', 'status_review'].includes(order.paymentAccess),
  )
}

module.exports = {
  PENDING_GUEST_PAYMENT_ABANDONMENT_KEY,
  canAbandonPendingGuestPayment,
  createGuestPaymentAbandonmentRecord,
  isRetryableGuestPaymentAbandonment,
}
