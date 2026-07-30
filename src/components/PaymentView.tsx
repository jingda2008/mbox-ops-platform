import {
  Banknote,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  CreditCard,
  FileCheck2,
  Landmark,
  LoaderCircle,
  ScanLine,
  ReceiptText,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Send,
  Smartphone,
  WalletCards,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as coreApi from '../api'
import * as paymentApi from '../payment-api'
import type { PaymentAllocationInput } from '../shared/payment-api'
import type { BootstrapResponse } from '../shared/contracts'
import { effectivePermissionIdsForEmployee, effectiveRoleIdsForEmployee } from '../shared/staff-access'
import { formatChinaDateTime } from '../shared/china-time'
import {
  CASH_PAYMENT_CHANNEL,
  PHYSICAL_POS_CHANNEL,
  SETTLEMENT_CHANNELS,
  type PaymentDomainState,
  type PaymentIntent,
  type PaymentIntentStatus,
  type PaymentSettlementView,
  type Refund,
  type RefundStatus,
  type SettlementChannel,
} from '../shared/payment-contracts'
import type { Order, OrderItem } from '../shared/order-contracts'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import { CustomerPaymentCodeScanner } from './CustomerPaymentCodeScanner'
import type { OperationsConsoleNavigationRequest } from './OperationsConsole'
import './PaymentView.css'

interface PaymentViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  focusRequest?: OperationsConsoleNavigationRequest | null
}

type BootstrapWithPayments = BootstrapResponse & { paymentDomain?: PaymentDomainState }
type Notice = { tone: 'success' | 'error'; message: string }
type RefundDraft = { paymentIntentId: string; orderId: string; orderItemId: string; quantity: number; reason: string }
type CollectionDraft = {
  mode: PaymentAllocationInput['mode']
  amountYuan: string
  quantities: Record<string, number>
}
type IssueDraft = { reason: string; nextDayOwnerId: string }
type TableAccount = ReturnType<typeof buildTableAccounts>[number]

const ONLINE_SIMULATION_CHANNEL = 'wechat_mock'
const emptyPaymentDomain: PaymentDomainState = {
  paymentIntents: [],
  paymentNotifications: [],
  paymentStatusQueries: [],
  physicalPosReports: [],
  cashPaymentConfirmations: [],
  refunds: [],
  cashierHandovers: [],
  idempotencyRecords: [],
}

const settlementChannelLabels: Record<SettlementChannel, string> = {
  cash: '现金',
  physical_pos: '物理POS',
  wechat: '微信',
  alipay: '支付宝',
  unionpay: '云闪付',
}

const intentStatusLabels: Record<PaymentIntentStatus, string> = {
  pending: '待收款',
  processing: '支付处理中',
  succeeded: '已确认到账',
  failed: '支付失败',
  closed: '已关闭',
  reported_pending_reconciliation: 'POS已报送·待对账',
}

const refundStatusLabels: Record<RefundStatus, string> = {
  requested: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  processing: '退款处理中',
  succeeded: '退款完成',
  failed: '退款失败',
}

