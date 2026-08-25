import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StaffAuthView } from '../normalized-api'
import type {
  CashierWorkbenchPayment,
  CashierWorkbenchRefund,
  CashierWorkbenchView,
} from '../shared/cashier-workbench-contracts'
import { businessDayFactNavigation, CashierAfterSalesWorkbenchView } from './CashierAfterSalesWorkbench'
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
    expect(html).toContain('查询退款渠道结果')
    expect(html).toContain('不会再次提交退款')
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

  it('shows a controlled KDS disposition only after a linked refund has succeeded and the task has not started', () => {
    const view = workbench([payment('postar', [refund('refund-kds', 'succeeded', otherEmployeeId)])])
    view.orders[0]!.kdsTasks = [{
      id: 'kds-1', orderItemId: 'item-1', stationCode: 'bar', status: 'accepted', quantity: 1,
      succeededRefundAmountMinor: 6_800,
    }]
    const allowed = render(view, ['reconciliation.view', 'kds.exception.manage'])
    const deniedView = { ...view, actions: { ...view.actions, canManageKdsException: false } }
    const denied = render(deniedView, ['reconciliation.view'])

    expect(allowed).toContain('关联出品')
    expect(allowed).toContain('退款成功不等于自动取消制作')
    expect(allowed).toContain('核对退款后处理出品')
    expect(denied).toContain('没有“处理出品异常”权限')
    expect(denied).not.toContain('核对退款后处理出品')
  })

  it('does not offer cancellation for a refund that is not provider-confirmed or a task already in production', () => {
    const view = workbench([payment('postar', [refund('refund-kds', 'processing', otherEmployeeId)])])
    view.orders[0]!.kdsTasks = [{
      id: 'kds-1', orderItemId: 'item-1', stationCode: 'bar', status: 'preparing', quantity: 1,
      succeededRefundAmountMinor: 0,
    }]
    const html = render(view, ['reconciliation.view', 'kds.exception.manage'])

    expect(html).toContain('请先在上方「收款与退款」完成退款')
    expect(html).not.toContain('核对退款后处理出品')
  })

  it('tells cashier-only staff to have a manager request the refund first', () => {
    const view = workbench([payment('postar', [])])
    view.orders[0]!.paymentStatus = 'paid'
    view.actions.canRequestRefund = false
    view.actions.canApproveRefund = true
    view.actions.canExecuteRefund = true
    const html = render(view, ['reconciliation.view', 'refund.approve', 'refund.execute'])

    expect(html).toContain('本岗位不能直接发起退款')
    expect(html).toContain('请店长或服务员登录后在本页发起')
    expect(html).not.toContain('选择原商品发起退款')
    expect(html).not.toContain('不能从这里终止任务')
  })

  it('guides request-capable staff to start refunds before KDS cancellation', () => {
    const view = workbench([payment('postar', [])])
    view.orders[0]!.paymentStatus = 'paid'
    view.orders[0]!.kdsTasks = [{
      id: 'kds-1', orderItemId: 'item-1', stationCode: 'bar', status: 'pending', quantity: 1,
      succeededRefundAmountMinor: 0,
    }]
    const html = render(view, ['reconciliation.view', 'refund.request'])

    expect(html).toContain('请先在下方「收款与退款」点击「选择原商品发起退款」')
    expect(html).not.toContain('不能从这里终止任务')
  })

  it('offers a no-repeat provider query for an older payment still awaiting a channel result', () => {
    const view = workbench([payment('postar', [])])
    view.orders[0]!.businessDate = '2026-08-12'
    view.orders[0]!.carryover = true
    view.orders[0]!.payments[0]!.status = 'pending'
    view.orders[0]!.payments[0]!.providerActionState = 'ready'
    view.summary.carryoverPendingPaymentCount = 1
    const html = render(view)

    expect(html).toContain('待查渠道')
    expect(html).toContain('查询渠道结果')
    expect(html).toContain('不会再次扣款')
  })

  it('allows direct cash for an ordinary unpaid order and an unpresented online record', () => {
    const direct = workbench([])
    direct.orders[0]!.paymentStatus = 'unpaid'
    direct.orders[0]!.outstandingAmountMinor = 6_800
    const directHtml = render(direct)
    expect(directHtml).toContain('登记现金收款')
    expect(directHtml).toContain('出示付款二维码')
    expect(directHtml).toContain('扫顾客付款码')
    expect(directHtml).not.toContain('入口已锁定')

    const unpresented = payment('postar', [])
    unpresented.status = 'pending'
    unpresented.succeededAt = null
    unpresented.providerTransactionId = null
    unpresented.providerActionState = null
    const view = workbench([unpresented])
    view.orders[0]!.paymentStatus = 'unpaid'
    view.orders[0]!.outstandingAmountMinor = 6_800
    const html = render(view)
    expect(html).toContain('尚未向支付渠道发起')
    expect(html).toContain('登记现金收款')
  })

  it('locks cash only after the provider action started or its result became unknown', () => {
    const pending = payment('postar', [])
    pending.status = 'pending'
    pending.succeededAt = null
    pending.providerActionState = 'ready'
    const view = workbench([pending])
    view.orders[0]!.paymentStatus = 'unpaid'
    view.orders[0]!.outstandingAmountMinor = 6_800
    const html = render(view)
    expect(html).toContain('已经向渠道发起')
    expect(html).toContain('入口已锁定')
    expect(html).toContain('查询渠道结果')
    expect(html).not.toContain('登记现金收款</button>')
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

  it('separates delivered unpaid exception settlement from ordinary cancellation', () => {
    const view = workbench([])
    view.orders[0]!.status = 'cancelled'
    view.orders[0]!.paymentStatus = 'unpaid'
    view.orders[0]!.settlementException = null
    const allowed = render(view, ['reconciliation.view', 'order.settle_exception'])
    const denied = render(view, ['reconciliation.view'])

    expect(allowed).toContain('异常结清已送达金额')
    expect(allowed).not.toContain('处理未付款订单')
    expect(denied).not.toContain('异常结清已送达金额')
  })

  it('shows a completed exception as an audit fact rather than a payment', () => {
    const view = workbench([])
    view.orders[0]!.status = 'cancelled'
    view.orders[0]!.paymentStatus = 'unpaid'
    view.orders[0]!.settlementException = {
      reasonCode: 'manager_comp', settledAmountMinor: 6_800, occurredAt: '2026-08-13T13:00:00.000Z',
    }
    const html = render(view, ['reconciliation.view', 'order.settle_exception'])

    expect(html).toContain('已异常结清 ¥68.00；未生成付款。')
    expect(html).not.toContain('异常结清已送达金额')
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

  it('shows the controlled prior-day closure action only to authorized staff',()=>{
    const allowed=renderToStaticMarkup(createElement(CashierAfterSalesWorkbenchView,{
      auth:{...auth(),permissions:['reconciliation.view','business_day.close']},
      view:workbench([]),phase:'ready' as const,message:null,busyKey:null,notice:null,
      onSearch:vi.fn(),onReload:vi.fn(),onMutation:vi.fn(async()=>true),
      onClosePendingBusinessDays:vi.fn(async()=>undefined),
      onNavigate:vi.fn(),
      businessDayClosure:{businessDays:[{businessDayId:'day-1',businessDate:'2026-08-12',
        status:'awaiting_close' as const,closedTableSessions:[],blockers:[{
          tableSessionId:'table-session-1',tableCode:'VIP1',code:'PAYMENT_PENDING',count:2,
          label:'仍有待确认付款',resolution:'请先确认付款终态',
          target:{route:'/staff/payments' as const,focus:'payments' as const,
            tableSessionId:'table-session-1',tableCode:'VIP1',query:'VIP1'},
          facts:[{type:'payment' as const,id:'payment-1',reference:'PAYMENT-VIP1-0001',
            title:'付款结果待确认',status:'pending',statusLabel:'待处理',amountMinor:6800,
            quantityText:null,orderId:'order-1',orderPublicId:'ORDER-VIP1-0001',
            employeeRelationLabel:'收款发起人',relatedEmployeeName:'李艳',
            actionRoute:'/staff/payments?tableSessionId=table-session-1'}],
        }]}],closedBusinessDayCount:0,closedTableSessionCount:0,blockedTableSessionCount:1},
    }))
    const denied=render(workbench([]),['reconciliation.view'])
    expect(allowed).toContain('检查并结束')
    expect(allowed).toContain('VIP1')
    expect(allowed).toContain('请先确认付款终态')
    expect(allowed).toContain('aria-label="查看VIP1仍有待确认付款2项明细"')
    expect(allowed).toContain('付款结果待确认')
    expect(allowed).toContain('PAYMENT-VIP1-0001')
    expect(allowed).toContain('收款发起人')
    expect(allowed).toContain('李艳')
    expect(allowed).toContain('¥68.00')
    expect(allowed).toContain('打开收银与退款核对')
    expect(denied).not.toContain('检查并结束')
  })

  it('keeps exact blocker facts visible but does not pretend close-only staff can operate another module',()=>{
    const html=renderToStaticMarkup(createElement(CashierAfterSalesWorkbenchView,{
      auth:{...auth(),permissions:['business_day.close']},view:workbench([]),phase:'ready' as const,
      message:null,busyKey:null,notice:null,onSearch:vi.fn(),onReload:vi.fn(),
      onMutation:vi.fn(async()=>true),onNavigate:vi.fn(),
      businessDayClosure:{businessDays:[{businessDayId:'day-2',businessDate:'2026-08-12',
        status:'awaiting_close' as const,closedTableSessions:[],blockers:[{
          tableSessionId:'table-session-2',tableCode:'L01',code:'INVENTORY_RESERVED' as const,count:1,
          label:'库存预留',resolution:'请先释放库存预留',
          target:{route:'/staff/payments' as const,focus:'inventory' as const,
            tableSessionId:'table-session-2',tableCode:'L01',query:'L01'},
          facts:[{type:'inventory_reservation' as const,id:'inventory-hold-1',reference:'ORDER-L01-0001',
            title:'金酒库存',status:'reserved',statusLabel:'已预留',amountMinor:null,quantityText:'50 ml',
            orderId:'order-2',orderPublicId:'ORDER-L01-0001',employeeRelationLabel:'处理分派',
            relatedEmployeeName:null,actionRoute:'/staff/inventory?factId=inventory-hold-1'}],
        }]}],closedBusinessDayCount:0,closedTableSessionCount:0,blockedTableSessionCount:1},
    }))
    expect(html).toContain('金酒库存')
    expect(html).toContain('50 ml')
    expect(html).toContain('处理分派')
    expect(html).toContain('待分派')
    expect(html).toContain('请交给具备“库存与酒水上架”入口权限的同事继续处理')
    expect(html).not.toContain('打开库存核对')
  })

  it('opens a cashier blocker by exact order instead of table code or a same-route no-op',()=>{
    expect(businessDayFactNavigation({
      type:'payment',id:'payment-1',reference:'PAYMENT-VIP1-0001',title:'付款结果待确认',
      status:'pending',statusLabel:'待处理',amountMinor:6800,quantityText:null,
      orderId:'order-exact-1',orderPublicId:'ORDER-EXACT-0001',employeeRelationLabel:'收款发起人',
      relatedEmployeeName:'李艳',actionRoute:'/staff/payments?tableSessionId=old-session&factId=payment-1',
    })).toEqual({kind:'cashier_order',orderId:'order-exact-1',query:'ORDER-EXACT-0001'})
  })

  it('carries the exact non-cashier blocker fact into the target module',()=>{
    const fact={
      type:'inventory_reservation' as const,id:'inventory-hold-1',reference:'ORDER-L01-0001',
      title:'金酒库存',status:'reserved',statusLabel:'已预留',amountMinor:null,quantityText:'50 ml',
      orderId:'order-2',orderPublicId:'ORDER-L01-0001',employeeRelationLabel:'处理分派',
      relatedEmployeeName:null,actionRoute:'/staff/inventory?factId=inventory-hold-1',
    }
    expect(businessDayFactNavigation(fact)).toEqual({
      kind:'route',route:fact.actionRoute,context:{businessDayBlockerFact:fact},
    })
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
    onCreateOnlinePayment: vi.fn(async () => null),
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
      canInitiateOnlinePayment: true,
      canQueryOnlinePayment: true,
      onlinePaymentProvider: 'postar',
      canRecordManualCash: true,
      canRecordManualPos: true,
      canRecordManualExternal: true,
      canRequestRefund: true,
      canApproveRefund: true,
      canExecuteRefund: true,
      canViewReconciliation: true,
      canManageKdsException: true,
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
      outstandingAmountMinor: 0,
      currency: 'CNY',
      submittedAt: '2026-08-13T12:00:00.000Z',
      createdAt: '2026-08-13T11:59:00.000Z',
      items: [{ id: 'item-1', productName: '精酿啤酒', quantity: 1, totalAmountMinor: 6_800, status: 'delivered' }],
      kdsTasks: [],
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
    method: provider === 'cash' ? 'cash' : provider === 'physical_pos' ? 'card' : provider === 'external_manual' ? 'manual' : 'native_qr',
    providerTransactionId: `TX-${provider}`,
    providerActionState: provider === 'postar' || provider === 'wechat' ? 'consumed' : null,
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
    providerSubmissionState: status === 'processing' ? 'submitted' : 'not_started',
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
