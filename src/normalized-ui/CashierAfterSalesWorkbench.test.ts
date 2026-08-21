import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StaffAuthView } from '../normalized-api'
import type {
  CashierWorkbenchPayment,
  CashierWorkbenchRefund,
  CashierWorkbenchView,
} from '../shared/cashier-workbench-contracts'
import { CashierAfterSalesWorkbenchView } from './CashierAfterSalesWorkbench'
import { CashierMutationCoordinator, createIdempotencyKey, mutationSignature } from './cashier-mutation'

const employeeId = '33333333-3333-4333-8333-333333333333'
const otherEmployeeId = '44444444-4444-4444-8444-444444444444'

describe('CashierAfterSalesWorkbenchView', () => {
  it('shows original items, remaining capacity and separates requester from approver', () => {
    const html = render(workbench([
      payment('postar', [
        refund('refund-own', 'requested', employeeId),
        refund('refund-other', 'requested', otherEmployeeId),
      ]),
    ]))

    expect(html).toContain('原订单商品')
    expect(html).toContain('精酿啤酒')
    expect(html).toContain('剩余可退 ¥68.00')
    expect(html).toContain('发起人不能复核自己的退款')
    expect(html).toContain('复核说明')
    expect(html).toContain('复核驳回')
    expect(html).toContain('复核通过')
  })

  it('never renders a manual success action for an online refund in processing', () => {
    const html = render(workbench([
      payment('postar', [refund('refund-online', 'processing', otherEmployeeId)]),
    ]))

    expect(html).toContain('待支付渠道回传结果')
    expect(html).toContain('本页不能把线上退款手工改成成功')
    expect(html).not.toContain('登记已退')
    expect(html).not.toContain('退款凭证号')
  })

  it('keeps prior-day unresolved refunds visibly separated from current turnover', () => {
    const view = workbench([payment('postar', [refund('refund-carryover', 'requested', otherEmployeeId)])])
    view.summary.carryoverOrderCount = 1
    view.orders[0]!.businessDate = '2026-08-12'
    view.orders[0]!.carryover = true
    const html = render(view)

    expect(html).toContain('交班遗留')
    expect(html).toContain('2026-08-12遗留')
    expect(html).toContain('不会并入今日营业额')
  })

  it('offers a controlled unpaid-order cancellation without pretending delivered facts disappear', () => {
    const view = workbench([])
    view.orders[0]!.paymentStatus = 'unpaid'
    view.orders[0]!.businessDate = '2026-08-12'
    view.orders[0]!.carryover = true
    const html = render(view, ['reconciliation.view', 'order.cancel_unpaid'])

    expect(html).toContain('处理未付款订单')
    expect(html).toContain('前一营业日尚未闭环的收款或退款事项')
    expect(html).toContain('不能申请退款')
  })

  it('keeps unpaid cancellation reachable after a failed payment attempt', () => {
    const failedPayment = payment('postar', [])
    failedPayment.status = 'failed'
    failedPayment.succeededAt = null
    const view = workbench([failedPayment])
    view.orders[0]!.paymentStatus = 'unpaid'
    const html = render(view, ['reconciliation.view', 'order.cancel_unpaid'])

    expect(html).toContain('处理未付款订单')
    expect(html).toContain('支付失败')
  })

  it('requires a separate receipt surface for cash and physical POS manual results', () => {
    const cashHtml = render(workbench([
      payment('cash', [refund('refund-cash', 'processing', otherEmployeeId)]),
    ]))
    const posHtml = render(workbench([
      payment('physical_pos', [refund('refund-pos', 'processing', otherEmployeeId)]),
    ]))

    expect(cashHtml).toContain('现金退款凭证号')
    expect(cashHtml).toContain('必须与原收款凭证分开')
    expect(cashHtml).toContain('登记已退')
    expect(posHtml).toContain('POS退款小票/交易号')
    expect(posHtml).toContain('登记已退')
  })

  it('binds refund retry identity to the exact action and payload', () => {
    const body = { reason: '商品未出品', allocations: [{ orderItemId: 'item-1', amountMinor: 1_000 }] }
    expect(mutationSignature('refund-request-payment-1', body)).toBe(mutationSignature('refund-request-payment-1', structuredClone(body)))
    expect(mutationSignature('refund-request-payment-1', body)).not.toBe(mutationSignature('refund-request-payment-1', { ...body, reason: '重复点单' }))
    expect(createIdempotencyKey('refund-request-payment-1')).toMatch(/^cashier:refund-request-payment-1:/)
  })

  it('reuses the exact key and body after an uncertain failure', () => {
    const coordinator = new CashierMutationCoordinator()
    const firstBody = { succeeded: true, receiptReference: 'POS-1001', occurredAt: '2026-08-13T12:00:00.000Z' }
    const first = coordinator.prepare('refund-manual-success-refund-1', firstBody)
    coordinator.fail(first.signature, true)

    const retry = coordinator.prepare('refund-manual-success-refund-1', {
      ...firstBody,
      occurredAt: '2026-08-13T12:00:10.000Z',
    })
    expect(retry.idempotencyKey).toBe(first.idempotencyKey)
    expect(retry.body).toEqual(firstBody)

    coordinator.complete(retry.signature)
    const nextOperation = coordinator.prepare('refund-manual-success-refund-1', {
      ...firstBody,
      occurredAt: '2026-08-13T12:00:20.000Z',
    })
    expect(nextOperation.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('does not reuse an idempotency key after a definite rejection', () => {
    const coordinator = new CashierMutationCoordinator()
    const body = { reason: '金额不符' }
    const first = coordinator.prepare('refund-reject-refund-1', body)
    coordinator.fail(first.signature, false)
    const retry = coordinator.prepare('refund-reject-refund-1', body)
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey)
  })
})

function render(view: CashierWorkbenchView, permissions = auth().permissions): string {
  return renderToStaticMarkup(createElement(CashierAfterSalesWorkbenchView, {
    auth: { ...auth(), permissions },
    view,
    phase: 'ready',
    message: null,
    busyKey: null,
    notice: null,
    initialExpandedOrderId: 'order-1',
    onSearch: vi.fn(),
    onReload: vi.fn(),
    onMutation: vi.fn(async () => true),
  }))
}

function auth(): StaffAuthView {
  return {
    session: {
      id: 'session-1',
      employeeId,
      issuedAt: '2026-08-13T12:00:00.000Z',
      expiresAt: '2026-08-13T18:00:00.000Z',
      onlineLeaseUntil: '2026-08-13T12:02:00.000Z',
      isOnline: true,
    },
    employee: { id: employeeId, code: 'liyan', displayName: '李艳', roleCodes: ['store_manager'] },
    permissions: ['reconciliation.view', 'refund.request', 'refund.approve', 'refund.execute'],
    deniedPermissions: [],
  }
}

function workbench(payments: CashierWorkbenchPayment[]): CashierWorkbenchView {
  return {
    businessDate: '2026-08-13',
    query: 'VIP1',
    actions: {
      canRequestRefund: true,
      canApproveRefund: true,
      canExecuteRefund: true,
      canViewReconciliation: true,
    },
    summary: {
      orderCount: 1,
      capturedPaymentCount: payments.length,
      requestedRefundCount: payments.flatMap((entry) => entry.refunds).filter((entry) => entry.status === 'requested').length,
      processingRefundCount: payments.flatMap((entry) => entry.refunds).filter((entry) => entry.status === 'processing').length,
    },
    orders: [{
      id: 'order-1',
      publicId: 'ORDER-VIP1-0001',
      tableCode: 'VIP1',
      channel: 'staff_assisted',
      status: 'submitted',
      paymentStatus: 'paid',
      totalAmountMinor: 6_800,
      currency: 'CNY',
      submittedAt: '2026-08-13T12:00:00.000Z',
      createdAt: '2026-08-13T11:59:00.000Z',
      items: [{ id: 'item-1', productName: '精酿啤酒', quantity: 1, totalAmountMinor: 6_800, status: 'delivered' }],
      payments,
    }],
  }
}

function payment(
  provider: CashierWorkbenchPayment['provider'],
  refunds: CashierWorkbenchRefund[],
): CashierWorkbenchPayment {
  return {
    id: `payment-${provider}`,
    publicId: `PAYMENT-${provider}`,
    provider,
    method: provider === 'cash' ? 'cash' : provider === 'physical_pos' ? 'card' : 'native_qr',
    providerTransactionId: `TX-${provider}`,
    amountMinor: 6_800,
    currency: 'CNY',
    status: 'succeeded',
    succeededAt: '2026-08-13T12:02:00.000Z',
    createdAt: '2026-08-13T12:01:00.000Z',
    reservedRefundAmountMinor: 0,
    remainingRefundableMinor: 6_800,
    refundableItems: [{
      id: 'item-1',
      productName: '精酿啤酒',
      quantity: 1,
      totalAmountMinor: 6_800,
      status: 'delivered',
      reservedRefundAmountMinor: 0,
      remainingRefundableMinor: 6_800,
    }],
    refunds,
  }
}

function refund(
  id: string,
  status: CashierWorkbenchRefund['status'],
  requestedByEmployeeId: string,
): CashierWorkbenchRefund {
  return {
    id,
    publicId: id.toUpperCase(),
    paymentId: 'payment-1',
    providerRefundId: null,
    amountMinor: 1_000,
    currency: 'CNY',
    status,
    reason: '商品未出品',
    requestedByEmployeeId,
    requestedByEmployeeName: requestedByEmployeeId === employeeId ? '李艳' : 'Tom',
    approvedByEmployeeId: status === 'processing' ? employeeId : null,
    approvedByEmployeeName: status === 'processing' ? '李艳' : null,
    decisionReason: status === 'processing' ? '核对无误' : null,
    receiptReference: null,
    completedAt: null,
    createdAt: '2026-08-13T12:05:00.000Z',
    allocations: [{ orderItemId: 'item-1', amountMinor: 1_000 }],
  }
}