export function PaymentView({ data, onRefresh, focusRequest = null }: PaymentViewProps) {
  const paymentDomain = (data as BootstrapWithPayments).paymentDomain ?? emptyPaymentDomain
  const currentActorId = coreApi.getCurrentActorId()
  const currentEmployee = data.employees.find((employee) => employee.id === currentActorId && employee.status === 'active')
  const permissionIds = new Set(data.viewer?.permissionIds ?? [])
  const canLoadSettlement = permissionIds.has('finance.view')
    || permissionIds.has('finance.manage')
    || permissionIds.has('payment.collect')
  const canCollectPayments = permissionIds.has('payment.collect')
  const canReportPayments = permissionIds.has('payment.pos_report')
  const canRequestRefund = permissionIds.has('payment.refund.request')
  const canApproveRefund = permissionIds.has('payment.refund.approve')
  const paymentSimulationEnabled = data.runtimeCapabilities?.paymentSimulation === true || import.meta.env.DEV
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [posIntentId, setPosIntentId] = useState('')
  const [terminalId, setTerminalId] = useState('POS-01')
  const [terminalTransactionId, setTerminalTransactionId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('银行卡')
  const [receiptReference, setReceiptReference] = useState('')
  const [refundDraft, setRefundDraft] = useState<RefundDraft | null>(null)
  const [refundCompletion, setRefundCompletion] = useState({ refundId: '', terminalRefundTransactionId: '', reason: '' })
  const [collectionDrafts, setCollectionDrafts] = useState<Record<string, CollectionDraft>>({})
  const [scannerAccount, setScannerAccount] = useState<TableAccount | null>(null)
  const [activeWorkspace, setActiveWorkspace] = useState<'collection' | 'tracking' | 'refunds' | 'handover'>('collection')
  const [showAllAccounts, setShowAllAccounts] = useState(false)
  const [settlement, setSettlement] = useState<PaymentSettlementView | null>(null)
  const [settlementBusinessDate, setSettlementBusinessDate] = useState(data.store.businessDate)
  const [actualAmounts, setActualAmounts] = useState<Record<SettlementChannel, string>>({
    cash: '0.00', physical_pos: '0.00', wechat: '0.00', alipay: '0.00', unionpay: '0.00',
  })
  const [issueDrafts, setIssueDrafts] = useState<Record<SettlementChannel, IssueDraft>>({
    cash: { reason: '', nextDayOwnerId: '' },
    physical_pos: { reason: '', nextDayOwnerId: '' },
    wechat: { reason: '', nextDayOwnerId: '' },
    alipay: { reason: '', nextDayOwnerId: '' },
    unionpay: { reason: '', nextDayOwnerId: '' },
  })
  const [handoverNote, setHandoverNote] = useState('')
  const [reviewNote, setReviewNote] = useState('')

  const tableAccounts = useMemo(
    () => buildTableAccounts(data, paymentDomain.paymentIntents, paymentDomain.refunds),
    [data, paymentDomain.paymentIntents, paymentDomain.refunds],
  )
  const preferredExpandedAccountId = preferredTableAccountId(tableAccounts)
  const actionableAccounts = tableAccounts.filter((account) => account.collectableAmount > 0 || account.reservedAmount > 0 || account.orders.length > 0)
  const visibleTableAccounts = showAllAccounts ? tableAccounts : actionableAccounts
  const [expandedAccountId, setExpandedAccountId] = useState(preferredExpandedAccountId)
  const [accountRevealTick, setAccountRevealTick] = useState(0)
  const handledFocusRequestId = useRef<number | null>(null)
  const accountPanelRef = useRevealPanelScroll<HTMLDivElement>(accountRevealTick)
  const refundDraftRef = useRevealPanelScroll<HTMLFormElement>(refundDraft?.paymentIntentId ?? '')
  const refundCompletionRef = useRevealPanelScroll<HTMLFormElement>(refundCompletion.refundId)
  const physicalPosIntents = paymentDomain.paymentIntents.filter(
    (intent) => intent.channel === PHYSICAL_POS_CHANNEL && intent.status === 'pending',
  )
  const effectivePosIntentId = physicalPosIntents.some((intent) => intent.id === posIntentId)
    ? posIntentId
    : (physicalPosIntents[0]?.id ?? '')
  const pendingRefunds = paymentDomain.refunds.filter((refund) => refund.status === 'requested')
  const confirmedGross = paymentDomain.paymentIntents
    .filter((intent) => intent.status === 'succeeded')
    .reduce((sum, intent) => sum + intent.amount, 0)
  const confirmedRefunds = paymentDomain.refunds
    .filter((refund) => refund.status === 'succeeded' && paymentDomain.paymentIntents.some((intent) => intent.id === refund.paymentIntentId && intent.status === 'succeeded'))
    .reduce((sum, refund) => sum + refund.amount, 0)
  const confirmedTotal = confirmedGross - confirmedRefunds
  const reconciliationTotal = paymentDomain.paymentIntents
    .filter((intent) => intent.status === 'reported_pending_reconciliation')
    .reduce((sum, intent) => sum + intent.amount, 0)
  const openReceivable = tableAccounts.reduce((sum, account) => sum + account.collectableAmount, 0)
  const settlementShift = data.shiftAssignments.find((shift) => (
    shift.employeeId === currentActorId
    && shift.businessDate === settlementBusinessDate
    && (settlementBusinessDate === data.store.businessDate ? shift.status === 'active' : shift.status !== 'cancelled')
  ))
  const settlementRoleIds = settlementShift ? [settlementShift.roleId, ...(settlementShift.roleIds ?? [])] : []
  const isCashier = settlementRoleIds.includes('cashier')
  const managementRoleIds = ['manager', 'operations_director', 'owner']
  const isManager = managementRoleIds.some((roleId) => settlementRoleIds.includes(roleId))
    || managementRoleIds.includes(currentEmployee?.roleId ?? '')

  useEffect(() => {
    setExpandedAccountId((current) => (
      tableAccounts.some((account) => account.tableSessionId === current)
        ? current
        : preferredExpandedAccountId
    ))
  }, [preferredExpandedAccountId, tableAccounts])

  useEffect(() => {
    if (!focusRequest || handledFocusRequestId.current === focusRequest.id) return
    handledFocusRequestId.current = focusRequest.id
    if (focusRequest.focus?.query !== 'table-account' || !focusRequest.focus.tableCode) return
    const account = tableAccounts.find((candidate) => (
      candidate.tableCode.toLocaleLowerCase('zh-CN') === focusRequest.focus?.tableCode?.toLocaleLowerCase('zh-CN')
    ))
    if (!account) {
      setNotice({ tone: 'error', message: `${focusRequest.focus.tableCode}当前没有可查看的开放桌账` })
      return
    }
    setActiveWorkspace('collection')
    setShowAllAccounts(true)
    setExpandedAccountId(account.tableSessionId)
    setAccountRevealTick((value) => value + 1)
  }, [focusRequest, tableAccounts])

  const loadSettlement = useCallback(async () => {
    const result = await paymentApi.getPaymentSettlement(settlementBusinessDate)
    setSettlement(result)
    setActualAmounts(Object.fromEntries(result.channels.map((item) => [
      item.channel,
      (item.confirmedActualAmount / 100).toFixed(2),
    ])) as Record<SettlementChannel, string>)
    if (result.latestHandover) {
      setHandoverNote(result.latestHandover.note ?? '')
      setIssueDrafts((current) => {
        const next = { ...current }
        for (const issue of result.latestHandover?.issues ?? []) {
          next[issue.channel] = { reason: issue.reason, nextDayOwnerId: issue.nextDayOwnerId }
        }
        return next
      })
    }
  }, [settlementBusinessDate])

  useEffect(() => {
    setSettlementBusinessDate(data.store.businessDate)
  }, [data.store.businessDate])

  useEffect(() => {
    if (!canLoadSettlement) {
      setSettlement(null)
      return
    }
    void loadSettlement().catch((error) => {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '营业日结算数据加载失败' })
    })
  }, [canLoadSettlement, data.revision, loadSettlement])

  async function execute(actionKey: string, successMessage: string, operation: () => Promise<unknown>, reloadSettlement = true) {
    if (!currentEmployee) {
      setNotice({ tone: 'error', message: '当前员工身份无效，请重新登录后进行收银操作' })
      return
    }
    setBusyAction(actionKey)
    setNotice(null)
    try {
      await operation()
      await onRefresh()
      if (reloadSettlement && canLoadSettlement) await loadSettlement()
      setNotice({ tone: 'success', message: successMessage })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '收银操作失败，请重试' })
    } finally {
      setBusyAction('')
    }
  }

  function createIntent(
    tableSessionId: string,
    channel: paymentApi.PaymentCollectionChannel,
    allocation: PaymentAllocationInput,
    providerPayment?: paymentApi.ProviderPaymentMethod,
  ) {
    const channelLabel = channel === PHYSICAL_POS_CHANNEL
      ? '物理POS收款单'
      : channel === CASH_PAYMENT_CHANNEL ? '现金收款单' : channel === 'postar' ? '星驿支付码' : '线上联调支付意图'
    void execute(`create:${tableSessionId}:${channel}`, `${channelLabel}已创建`, () =>
      paymentApi.createTablePaymentIntent(tableSessionId, channel, allocation, providerPayment),
    )
  }

  function simulateSuccess(intent: PaymentIntent) {
    void execute(`simulate:${intent.id}`, '联调模拟回调已完成，不代表真实资金入账', () =>
      paymentApi.simulatePaymentSuccess(intent.id),
    )
  }

  function confirmCash(intent: PaymentIntent) {
    void execute(`cash:${intent.id}`, '现金实收已由当前收银确认', () => paymentApi.confirmCashPayment(intent.id))
  }

  function queryProvider(intent: PaymentIntent) {
    void execute(`provider-query:${intent.id}`, '已使用渠道查单结果更新支付状态', () => paymentApi.queryProviderPayment(intent.id))
  }

  function submitPhysicalPos(event: FormEvent) {
    event.preventDefault()
    if (!effectivePosIntentId || !terminalTransactionId.trim()) {
      setNotice({ tone: 'error', message: '请选择支付意图并填写POS交易流水号' })
      return
    }
    void execute(`pos:${effectivePosIntentId}`, 'POS收款已人工报送，当前状态为待对账', async () => {
      await paymentApi.reportPhysicalPos(
        effectivePosIntentId,
        terminalId.trim(),
        terminalTransactionId.trim(),
        paymentMethod,
        receiptReference.trim(),
      )
      setTerminalTransactionId('')
      setReceiptReference('')
    })
  }

  function submitRefund(event: FormEvent) {
    event.preventDefault()
    if (!refundDraft || !refundDraft.reason.trim()) {
      setNotice({ tone: 'error', message: '请填写退款原因' })
      return
    }
    const draft = refundDraft
    void execute(`refund-request:${draft.orderItemId}`, '商品退款申请已提交审批', async () => {
      await paymentApi.requestItemRefund(
        draft.paymentIntentId,
        draft.orderId,
        draft.orderItemId,
        draft.quantity,
        draft.reason.trim(),
      )
      setRefundDraft(null)
    })
  }

  function approveRefund(refund: Refund) {
    void execute(`refund-approve:${refund.id}`, '退款已审批并完成联调处理', () =>
      paymentApi.approveAndCompleteRefund(refund.id),
    )
  }

  function closeTable(tableId: string, tableCode: string) {
    if (!window.confirm(`确认${tableCode}所有商品已送达、服务已完成且款项已核实？`)) return
    void execute(`close:${tableId}`, `${tableCode}已结台，可以接待下一桌客人`, () =>
      coreApi.closeTableSession(tableId, '收银核对完成并结台'),
    )
  }

  function completePhysicalRefund(event: FormEvent, refund: Refund) {
    event.preventDefault()
    if (!refundCompletion.terminalRefundTransactionId.trim() || !refundCompletion.reason.trim()) {
      setNotice({ tone: 'error', message: '请填写POS退款流水号和审批说明' })
      return
    }
    void execute(`refund-pos-complete:${refund.id}`, '物理POS退款已审批并登记完成', async () => {
      await paymentApi.completePhysicalPosRefund(
        refund.id,
        refundCompletion.terminalRefundTransactionId.trim(),
        refundCompletion.reason.trim(),
      )
      setRefundCompletion({ refundId: '', terminalRefundTransactionId: '', reason: '' })
    })
  }

  function createFromDraft(
    account: TableAccount,
    channel: paymentApi.PaymentCollectionChannel,
    providerPayment?: paymentApi.ProviderPaymentMethod,
  ) {
    const draft = collectionDrafts[account.tableSessionId] ?? emptyCollectionDraft()
    let allocation: PaymentAllocationInput
    if (draft.mode === 'amount') {
      const amount = yuanInputToCents(draft.amountYuan)
      if (!amount || amount > account.collectableAmount) {
        setNotice({ tone: 'error', message: '指定收款金额必须大于0且不能超过剩余应收' })
        return false
      }
      allocation = { mode: 'amount', amount }
    } else if (draft.mode === 'items') {
      const items = account.remainingLines.flatMap((line) => {
        const quantity = draft.quantities[lineKey(line.orderId, line.orderItemId)] ?? 0
        return quantity > 0 ? [{ orderId: line.orderId, orderItemId: line.orderItemId, quantity }] : []
      })
      if (items.length === 0) {
        setNotice({ tone: 'error', message: '请至少选择一个商品和收款数量' })
        return false
      }
      allocation = { mode: 'items', items }
    } else {
      allocation = { mode: 'all' }
    }
    createIntent(
      account.tableSessionId,
      channel,
      allocation,
      channel === 'postar' ? (providerPayment ?? { presentation: 'qr' }) : undefined,
    )
    return true
  }

  function updateCollectionDraft(tableSessionId: string, update: Partial<CollectionDraft>) {
    setCollectionDrafts((current) => ({
      ...current,
      [tableSessionId]: { ...(current[tableSessionId] ?? emptyCollectionDraft()), ...update },
    }))
  }

  function updateLineQuantity(tableSessionId: string, key: string, quantity: number) {
    const current = collectionDrafts[tableSessionId] ?? emptyCollectionDraft()
    updateCollectionDraft(tableSessionId, { quantities: { ...current.quantities, [key]: quantity } })
  }

  function submitHandover(event: FormEvent) {
    event.preventDefault()
    if (!settlement) return
    const confirmedActualAmounts = Object.fromEntries(SETTLEMENT_CHANNELS.map((channel) => [
      channel,
      yuanInputToCents(actualAmounts[channel]),
    ])) as Record<SettlementChannel, number | null>
    if (SETTLEMENT_CHANNELS.some((channel) => confirmedActualAmounts[channel] === null)) {
      setNotice({ tone: 'error', message: '确认实收必须填写不小于0的金额，最多两位小数' })
      return
    }
    const issues = SETTLEMENT_CHANNELS.flatMap((channel) => {
      const summary = settlement.channels.find((item) => item.channel === channel)!
      const difference = confirmedActualAmounts[channel]! - summary.systemReceivableAmount
      if (summary.pendingReconciliationAmount === 0 && difference === 0) return []
      const draft = issueDrafts[channel]
      if (!draft.reason.trim() || !draft.nextDayOwnerId) return [{ channel, reason: '', nextDayOwnerId: '' }]
      return [{ channel, reason: draft.reason.trim(), nextDayOwnerId: draft.nextDayOwnerId }]
    })
    if (issues.some((issue) => !issue.reason || !issue.nextDayOwnerId)) {
      setNotice({ tone: 'error', message: '每个待对账或有差异的渠道都必须填写原因和次日责任人' })
      return
    }
    void execute('handover-submit', '收银交班已提交，等待经理使用独立员工会话复核', () =>
      paymentApi.submitCashierHandover(settlementBusinessDate, {
        confirmedActualAmounts: confirmedActualAmounts as Record<SettlementChannel, number>,
        issues,
        note: handoverNote.trim() || undefined,
        deviceId: 'cashier-web',
      }),
    )
  }

  function reviewHandover(decision: 'approve' | 'reject') {
    const handover = settlement?.latestHandover
    if (!handover) return
    if (decision === 'reject' && reviewNote.trim().length < 2) {
      setNotice({ tone: 'error', message: '驳回交班时必须填写复核说明' })
      return
    }
    const historical = settlementBusinessDate < data.store.businessDate
    void execute(`handover-review:${decision}`, decision === 'approve'
      ? historical ? '历史营业日已复核并完成财务关账' : '交班已复核通过，系统将在北京时间06:00自动切换营业日'
      : '交班已驳回，需收银重新提交', () =>
      paymentApi.reviewCashierHandover(settlementBusinessDate, handover.id, {
        decision,
        note: reviewNote.trim() || undefined,
      }),
    )
  }

  return (
    <section className="payment-view">
      <header className="payment-heading">
        <div>
          <span className="eyebrow">桌账、支付、退款与对账</span>
          <h2>收银工作台</h2>
        </div>
        <div>
          <span className="payment-mode"><ShieldCheck size={15} />当前操作：{currentEmployee?.displayName ?? '身份失效，请重新登录'}</span>
          <span className="payment-mode"><CircleAlert size={15} />正式聚合支付缺凭据时不可用</span>
        </div>
      </header>

      {notice && (
        <div className={`payment-notice is-${notice.tone}`} role="status">
          {notice.tone === 'success' ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
          <span>{notice.message}</span>
        </div>
      )}

      <section className="payment-metrics" aria-label="收银概览">
        <Metric icon={WalletCards} value={money(openReceivable)} label="当前可收桌账" />
        <Metric icon={CheckCircle2} value={money(confirmedTotal)} label="系统净确认到账" />
        <Metric icon={Clock3} value={money(reconciliationTotal)} label="POS待对账" />
        <Metric icon={RotateCcw} value={String(pendingRefunds.length)} label="待审批退款" />
      </section>

      <nav className="payment-workspace-tabs" aria-label="收银工作分类">
        {([
          ['collection', '收款', tableAccounts.filter((account) => account.collectableAmount > 0).length],
          ['tracking', '支付追踪', paymentDomain.paymentIntents.length],
          ['refunds', '退款', pendingRefunds.length],
          ['handover', '交班关账', settlement?.latestHandover ? 1 : 0],
        ] as const).map(([id, label, count]) => (
          <button key={id} type="button" className={activeWorkspace === id ? 'is-active' : ''} aria-pressed={activeWorkspace === id} onClick={() => setActiveWorkspace(id)}>
            {label}<span>{count}</span>
          </button>
        ))}
      </nav>

      {activeWorkspace === 'collection' && <section className="cashier-section table-account-section">
        <SectionTitle icon={ReceiptText} eyebrow="按桌次归集" title="待收桌账与结台" meta={`${actionableAccounts.length}个待处理`} />
        <div className="table-account-filter">
          <span>{showAllAccounts ? `显示全部 ${tableAccounts.length} 个营业桌次` : '仅显示有订单、待收款或支付中的桌次'}</span>
          <button className="secondary-button" type="button" onClick={() => setShowAllAccounts((value) => !value)}>
            {showAllAccounts ? '只看待处理' : `查看全部桌次 (${tableAccounts.length})`}
          </button>
        </div>
        <div className="table-account-list">
          {visibleTableAccounts.length === 0 && <EmptyState icon={FileCheck2} text="当前没有待收款桌账" />}
          {visibleTableAccounts.map((account) => {
            const isExpanded = expandedAccountId === account.tableSessionId
            const detailsId = `table-account-details-${account.tableSessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
            return <article className={isExpanded ? 'table-account-row is-expanded' : 'table-account-row'} key={account.tableSessionId}>
              <div className="table-account-summary">
                <div className="table-account-identity">
                  <span>{account.tableCode}</span>
                  <strong>{account.tableName}</strong>
                  <small>{account.orders.length}笔订单 · 桌次 {shortId(account.tableSessionId)}</small>
                </div>
                <div className="table-account-amounts">
                  <span>桌账应收<strong>{money(account.totalAmount)}</strong></span>
                  <span>支付处理中<strong>{money(account.reservedAmount)}</strong></span>
                  <span className="is-due">本次可收<strong>{money(account.collectableAmount)}</strong></span>
                </div>
                <button
                  className="secondary-button table-account-toggle"
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={detailsId}
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedAccountId('')
                      return
                    }
                    setExpandedAccountId(account.tableSessionId)
                    setAccountRevealTick((value) => value + 1)
                  }}
                >
                  {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  {isExpanded ? '收起桌账' : account.collectableAmount > 0 ? '办理收款' : '查看桌账'}
                </button>
              </div>
              {isExpanded && <div className="table-account-details reveal-panel-target" id={detailsId} ref={accountPanelRef}>
                <div className="table-account-orders">
                  {account.orders.map((order) => (
                    <div className={`order-summary${order.fulfillmentNote ? ' has-fulfillment-note' : ''}`} key={order.id}>
                      <span>订单 {shortId(order.id)}</span>
                      <strong>{order.items.map((item) => `${item.name}×${item.quantity}`).join('、')}</strong>
                      <b>{money(order.amounts.payableAmount)}</b>
                      {order.fulfillmentNote && <em>重点备注：{order.fulfillmentNote}</em>}
                    </div>
                  ))}
                </div>
                <CollectionControls
                  account={account}
                  draft={collectionDrafts[account.tableSessionId] ?? emptyCollectionDraft()}
                  disabled={Boolean(busyAction)}
                  onMode={(mode) => updateCollectionDraft(account.tableSessionId, { mode })}
                  onAmount={(amountYuan) => updateCollectionDraft(account.tableSessionId, { amountYuan })}
                  onQuantity={(key, quantity) => updateLineQuantity(account.tableSessionId, key, quantity)}
                />
                <div className="table-account-actions">
                {!canCollectPayments && (
                  <span className="payment-permission-note">当前账号可查看桌账，但不能创建收款单；请交给当班收银或店长处理。</span>
                )}
                {canCollectPayments && (
                <button
                  className="primary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => createFromDraft(account, CASH_PAYMENT_CHANNEL)}
                >
                  <Banknote size={16} />生成现金收款单
                </button>
                )}
                {canCollectPayments && paymentSimulationEnabled && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                    onClick={() => createFromDraft(account, ONLINE_SIMULATION_CHANNEL)}
                  >
                    {busyAction === `create:${account.tableSessionId}:${ONLINE_SIMULATION_CHANNEL}` ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
                    生成线上联调单
                  </button>
                )}
                {canCollectPayments && <button
                  className="primary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => createFromDraft(account, 'postar', { presentation: 'qr' })}
                >
                  {busyAction === `create:${account.tableSessionId}:postar` ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
                  生成客扫支付码
                </button>}
                {canCollectPayments && <button
                  className="primary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => setScannerAccount(account)}
                >
                  <ScanLine size={16} />扫客户付款码
                </button>}
                {canCollectPayments && <button
                  className="secondary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => createFromDraft(account, PHYSICAL_POS_CHANNEL)}
                >
                  <CreditCard size={16} />生成POS收款单
                </button>}
                {account.canClose && account.tableId && (
                  <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => closeTable(account.tableId!, account.tableCode)}>
                    {busyAction === `close:${account.tableId}` ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}结台
                  </button>
                )}
                </div>
              </div>}
            </article>
          })}
        </div>
      </section>}

      {(activeWorkspace === 'collection' || activeWorkspace === 'tracking') && <div className="payment-work-grid is-single">
        {activeWorkspace === 'tracking' && <section className="cashier-section intent-section">
          <SectionTitle icon={Landmark} eyebrow="逐笔追踪商品分摊" title="支付意图" meta={`${paymentDomain.paymentIntents.length}笔`} />
          <div className="payment-intent-list">
            {paymentDomain.paymentIntents.length === 0 && <EmptyState icon={ReceiptText} text="尚未创建支付意图" />}
            {paymentDomain.paymentIntents.toReversed().map((intent) => (
              <PaymentIntentRow
                key={intent.id}
                data={data}
                intent={intent}
                refunds={paymentDomain.refunds}
                paymentSimulationEnabled={paymentSimulationEnabled}
                canReportPayments={canReportPayments}
                canRequestRefund={canRequestRefund}
                busyAction={busyAction}
                onSimulate={simulateSuccess}
                onConfirmCash={confirmCash}
                onQueryProvider={queryProvider}
                onRefund={(draft) => {
                  setRefundDraft(draft)
                  setActiveWorkspace('refunds')
                }}
              />
            ))}
          </div>
        </section>}

        {activeWorkspace === 'collection' && <section className="cashier-section pos-section">
          <SectionTitle icon={CreditCard} eyebrow="外部终端收款" title="物理POS人工报送" meta={`${physicalPosIntents.length}笔待报送`} />
          <div className="pos-guidance">
            <CircleAlert size={17} />
            <p>仅在物理POS已显示交易成功后报送。报送后进入“待对账”，不能代替银行或收单机构的正式对账结果。</p>
          </div>
          <form className="pos-report-form" onSubmit={submitPhysicalPos}>
            <Field label="POS收款单">
              <select value={effectivePosIntentId} onChange={(event) => setPosIntentId(event.target.value)} disabled={physicalPosIntents.length === 0}>
                {physicalPosIntents.length === 0 && <option value="">暂无待报送收款单</option>}
                {physicalPosIntents.map((intent) => <option key={intent.id} value={intent.id}>{shortId(intent.id)} · {money(intent.amount)}</option>)}
              </select>
            </Field>
            <div className="form-pair">
              <Field label="终端编号"><input required value={terminalId} onChange={(event) => setTerminalId(event.target.value)} /></Field>
              <Field label="支付方式">
                <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                  <option>银行卡</option><option>微信</option><option>支付宝</option><option>现金</option><option>其他</option>
                </select>
              </Field>
            </div>
            <Field label="POS交易流水号"><input required value={terminalTransactionId} onChange={(event) => setTerminalTransactionId(event.target.value)} placeholder="以POS小票为准" /></Field>
            <Field label="小票/凭证编号（选填）"><input value={receiptReference} onChange={(event) => setReceiptReference(event.target.value)} placeholder="便于交班与对账追溯" /></Field>
            <button className="primary-button" type="submit" disabled={!effectivePosIntentId || Boolean(busyAction)}>
              {busyAction.startsWith('pos:') ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}
              确认人工报送
            </button>
          </form>
        </section>}
      </div>}

      {activeWorkspace === 'handover' && <section className="cashier-section settlement-section">
        <SectionTitle
          icon={CalendarCheck}
          eyebrow="收银提交 · 经理独立复核"
          title="交班与营业日关账"
          meta={settlement?.latestHandover ? handoverStatusLabel(settlement.latestHandover.status) : '未提交'}
        />
        <div className="settlement-date-selector">
          <Field label="结算营业日">
            <input type="date" max={data.store.businessDate} value={settlementBusinessDate} onChange={(event) => setSettlementBusinessDate(event.target.value)} />
          </Field>
          <span>营业日按北京时间06:00自动切换；可选择历史营业日补交和复核。</span>
        </div>
        {!settlement && <EmptyState icon={LoaderCircle} text="正在读取营业日结算数据" />}
        {settlement && (
          <form className="settlement-form" onSubmit={submitHandover}>
            <div className="settlement-channel-table">
              <div className="settlement-channel-head">
                <span>渠道</span><span>系统应收</span><span>确认实收</span><span>待对账</span><span>差异</span>
              </div>
              {settlement.channels.map((summary) => {
                const difference = settlementDifference(summary.systemReceivableAmount, actualAmounts[summary.channel])
                const unresolved = summary.pendingReconciliationAmount > 0 || difference !== 0
                const issue = issueDrafts[summary.channel]
                const locked = Boolean(settlement.latestHandover && settlement.latestHandover.status !== 'rejected')
                return (
                  <div className={`settlement-channel-row${unresolved ? ' has-difference' : ''}`} key={summary.channel}>
                    <strong>{settlementChannelLabels[summary.channel]}</strong>
                    <span>{money(summary.systemReceivableAmount)}</span>
                    <label>
                      <span className="sr-only">{settlementChannelLabels[summary.channel]}确认实收</span>
                      <input
                        inputMode="decimal"
                        value={actualAmounts[summary.channel]}
                        disabled={locked}
                        onChange={(event) => setActualAmounts({ ...actualAmounts, [summary.channel]: event.target.value })}
                      />
                    </label>
                    <span className={summary.pendingReconciliationAmount > 0 ? 'is-pending' : ''}>{money(summary.pendingReconciliationAmount)}</span>
                    <b className={difference === 0 ? 'is-balanced' : 'is-difference'}>{signedMoney(difference)}</b>
                    {unresolved && (
                      <div className="settlement-issue-fields">
                        <label><span>未对账原因</span><input required disabled={locked} value={issue.reason} onChange={(event) => setIssueDrafts({ ...issueDrafts, [summary.channel]: { ...issue, reason: event.target.value } })} /></label>
                        <label><span>次日责任人</span><select required disabled={locked} value={issue.nextDayOwnerId} onChange={(event) => setIssueDrafts({ ...issueDrafts, [summary.channel]: { ...issue, nextDayOwnerId: event.target.value } })}>
                          <option value="">请选择</option>
                          {data.employees.filter((employee) => employee.status === 'active').map((employee) => <option value={employee.id} key={employee.id}>{employee.displayName}</option>)}
                        </select></label>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <Field label="交班备注（选填）">
              <input value={handoverNote} disabled={Boolean(settlement.latestHandover && settlement.latestHandover.status !== 'rejected')} onChange={(event) => setHandoverNote(event.target.value)} />
            </Field>
            {isCashier && (!settlement.latestHandover || settlement.latestHandover.status === 'rejected') && (
              <button className="primary-button" type="submit" disabled={Boolean(busyAction)}>
                {busyAction === 'handover-submit' ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                提交收银交班
              </button>
            )}
            {!isCashier && !settlement.latestHandover && <p className="settlement-role-note">等待当班收银提交交班数据。</p>}
          </form>
        )}

        {settlement?.latestHandover?.status === 'submitted' && (
          <div className="handover-review-panel">
            <div>
              <strong>提交人 {employeeName(data, settlement.latestHandover.submittedBy)}</strong>
              <span>{formatTime(settlement.latestHandover.submittedAt)} · {settlement.latestHandover.issues.length}项转次日跟进</span>
            </div>
            {isManager && settlement.latestHandover.submittedBy !== currentActorId ? (
              <>
                <Field label="经理复核说明"><input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></Field>
                <div className="handover-review-actions">
                  <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => reviewHandover('reject')}>驳回重提</button>
                  <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => reviewHandover('approve')}><ShieldCheck size={16} />复核通过</button>
                </div>
              </>
            ) : <span className="settlement-role-note">必须由另一名有营业日关账权限的经理登录复核。</span>}
          </div>
        )}

        {settlement?.latestHandover?.status === 'approved' && (
          <div className="business-day-close-form">
            <div><CheckCircle2 size={18} /><span>经理 {employeeName(data, settlement.latestHandover.reviewedBy ?? '')} 已复核。系统将在北京时间06:00自动关账并切换营业日，无需手工操作；未对账项仍保留原因和责任人。</span></div>
          </div>
        )}
      </section>}

      {activeWorkspace === 'refunds' && <section className="cashier-section refund-section">
        <SectionTitle icon={RefreshCcw} eyebrow="按原支付商品追溯" title="商品退款与审批" meta={`${pendingRefunds.length}笔待审批`} />
        {refundDraft && (
          <form className="refund-request-form reveal-panel-target" ref={refundDraftRef} onSubmit={submitRefund}>
            <div>
              <span>申请退款</span>
              <strong>{refundItemLabel(data, refundDraft.orderId, refundDraft.orderItemId)}</strong>
              <small>原支付 {shortId(refundDraft.paymentIntentId)}</small>
            </div>
            <label><span>数量</span><input type="number" min={1} value={refundDraft.quantity} onChange={(event) => setRefundDraft({ ...refundDraft, quantity: Math.max(1, Number(event.target.value)) })} /></label>
            <label><span>退款原因</span><input required value={refundDraft.reason} onChange={(event) => setRefundDraft({ ...refundDraft, reason: event.target.value })} placeholder="必填，进入审计记录" /></label>
            <button className="primary-button" type="submit" disabled={Boolean(busyAction)}><RotateCcw size={16} />提交审批</button>
            <button className="icon-button" title="取消退款申请" type="button" onClick={() => setRefundDraft(null)}>×</button>
          </form>
        )}
        <div className="refund-list">
          {paymentDomain.refunds.length === 0 && !refundDraft && <EmptyState icon={ShieldCheck} text="暂无退款申请；请从已确认到账的商品明细发起" />}
          {paymentDomain.refunds.toReversed().map((refund) => {
            const refundIntent = paymentDomain.paymentIntents.find((intent) => intent.id === refund.paymentIntentId)
            const isPhysicalPosRefund = refundIntent?.channel === PHYSICAL_POS_CHANNEL
            const isSimulationRefund = refundIntent?.channel === ONLINE_SIMULATION_CHANNEL
            const isProviderRefund = refundIntent?.channel === 'postar'
            const requesterName = employeeName(data, refund.requestedBy)
            const isRequester = refund.requestedBy === currentActorId
            const canCurrentActorApprove = canApproveRefund && !isRequester
            const approverNames = eligibleRefundApproverNames(data, refund.requestedBy, refund.amount)
            return <article className="refund-row" key={refund.id}>
              <div className="refund-status">
                <span className={`payment-status status-${refund.status}`}>{refundStatusLabels[refund.status]}</span>
                <small>{formatTime(refund.requestedAt)}</small>
              </div>
              <div className="refund-details">
                <strong>{refund.items.map((item) => `${refundItemLabel(data, item.orderId, item.orderItemId)}×${item.quantity}`).join('、')}</strong>
                <span>{refund.reason} · 申请人 {requesterName}</span>
              </div>
              <b>{money(refund.amount)}</b>
              {refund.status === 'requested' && isSimulationRefund && paymentSimulationEnabled && canCurrentActorApprove && (
                <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => approveRefund(refund)}>
                  {busyAction === `refund-approve:${refund.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  审批并完成
                </button>
              )}
              {refund.status === 'requested' && isPhysicalPosRefund && canCurrentActorApprove && refundCompletion.refundId !== refund.id && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => setRefundCompletion({ refundId: refund.id, terminalRefundTransactionId: '', reason: '' })}
                >
                  <ShieldCheck size={16} />登记POS退款
                </button>
              )}
              {refund.status === 'requested' && isPhysicalPosRefund && canCurrentActorApprove && refundCompletion.refundId === refund.id && (
                <form className="refund-request-form reveal-panel-target" ref={refundCompletionRef} onSubmit={(event) => completePhysicalRefund(event, refund)}>
                  <label><span>POS退款流水号</span><input required value={refundCompletion.terminalRefundTransactionId} onChange={(event) => setRefundCompletion({ ...refundCompletion, terminalRefundTransactionId: event.target.value })} /></label>
                  <label><span>审批说明</span><input required value={refundCompletion.reason} onChange={(event) => setRefundCompletion({ ...refundCompletion, reason: event.target.value })} /></label>
                  <button className="primary-button" type="submit" disabled={Boolean(busyAction)}><FileCheck2 size={16} />确认退款完成</button>
                  <button className="icon-button" title="取消登记" type="button" onClick={() => setRefundCompletion({ refundId: '', terminalRefundTransactionId: '', reason: '' })}>×</button>
                </form>
              )}
              {refund.status === 'requested' && isProviderRefund && canCurrentActorApprove && (
                <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => {
                  void execute(`refund-provider:${refund.id}`, '退款已审批并提交原支付渠道', () =>
                    paymentApi.submitProviderRefund(refund.id, '审批通过，按原支付渠道退款'),
                  )
                }}>
                  {busyAction === `refund-provider:${refund.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  审批并原路退回
                </button>
              )}
              {refund.status === 'requested' && !canCurrentActorApprove && (
                <span className="refund-approval-note">
                  {isRequester
                    ? `你是申请人，不能审批自己的退款。请由另一名授权人员处理${approverNames ? `：${approverNames}` : ''}。`
                    : `当前账号没有退款审批权限。请由授权人员处理${approverNames ? `：${approverNames}` : ''}。`}
                </span>
              )}
            </article>
          })}
        </div>
      </section>}
      {scannerAccount && (
        <CustomerPaymentCodeScanner
          tableCode={scannerAccount.tableCode}
          amountLabel={money(selectedCollectionAmount(scannerAccount, collectionDrafts[scannerAccount.tableSessionId] ?? emptyCollectionDraft()))}
          onClose={() => setScannerAccount(null)}
          onConfirm={(customerAuthCode) => {
            if (createFromDraft(scannerAccount, 'postar', { presentation: 'barcode', customerAuthCode })) {
              setScannerAccount(null)
            }
          }}
        />
      )}
    </section>
  )
}

function CollectionControls({ account, draft, disabled, onMode, onAmount, onQuantity }: {
  account: ReturnType<typeof buildTableAccounts>[number]
  draft: CollectionDraft
  disabled: boolean
  onMode: (mode: PaymentAllocationInput['mode']) => void
  onAmount: (amountYuan: string) => void
  onQuantity: (key: string, quantity: number) => void
}) {
  return (
    <div className="collection-composer">
      <div className="collection-mode" role="group" aria-label="收款拆分方式">
        {([
          ['items', '按商品/数量'],
          ['amount', '指定金额'],
          ['all', '全部剩余'],
        ] as const).map(([mode, label]) => (
          <button className={draft.mode === mode ? 'is-active' : ''} type="button" disabled={disabled} onClick={() => onMode(mode)} key={mode}>{label}</button>
        ))}
      </div>
      {draft.mode === 'items' && (
        <div className="collection-line-selector">
          {account.remainingLines.map((line) => (
            <label key={lineKey(line.orderId, line.orderItemId)}>
              <span><strong>{line.name}</strong><small>{money(line.unitPaidAmount)} · 剩余 {money(line.remainingAmount)}</small></span>
              <input
                type="number"
                min={0}
                max={line.remainingQuantity}
                disabled={disabled || line.remainingQuantity === 0}
                value={draft.quantities[lineKey(line.orderId, line.orderItemId)] ?? 0}
                onChange={(event) => onQuantity(lineKey(line.orderId, line.orderItemId), Math.min(line.remainingQuantity, Math.max(0, Number(event.target.value) || 0)))}
              />
            </label>
          ))}
          {account.remainingLines.every((line) => line.remainingQuantity === 0) && <span className="collection-partial-note">剩余应收不足一个完整商品单位，请使用指定金额收款。</span>}
        </div>
      )}
      {draft.mode === 'amount' && (
        <Field label={`本次收款金额（剩余 ${money(account.collectableAmount)}）`}>
          <input inputMode="decimal" value={draft.amountYuan} disabled={disabled} onChange={(event) => onAmount(event.target.value)} placeholder="0.00" />
        </Field>
      )}
      {draft.mode === 'all' && <span className="collection-partial-note">本次将分配当前桌次全部剩余应收 {money(account.collectableAmount)}。</span>}
    </div>
  )
}

function PaymentIntentRow({ data, intent, refunds, paymentSimulationEnabled, canReportPayments, canRequestRefund, busyAction, onSimulate, onConfirmCash, onQueryProvider, onRefund }: {
  data: BootstrapResponse
  intent: PaymentIntent
  refunds: Refund[]
  paymentSimulationEnabled: boolean
  canReportPayments: boolean
  canRequestRefund: boolean
  busyAction: string
  onSimulate: (intent: PaymentIntent) => void
  onConfirmCash: (intent: PaymentIntent) => void
  onQueryProvider: (intent: PaymentIntent) => void
  onRefund: (draft: RefundDraft) => void
}) {
  const table = tableFromSession(data, intent.tableSessionId)
  const isSimulation = intent.channel === ONLINE_SIMULATION_CHANNEL
  const canRefund = ['succeeded', 'reported_pending_reconciliation'].includes(intent.status)
  return (
    <article className="payment-intent-row">
      <div className="intent-overview">
        <span className={`payment-status status-${intent.status}`}>{intentStatusLabels[intent.status]}</span>
        <div><strong>{table?.code ?? shortId(intent.tableSessionId)} · {money(intent.amount)}</strong><small>{isSimulation ? '微信支付联调模拟器' : intent.channel === PHYSICAL_POS_CHANNEL ? '物理POS' : intent.channel === CASH_PAYMENT_CHANNEL ? '现金' : intent.channel === 'postar' ? '星驿正式聚合支付' : intent.channel}</small></div>
        <time>{formatTime(intent.createdAt)}</time>
      </div>
      <div className="intent-lines">
        {intent.lineAllocations.map((line) => {
          const item = findOrderItem(data, line.orderId, line.orderItemId)
          const usedRefundQuantity = refunds
            .filter((refund) => (
              refund.paymentIntentId === intent.id
              && !['rejected', 'failed'].includes(refund.status)
            ))
            .flatMap((refund) => refund.items)
            .filter((refundItem) => refundItem.orderId === line.orderId && refundItem.orderItemId === line.orderItemId)
            .reduce((sum, refundItem) => sum + refundItem.quantity, 0)
          const refundableQuantity = Math.max(0, line.quantity - usedRefundQuantity)
          return (
            <div className="intent-line" key={`${intent.id}:${line.orderItemId}`}>
              <span><strong>{item?.name ?? line.orderItemId}</strong><small>{item?.specification || `订单 ${shortId(line.orderId)}`}</small></span>
              <span>{line.quantity}份 × {money(line.unitPaidAmount)}</span>
              <b>{money(line.paidAmount)}</b>
              {canRefund && canRequestRefund && (
                <button className="secondary-button" type="button" disabled={refundableQuantity === 0} onClick={() => onRefund({ paymentIntentId: intent.id, orderId: line.orderId, orderItemId: line.orderItemId, quantity: 1, reason: '' })}>
                  <RotateCcw size={14} />{refundableQuantity === 0 ? '退款处理中' : '按商品退款'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {paymentSimulationEnabled && canReportPayments && isSimulation && intent.status === 'pending' && (
        <div className="simulation-action">
          <div><CircleAlert size={16} /><span><strong>仅供接口联调</strong>此操作生成模拟成功回调，不发生真实扣款或资金结算。</span></div>
          <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => onSimulate(intent)}>
            {busyAction === `simulate:${intent.id}` ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
            模拟支付成功
          </button>
        </div>
      )}
      {canReportPayments && intent.channel === CASH_PAYMENT_CHANNEL && intent.status === 'pending' && (
        <div className="simulation-action cash-confirmation-action">
          <div><Banknote size={16} /><span><strong>现金人工确认</strong>仅在现金已经清点并收妥后确认实收。</span></div>
          <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => onConfirmCash(intent)}>
            {busyAction === `cash:${intent.id}` ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}
            确认现金实收
          </button>
        </div>
      )}
      {canReportPayments && intent.channel === 'postar' && ['pending', 'processing'].includes(intent.status) && (
        <div className="simulation-action provider-query-action">
          {paymentQrCodeUrl(intent) && <ProviderQrCode value={paymentQrCodeUrl(intent)!} amount={intent.amount} />}
          <div><ShieldCheck size={16} /><span><strong>正式渠道订单</strong>让客人使用微信、支付宝或云闪付扫码；仅验签回调或主动查单可以确认到账。</span></div>
          <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => onQueryProvider(intent)}>
            {busyAction === `provider-query:${intent.id}` ? <LoaderCircle className="spin" size={16} /> : <RefreshCcw size={16} />}
            主动查单
          </button>
        </div>
      )}
    </article>
  )
}

function paymentQrCodeUrl(intent: PaymentIntent) {
  const value = intent.providerPaymentPayload?.qrCodeUrl
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

function ProviderQrCode({ value, amount }: { value: string; amount: number }) {
  const [imageUrl, setImageUrl] = useState('')
  useEffect(() => {
    let active = true
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(value, { width: 240, margin: 1, errorCorrectionLevel: 'M' }))
      .then((result) => { if (active) setImageUrl(result) })
    return () => { active = false }
  }, [value])
  return (
    <div className="provider-qr-code">
      {imageUrl ? <img src={imageUrl} alt={`星驿支付二维码，金额${money(amount)}`} /> : <LoaderCircle className="spin" size={26} />}
      <span><strong>{money(amount)}</strong><small>请客人扫码支付</small></span>
    </div>
  )
}

function Metric({ icon: Icon, value, label }: { icon: typeof Banknote; value: string; label: string }) {
  return <div><Icon size={20} /><strong>{value}</strong><span>{label}</span></div>
}

function SectionTitle({ icon: Icon, eyebrow, title, meta }: { icon: typeof Banknote; eyebrow: string; title: string; meta: string }) {
  return <header className="cashier-section-title"><Icon size={19} /><div><span>{eyebrow}</span><h3>{title}</h3></div><b>{meta}</b></header>
}

function EmptyState({ icon: Icon, text }: { icon: typeof Banknote; text: string }) {
  return <div className="payment-empty"><Icon size={23} /><span>{text}</span></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="payment-field"><span>{label}</span>{children}</label>
}

function buildTableAccounts(data: BootstrapResponse, intents: PaymentIntent[], refunds: Refund[]) {
  const ordersBySession = new Map<string, Order[]>()
  for (const session of data.songState.tableSessions) {
    const table = data.tables.find((item) => item.id === session.tableId)
    if (session.status === 'open' && table?.status === 'occupied') ordersBySession.set(session.id, [])
  }
  for (const order of data.orderDomain.orders) {
    if (order.status === 'draft' || order.status === 'authorization_pending') continue
    const orders = ordersBySession.get(order.tableSessionId) ?? []
    orders.push(order)
    ordersBySession.set(order.tableSessionId, orders)
  }
  const activeIntents = intents.filter((intent) => !['failed', 'closed'].includes(intent.status))
  const allocatedByLine = new Map<string, number>()
  for (const intent of activeIntents) {
    for (const line of intent.lineAllocations) {
      const key = lineKey(line.orderId, line.orderItemId)
      allocatedByLine.set(key, (allocatedByLine.get(key) ?? 0) + line.paidAmount)
    }
  }
  return Array.from(ordersBySession, ([tableSessionId, orders]) => {
    const table = tableFromSession(data, tableSessionId)
    const completedRefundAmount = refunds
      .filter((refund) => refund.tableSessionId === tableSessionId && refund.status === 'succeeded')
      .reduce((sum, refund) => sum + refund.amount, 0)
    const totalAmount = Math.max(0, orders.reduce((sum, order) => sum + order.amounts.payableAmount, 0) - completedRefundAmount)
    const allocatedAmount = activeIntents
      .filter((intent) => intent.tableSessionId === tableSessionId)
      .reduce((sum, intent) => sum + intent.amount, 0)
    const reservedAmount = activeIntents
      .filter((intent) => intent.tableSessionId === tableSessionId && intent.status !== 'succeeded')
      .reduce((sum, intent) => sum + intent.amount, 0)
    const confirmedAllocatedAmount = activeIntents
      .filter((intent) => ['succeeded', 'reported_pending_reconciliation'].includes(intent.status))
      .reduce((sum, intent) => sum + intent.amount, 0)
    const remainingLines = orders.flatMap((order) => order.items.flatMap((item) => {
      const remainingAmount = Math.max(0, item.quantity * item.unitSalePriceAmount - (allocatedByLine.get(lineKey(order.id, item.id)) ?? 0))
      if (remainingAmount === 0) return []
      return [{
        orderId: order.id,
        orderItemId: item.id,
        name: item.name,
        specification: item.specification,
        unitPaidAmount: item.unitSalePriceAmount,
        remainingAmount,
        remainingQuantity: Math.floor(remainingAmount / item.unitSalePriceAmount),
      }]
    }))
    return {
      tableSessionId,
      tableId: table?.id ?? null,
      tableCode: table?.code ?? '未知桌台',
      tableName: table?.displayName ?? '未匹配桌台',
      orders,
      remainingLines,
      totalAmount,
      reservedAmount,
      collectableAmount: Math.max(0, totalAmount - allocatedAmount),
      canClose: confirmedAllocatedAmount >= totalAmount,
    }
  })
}

// oxlint-disable-next-line react/only-export-components
export function tableFromSession(data: BootstrapResponse, tableSessionId: string) {
  const currentTableId = data.songState.tableSessions.find((session) => session.id === tableSessionId)?.tableId
  return data.tables.find((table) => table.id === currentTableId)
}

// oxlint-disable-next-line react/only-export-components
export function preferredTableAccountId(accounts: Array<{ tableSessionId: string; collectableAmount: number }>) {
  return accounts.find((account) => account.collectableAmount > 0)?.tableSessionId ?? ''
}

function findOrderItem(data: BootstrapResponse, orderId: string, orderItemId: string): OrderItem | undefined {
  return data.orderDomain.orders.find((order) => order.id === orderId)?.items.find((item) => item.id === orderItemId)
}

function refundItemLabel(data: BootstrapResponse, orderId: string, orderItemId: string) {
  return findOrderItem(data, orderId, orderItemId)?.name ?? `商品 ${shortId(orderItemId)}`
}

function emptyCollectionDraft(): CollectionDraft {
  return { mode: 'items', amountYuan: '', quantities: {} }
}

function selectedCollectionAmount(account: TableAccount, draft: CollectionDraft) {
  if (draft.mode === 'all') return account.collectableAmount
  if (draft.mode === 'amount') return yuanInputToCents(draft.amountYuan) ?? 0
  return account.remainingLines.reduce((sum, line) => (
    sum + (draft.quantities[lineKey(line.orderId, line.orderItemId)] ?? 0) * line.unitPaidAmount
  ), 0)
}

function lineKey(orderId: string, orderItemId: string) {
  return `${orderId}\u0000${orderItemId}`
}

function yuanInputToCents(value: string) {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const amount = Math.round(Number(normalized) * 100)
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null
}

function settlementDifference(systemAmount: number, actualAmount: string) {
  return (yuanInputToCents(actualAmount) ?? 0) - systemAmount
}

function signedMoney(amount: number) {
  if (amount === 0) return money(0)
  return `${amount > 0 ? '+' : '-'}${money(Math.abs(amount))}`
}

function handoverStatusLabel(status: NonNullable<PaymentSettlementView['latestHandover']>['status']) {
  return { submitted: '待经理复核', approved: '已复核·等待06:00自动切日', rejected: '已驳回', closed: '已关账' }[status]
}

function employeeName(data: BootstrapResponse, employeeId: string) {
  return data.employees.find((employee) => employee.id === employeeId)?.displayName ?? employeeId
}

function eligibleRefundApproverNames(data: BootstrapResponse, requesterId: string, amount: number) {
  return data.employees
    .filter((employee) => (
      employee.status === 'active'
      && employee.id !== requesterId
      && effectivePermissionIdsForEmployee(data, employee.id).includes('payment.refund.approve')
      && Math.max(0, ...effectiveRoleIdsForEmployee(data, employee.id).map((roleId) => (
        data.config.roles.find((role) => role.id === roleId)?.approvalLimits?.refundApproveAmount ?? 0
      ))) >= amount
    ))
    .map((employee) => employee.displayName)
    .slice(0, 4)
    .join('、')
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function formatTime(value: string) {
  return formatChinaDateTime(value, { year: undefined, second: undefined })
}
