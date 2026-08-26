import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import {
  Check,
  ChevronRight,
  ChevronDown,
  CircleAlert,
  Clock3,
  LoaderCircle,
  ReceiptText,
  RefreshCcw,
  QrCode,
  ScanLine,
  Search,
  Send,
  X,
} from 'lucide-react'
import type {
  CashierWorkbenchPayment,
  CashierWorkbenchActivityRegistration,
  CashierWorkbenchOrder,
  CashierWorkbenchRefund,
  CashierWorkbenchKdsTask,
  CashierWorkbenchView,
} from '../shared/cashier-workbench-contracts'
import type { OnlinePaymentAction } from '../shared/online-payment-contracts'
import type {
  BusinessDayBlockerFact,
  BusinessDayClosureResult,
  BusinessDayNavigationContext,
} from '../shared/business-day-closure-contracts'
import { staffModuleForRoute } from '../shared/staff-module-access'
import { CustomerPaymentCodeScanner } from '../components/CustomerPaymentCodeScanner'
import { NormalizedApiClient, NormalizedApiError, type StaffAuthView } from '../normalized-api'
import { CashierMutationCoordinator } from './cashier-mutation'
import './cashier-after-sales-workbench.css'

interface WorkbenchNotice {
  kind: 'success' | 'error'
  text: string
}

interface RefundDraft {
  paymentId: string
  reason: string
  amounts: Record<string, string>
}

interface CancellationDraft {
  orderId: string
  reasonCode: 'duplicate_order' | 'guest_left' | 'test_cleanup' | 'other'
  reasonNote: string
  confirmed: boolean
}

interface SettlementExceptionDraft {
  orderId: string
  reasonCode: 'manager_comp' | 'uncollectible' | 'test_cleanup'
  reasonNote: string
  confirmed: boolean
}

interface KdsCancellationDraft {
  taskId: string
  reasonNote: string
  confirmed: boolean
}

interface CashierOnlinePaymentInput {
  orderId: string
  provider: 'postar' | 'simulation'
  method: 'native_qr' | 'auth_code'
  customerAuthCode?: string
}

export function CashierAfterSalesWorkbench({ api, auth, onLoginRequired, onNavigate, refreshToken }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  onLoginRequired(): void
  onNavigate?(route: string, context?: BusinessDayNavigationContext): void
  refreshToken: number
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [view, setView] = useState<CashierWorkbenchView | null>(null)
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<WorkbenchNotice | null>(null)
  const [businessDayClosure, setBusinessDayClosure] = useState<BusinessDayClosureResult | null>(null)
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const mutationCoordinator = useRef(new CashierMutationCoordinator())

  const load = useCallback(async (searchQuery: string) => {
    setPhase('loading')
    setMessage(null)
    try {
      const search = new URLSearchParams({ limit: '50' })
      if (searchQuery.trim()) search.set('query', searchQuery.trim())
      const response = await api.getEndpoint<{ data: CashierWorkbenchView }>(
        `/api/payments/workbench?${search.toString()}`,
      )
      setView(response.data)
      setPhase('ready')
    } catch (error) {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        onLoginRequired()
        return
      }
      setMessage(error instanceof Error ? error.message : '收银售后数据暂时无法读取')
      setPhase('error')
    }
  }, [api, onLoginRequired])

  useEffect(() => { void load(query) }, [load, query, refreshToken])
  useEffect(() => {
    if (notice === null) return
    noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [notice])

  const mutate = useCallback(async (
    key: string,
    endpoint: string,
    body: unknown,
    successMessage: string,
  ): Promise<boolean> => {
    setBusyKey(key)
    setNotice(null)
    const attempt = mutationCoordinator.current.prepare(key, body)
    try {
      await api.postEndpoint(endpoint, attempt.body, { idempotencyKey: attempt.idempotencyKey })
      mutationCoordinator.current.complete(attempt.signature)
      setNotice({ kind: 'success', text: successMessage })
      await load(query)
      return true
    } catch (error) {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        onLoginRequired()
        return false
      }
      mutationCoordinator.current.fail(
        attempt.signature,
        error instanceof NormalizedApiError && error.retryable,
      )
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '操作没有完成，请核对后重试',
      })
      return false
    } finally {
      setBusyKey(null)
    }
  }, [api, load, onLoginRequired, query])

  const closePendingBusinessDays = useCallback(async () => {
    const key = 'business-day-close-pending'
    const attempt = mutationCoordinator.current.prepare(key, {})
    setBusyKey(key)
    setNotice(null)
    try {
      const result = await api.postEndpoint<BusinessDayClosureResult>(
        '/api/business-days/close-pending', {}, { idempotencyKey: attempt.idempotencyKey },
      )
      mutationCoordinator.current.complete(attempt.signature)
      setBusinessDayClosure(result)
      setNotice({
        kind: result.blockedTableSessionCount === 0 ? 'success' : 'error',
        text: result.businessDays.length === 0
          ? '没有等待结束的上一营业日。'
          : result.blockedTableSessionCount === 0
            ? `已结束${result.closedBusinessDayCount}个营业日，并安全关闭${result.closedTableSessionCount}桌。`
            : `已安全关闭${result.closedTableSessionCount}桌；仍有${result.blockedTableSessionCount}桌需先处理。`,
      })
      await load(query)
    } catch (error) {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        onLoginRequired()
        return
      }
      mutationCoordinator.current.fail(
        attempt.signature,
        error instanceof NormalizedApiError && error.retryable,
      )
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '上一营业日未能结束，请刷新后重试',
      })
    } finally {
      setBusyKey(null)
    }
  }, [api, load, onLoginRequired, query])

  const createOnlinePayment = useCallback(async (
    input: Readonly<CashierOnlinePaymentInput>,
  ): Promise<OnlinePaymentAction | null> => {
    const key = `cashier-online-payment-${input.method}-${input.orderId}`
    const attempt = mutationCoordinator.current.prepare(key, input)
    setBusyKey(key)
    setNotice(null)
    try {
      const result = await api.postEndpoint<{ providerAction: OnlinePaymentAction }>(
        '/api/payments', input, { idempotencyKey: attempt.idempotencyKey },
      )
      mutationCoordinator.current.complete(attempt.signature)
      setNotice({
        kind: result.providerAction.status === 'failed' ? 'error' : 'success',
        text: result.providerAction.status === 'failed'
          ? '付款没有发起成功，请核对渠道或改用其他收款方式。'
          : input.method === 'native_qr'
            ? '付款二维码已生成，到账前请勿重复收款。'
            : '顾客付款码已受理，到账结果以支付渠道回传为准。',
      })
      await load(query)
      return result.providerAction
    } catch (error) {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        onLoginRequired()
        return null
      }
      mutationCoordinator.current.fail(
        attempt.signature,
        error instanceof NormalizedApiError && error.retryable,
      )
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '收款没有发起成功' })
      return null
    } finally {
      setBusyKey(null)
    }
  }, [api, load, onLoginRequired, query])

  return <CashierAfterSalesWorkbenchView
    auth={auth}
    view={view}
    phase={phase}
    message={message}
    busyKey={busyKey}
    notice={notice}
    noticeRef={noticeRef}
    businessDayClosure={businessDayClosure}
    onSearch={setQuery}
    onReload={() => void load(query)}
    onMutation={mutate}
    onCreateOnlinePayment={createOnlinePayment}
    onClosePendingBusinessDays={closePendingBusinessDays}
    onNavigate={onNavigate}
  />
}

export function CashierAfterSalesWorkbenchView({
  auth,
  view,
  phase,
  message,
  busyKey,
  notice,
  noticeRef,
  businessDayClosure = null,
  initialExpandedOrderId = null,
  onSearch,
  onReload,
  onMutation,
  onCreateOnlinePayment,
  onClosePendingBusinessDays,
  onNavigate,
}: {
  auth: StaffAuthView
  view: CashierWorkbenchView | null
  phase: 'loading' | 'ready' | 'error'
  message: string | null
  busyKey: string | null
  notice: WorkbenchNotice | null
  noticeRef?: RefObject<HTMLDivElement | null>
  businessDayClosure?: BusinessDayClosureResult | null
  initialExpandedOrderId?: string | null
  onSearch(query: string): void
  onReload(): void
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
  onCreateOnlinePayment?: (input: Readonly<CashierOnlinePaymentInput>) => Promise<OnlinePaymentAction | null>
  onClosePendingBusinessDays?: () => Promise<void>
  onNavigate?: (route: string, context?: BusinessDayNavigationContext) => void
}) {
  const [searchDraft, setSearchDraft] = useState(view?.query ?? '')
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(initialExpandedOrderId)
  const [refundDraft, setRefundDraft] = useState<RefundDraft | null>(null)
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({})
  const [manualReceipts, setManualReceipts] = useState<Record<string, string>>({})
  const [cancellationDraft, setCancellationDraft] = useState<CancellationDraft | null>(null)
  const [kdsCancellationDraft, setKdsCancellationDraft] = useState<KdsCancellationDraft | null>(null)
  const [settlementExceptionDraft, setSettlementExceptionDraft] = useState<SettlementExceptionDraft | null>(null)
  const [summaryFilter, setSummaryFilter] = useState<'all' | 'requested' | 'processing'>('all')
  const [focusedBusinessDayOrderId, setFocusedBusinessDayOrderId] = useState<string | null>(null)

  useEffect(() => {
    if (focusedBusinessDayOrderId === null) return
    const order = view?.orders.find((candidate) => candidate.id === focusedBusinessDayOrderId)
    if (order === undefined) return
    setExpandedOrderId(order.id)
    setFocusedBusinessDayOrderId(null)
    globalThis.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-cashier-order-id="${order.id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }, [focusedBusinessDayOrderId, view])

  function openBusinessDayFact(fact: BusinessDayBlockerFact) {
    const decision = businessDayFactNavigation(fact)
    if (decision.kind === 'cashier_order') {
      setSearchDraft(decision.query)
      setFocusedBusinessDayOrderId(decision.orderId)
      onSearch(decision.query)
      return
    }
    onNavigate?.(decision.route, decision.context)
  }
  function submitSearch(event: FormEvent) {
    event.preventDefault()
    onSearch(searchDraft.trim())
  }

  function openRefund(payment: CashierWorkbenchPayment) {
    setRefundDraft({ paymentId: payment.id, reason: '', amounts: {} })
  }

  function toggleRefundItem(itemId: string, remainingMinor: number) {
    setRefundDraft((current) => {
      if (current === null) return current
      const next = { ...current.amounts }
      if (next[itemId] === undefined) next[itemId] = formatAmount(remainingMinor)
      else delete next[itemId]
      return { ...current, amounts: next }
    })
  }

  function updateRefundAmount(itemId: string, value: string) {
    setRefundDraft((current) => current === null
      ? current
      : { ...current, amounts: { ...current.amounts, [itemId]: value } })
  }

  async function submitRefund(payment: CashierWorkbenchPayment) {
    if (refundDraft === null || refundDraft.paymentId !== payment.id) return
    const allocations = Object.entries(refundDraft.amounts).flatMap(([orderItemId, amount]) => {
      const amountMinor = yuanToMinor(amount)
      return amountMinor === null || amountMinor <= 0 ? [] : [{ orderItemId, amountMinor }]
    })
    const total = allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)
    if (allocations.length === 0) return
    if (total > payment.remainingRefundableMinor) return
    const completed = await onMutation(
      `refund-request-${payment.id}`,
      `/api/payments/${encodeURIComponent(payment.id)}/refunds`,
      { reason: refundDraft.reason, allocations, requestEvidence: { source: 'cashier_workbench' } },
      '退款申请已提交，等待收银复核。',
    )
    if (completed) setRefundDraft(null)
  }

  async function submitCancellation(order: CashierWorkbenchOrder) {
    if (cancellationDraft === null || cancellationDraft.orderId !== order.id) return
    if (cancellationDraft.reasonNote.trim().length < 4) return
    if (!cancellationDraft.confirmed) {
      setCancellationDraft({ ...cancellationDraft, confirmed: true })
      return
    }
    const completed = await onMutation(
      `order-cancel-unpaid-${order.id}`,
      `/api/orders/${encodeURIComponent(order.id)}/cancel-unpaid`,
      { reasonCode: cancellationDraft.reasonCode, reasonNote: cancellationDraft.reasonNote.trim() },
      '未付款订单已取消。若已有送达商品，仍需由店长或老板完成异常结清后才能关台。',
    )
    if (completed) setCancellationDraft(null)
  }

  async function submitSettlementException(order: CashierWorkbenchOrder) {
    if (settlementExceptionDraft === null || settlementExceptionDraft.orderId !== order.id) return
    if (settlementExceptionDraft.reasonNote.trim().length < 4) return
    if (!settlementExceptionDraft.confirmed) {
      setSettlementExceptionDraft({ ...settlementExceptionDraft, confirmed: true })
      return
    }
    const completed = await onMutation(
      `order-settle-exception-${order.id}`,
      `/api/orders/${encodeURIComponent(order.id)}/settle-exception`,
      { reasonCode: settlementExceptionDraft.reasonCode, reasonNote: settlementExceptionDraft.reasonNote.trim() },
      '异常结清已登记：未生成付款，已送达、库存和原营业日记录均已保留；未付款结算阻断已解除，如仍有其他现场任务系统会继续提示。',
    )
    if (completed) setSettlementExceptionDraft(null)
  }

  async function submitKdsCancellation(task: CashierWorkbenchKdsTask) {
    if (kdsCancellationDraft === null || kdsCancellationDraft.taskId !== task.id) return
    if (kdsCancellationDraft.reasonNote.trim().length < 4) return
    if (!kdsCancellationDraft.confirmed) {
      setKdsCancellationDraft({ ...kdsCancellationDraft, confirmed: true })
      return
    }
    const completed = await onMutation(
      `refund-kds-cancel-${task.id}`,
      `/api/commerce/kds/${encodeURIComponent(task.id)}/manager-cancel`,
      { reasonCode: 'refund_completed_unprepared', reasonNote: kdsCancellationDraft.reasonNote.trim() },
      '退款已核对；未开始制作的出品任务已受控取消，财务和库存将保留原事实等待复核。',
    )
    if (completed) setKdsCancellationDraft(null)
  }

  if (phase === 'loading' && view === null) {
    return <div className="cashier-workbench-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在读取本营业日订单</strong></div>
  }
  if (phase === 'error' && view === null) {
    return <div className="cashier-workbench-state is-error" role="alert"><CircleAlert /><strong>暂时没有接上收银数据</strong><p>{message}</p><button type="button" onClick={onReload}>重试</button></div>
  }
  if (view === null) return null

  const filteredOrders = view.orders.filter((order) => {
    if (summaryFilter === 'all') return true
    if (summaryFilter === 'requested') {
      return order.payments.some((payment) => payment.refunds.some((refund) => refund.status === 'requested'))
    }
    return order.payments.some((payment) => payment.refunds.some((refund) => (
      refund.status === 'approved' || refund.status === 'processing'
    )))
  })

  return <div className="cashier-workbench">
    {notice && <div ref={noticeRef} className={`cashier-workbench-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.kind === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}
      <span>{notice.text}</span>
    </div>}

    {auth.permissions.includes('business_day.close') && <section className="cashier-business-day-close" aria-label="上一营业日结束处理">
      <div><strong>上一营业日结束处理</strong><small>只关闭已经结清、出品和服务均完成的桌台；有未完成事项会保留并说明原因。</small></div>
      {onClosePendingBusinessDays && <button type="button" disabled={busyKey !== null} onClick={() => void onClosePendingBusinessDays()}>
        {busyKey === 'business-day-close-pending' ? <LoaderCircle className="is-spinning" size={17} /> : <Check size={17} />}
        检查并结束
      </button>}
      {businessDayClosure?.businessDays.flatMap((day) => day.blockers).length ? <div className="cashier-business-day-blockers">
        {businessDayClosure.businessDays.flatMap((day) => day.blockers).map((blocker) => <details
          key={`${blocker.tableSessionId}:${blocker.code}`}
        >
          <summary aria-label={`查看${blocker.tableCode}${blocker.label}${blocker.count}项明细`}>
            <b>{blocker.tableCode}</b><span>{blocker.label} {blocker.count}项</span><small>{blocker.resolution}</small>
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="cashier-business-day-facts" aria-label={`${blocker.tableCode}${blocker.label}明细`}>
            {blocker.facts.length === 0
              ? <p>权威事实正在确认，请刷新后重试；系统不会把读取失败解释成已经处理。</p>
              : blocker.facts.map((fact) => {
                const access = businessDayFactRouteAccess(fact.actionRoute, auth.permissions)
                return <article
                  key={`${fact.type}:${fact.id}`}
                  className={access.allowed?'is-actionable':''}
                  tabIndex={access.allowed?0:undefined}
                  aria-label={access.allowed?`打开${fact.title}对应处理详情`:undefined}
                  onClick={()=>{if(access.allowed) openBusinessDayFact(fact)}}
                  onKeyDown={(event)=>{
                    if(!access.allowed||event.currentTarget!==event.target||!['Enter',' '].includes(event.key)) return
                    event.preventDefault();openBusinessDayFact(fact)
                  }}
                >
                  <header><strong>{fact.title}</strong><span>{fact.statusLabel}</span></header>
                  <p>{fact.orderPublicId ? `订单 ${shortReference(fact.orderPublicId)} · ` : ''}{fact.reference}</p>
                  <dl>
                    {fact.amountMinor !== null && <><dt>金额</dt><dd>¥{formatAmount(fact.amountMinor)}</dd></>}
                    {fact.quantityText !== null && <><dt>数量</dt><dd>{fact.quantityText}</dd></>}
                    <dt>当前状态</dt><dd>{fact.statusLabel}</dd>
                    <dt>{fact.employeeRelationLabel}</dt><dd>{fact.relatedEmployeeName ?? '待分派'}</dd>
                  </dl>
                  {access.allowed
                    ? <button type="button" onClick={(event) => {event.stopPropagation();openBusinessDayFact(fact)}}>打开{access.moduleLabel}核对</button>
                    : <p>请交给具备“{access.moduleLabel}”入口权限的同事继续处理；本账号只能查看日结阻断事实。</p>}
                </article>
              })}
          </div>
        </details>)}
      </div> : null}
    </section>}

    <form className="cashier-workbench-search" role="search" onSubmit={submitSearch}>
      <Search size={18} aria-hidden="true" />
      <input
        type="search"
        value={searchDraft}
        onChange={(event) => setSearchDraft(event.target.value)}
        placeholder="桌号、订单号、支付或退款单号"
        aria-label="查找收银订单"
      />
      <button type="submit">查找</button>
    </form>

    <div className="cashier-workbench-summary" aria-label="本营业日售后摘要">
      <span><b>{view.summary.orderCount}</b><small>订单</small></span>
      <span><b>{view.summary.capturedPaymentCount}</b><small>已收款</small></span>
      <button
        type="button"
        className={`cashier-summary-filter${summaryFilter === 'requested' ? ' is-active' : ''}${view.summary.requestedRefundCount > 0 ? ' has-attention' : ''}`}
        aria-pressed={summaryFilter === 'requested'}
        onClick={() => setSummaryFilter((current) => current === 'requested' ? 'all' : 'requested')}
      ><b>{view.summary.requestedRefundCount}</b><small>待复核</small></button>
      <button
        type="button"
        className={`cashier-summary-filter${summaryFilter === 'processing' ? ' is-active' : ''}${view.summary.processingRefundCount > 0 ? ' has-attention' : ''}`}
        aria-pressed={summaryFilter === 'processing'}
        onClick={() => setSummaryFilter((current) => current === 'processing' ? 'all' : 'processing')}
      ><b>{view.summary.processingRefundCount}</b><small>待执行</small></button>
      {(view.summary.carryoverOrderCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.carryoverOrderCount}</b><small>交班遗留</small></span>}
      {(view.summary.carryoverPendingPaymentCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.carryoverPendingPaymentCount}</b><small>待查渠道</small></span>}
      {(view.summary.activityPendingPaymentCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.activityPendingPaymentCount}</b><small>活动待收款</small></span>}
      {(view.summary.activityRequestedRefundCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.activityRequestedRefundCount}</b><small>活动待复核</small></span>}
      {(view.summary.activityProcessingRefundCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.activityProcessingRefundCount}</b><small>活动待退款</small></span>}
    </div>
    {summaryFilter !== 'all' && <p className="cashier-guidance cashier-summary-filter-note">
      当前只显示{summaryFilter === 'requested' ? '待收银复核' : '待执行或待查渠道'}的订单。
      <button type="button" className="cashier-quiet-action" onClick={() => setSummaryFilter('all')}>显示全部</button>
    </p>}

    {view.actions.canUseActivityCashier === true && <ActivityCashierPanel
      registrations={view.activityRegistrations ?? []}
      auth={auth}
      actions={view.actions}
      busyKey={busyKey}
      onMutation={onMutation}
    />}

    {filteredOrders.length === 0
      ? <div className="cashier-workbench-state"><ReceiptText /><strong>{view.query || summaryFilter !== 'all' ? '没有找到对应订单' : '本营业日暂无可处理订单'}</strong><p>可按桌号、订单号、支付单号或退款单号查找，或切换上方筛选。</p></div>
      : <div className="cashier-order-list">
          {filteredOrders.map((order) => {
            const expanded = expandedOrderId === order.id
            return <article className="cashier-order" key={order.id} data-cashier-order-id={order.id}>
              <button
                type="button"
                className="cashier-order-toggle"
                aria-expanded={expanded}
                onClick={() => setExpandedOrderId(expanded ? null : order.id)}
              >
                <span><b>{order.tableCode}</b><small>{order.carryover ? `${order.businessDate ?? '前一营业日'}遗留 · ` : ''}{shortReference(order.publicId)} · {formatTime(order.submittedAt ?? order.createdAt)}</small></span>
                <span><strong>¥{formatAmount(order.totalAmountMinor)}</strong><em>{paymentStatusLabel(order.paymentStatus)}</em></span>
                <ChevronDown size={18} className={expanded ? 'is-open' : ''} />
              </button>
              {expanded && <div className="cashier-order-detail">
                {order.carryover && <p className="cashier-guidance">这是前一营业日尚未闭环的收款或退款事项；处理结果继续记在原订单，不会并入今日营业额。</p>}
                {order.carryover
                  && (order.tableSessionStatus === 'open' || order.tableSessionStatus === 'closing')
                  && auth.permissions.includes('table.close')
                  && auth.permissions.includes('table.turnover_unsettled')
                  && <button
                    type="button"
                    className="cashier-order-turnover-link"
                    onClick={() => onNavigate?.(`/staff/live?tableSessionId=${encodeURIComponent(order.tableSessionId ?? '')}`)}
                  >顾客已离店，去翻台</button>}
                {order.overCollectedAmountMinor > 0 && <p className="cashier-workflow-guidance" role="alert">本单已确认多收 ¥{formatAmount(order.overCollectedAmountMinor)}。请在下方对应收款记录发起退款；不要用新订单或手工改金额冲抵。</p>}
                {orderWorkflowGuidance(order, view.actions) && <p className="cashier-workflow-guidance">{orderWorkflowGuidance(order, view.actions)}</p>}
                <section>
                  <h3>原订单商品</h3>
                  {order.items.map((item) => <div className="cashier-line" key={item.id}>
                    <span><b>{item.productName}</b><small>{item.quantity} 件 · {itemStatusLabel(item.status)}</small></span>
                    <strong>¥{formatAmount(item.totalAmountMinor)}</strong>
                  </div>)}
                </section>
                <section>
                  <h3>收款与退款</h3>
                  <ManualCollectionPanel
                    order={order}
                    actions={view.actions}
                    busyKey={busyKey}
                    onMutation={onMutation}
                    onCreateOnlinePayment={onCreateOnlinePayment}
                  />
                  {order.payments.length === 0
                    ? <p className="cashier-guidance">该订单尚无支付记录；只有实际收到现金或实体POS确认到账后才能登记，未收款不能申请退款。</p>
                    : order.payments.map((payment) => <PaymentBlock
                        key={payment.id}
                        payment={payment}
                        auth={auth}
                        actions={view.actions}
                        busyKey={busyKey}
                        refundDraft={refundDraft}
                        decisionReasons={decisionReasons}
                        manualReceipts={manualReceipts}
                        onOpenRefund={openRefund}
                        onCancelRefund={() => setRefundDraft(null)}
                        onToggleRefundItem={toggleRefundItem}
                        onRefundAmount={updateRefundAmount}
                        onRefundReason={(reason) => setRefundDraft((current) => current === null ? current : { ...current, reason })}
                        onSubmitRefund={submitRefund}
                        onDecisionReason={(refundId, reason) => setDecisionReasons((current) => ({ ...current, [refundId]: reason }))}
                        onManualReceipt={(refundId, receipt) => setManualReceipts((current) => ({ ...current, [refundId]: receipt }))}
                        onMutation={onMutation}
                      />)}
                  {order.paymentStatus === 'unpaid' && order.status !== 'cancelled'
                    && auth.permissions.includes('order.cancel_unpaid') && (
                    <div className="cashier-refund-form" aria-label="取消未付款订单">
                      {cancellationDraft?.orderId !== order.id ? (
                        <button type="button" className="is-secondary" onClick={() => setCancellationDraft({
                          orderId: order.id,
                          reasonCode: 'guest_left',
                          reasonNote: '',
                          confirmed: false,
                        })}>处理未付款订单</button>
                      ) : <>
                        <label className="cashier-field"><span>取消原因</span><select
                          value={cancellationDraft.reasonCode}
                          onChange={(event) => setCancellationDraft({
                            ...cancellationDraft,
                            reasonCode: event.target.value as CancellationDraft['reasonCode'],
                            confirmed: false,
                          })}
                        >
                          <option value="guest_left">客人离店且未付款</option>
                          <option value="duplicate_order">重复订单</option>
                          <option value="test_cleanup">测试或跨日清理</option>
                          <option value="other">其他</option>
                        </select></label>
                        <label className="cashier-field"><span>现场核对说明</span><textarea
                          value={cancellationDraft.reasonNote}
                          maxLength={500}
                          placeholder="至少4个字；说明客人、支付状态和处理原因"
                          onChange={(event) => setCancellationDraft({
                            ...cancellationDraft,
                            reasonNote: event.target.value,
                            confirmed: false,
                          })}
                        /></label>
                        <p className="cashier-guidance">仅取消未付款应收和未履约部分；已送达商品、已消耗库存和原营业日记录不会删除。</p>
                        <div className="cashier-form-actions">
                          <button type="button" className="is-secondary" onClick={() => setCancellationDraft(null)}>返回</button>
                          <button
                            type="button"
                            disabled={busyKey === `order-cancel-unpaid-${order.id}` || cancellationDraft.reasonNote.trim().length < 4}
                            onClick={() => void submitCancellation(order)}
                          >{cancellationDraft.confirmed ? '再次确认取消订单' : '核对并继续'}</button>
                        </div>
                      </>}
                    </div>
                  )}
                  {order.paymentStatus === 'unpaid' && order.status === 'cancelled'
                    && order.items.some((item) => item.status === 'delivered')
                    && order.settlementException == null
                    && auth.permissions.includes('order.settle_exception') && (
                    <div className="cashier-refund-form" aria-label="异常结清已送达未付款订单">
                      {settlementExceptionDraft?.orderId !== order.id ? (
                        <button type="button" className="is-secondary" onClick={() => setSettlementExceptionDraft({
                          orderId: order.id,
                          reasonCode: 'manager_comp',
                          reasonNote: '',
                          confirmed: false,
                        })}>异常结清已送达金额</button>
                      ) : <>
                        <label className="cashier-field"><span>结清原因</span><select
                          value={settlementExceptionDraft.reasonCode}
                          onChange={(event) => setSettlementExceptionDraft({
                            ...settlementExceptionDraft,
                            reasonCode: event.target.value as SettlementExceptionDraft['reasonCode'],
                            confirmed: false,
                          })}
                        >
                          <option value="manager_comp">店长确认免单</option>
                          <option value="uncollectible">确认无法收回</option>
                          {auth.employee.roleCodes.includes('OWNER') && <option value="test_cleanup">测试数据清理（老板）</option>}
                        </select></label>
                        <label className="cashier-field"><span>现场说明</span><textarea
                          value={settlementExceptionDraft.reasonNote}
                          maxLength={500}
                          placeholder="至少4个字；说明为何不生成实际收款"
                          onChange={(event) => setSettlementExceptionDraft({
                            ...settlementExceptionDraft,
                            reasonNote: event.target.value,
                            confirmed: false,
                          })}
                        /></label>
                        <p className="cashier-guidance">这不是收款：系统只留存异常结清事实。已送达商品、库存和原营业日记录不会删除。</p>
                        <div className="cashier-form-actions">
                          <button type="button" className="is-secondary" onClick={() => setSettlementExceptionDraft(null)}>返回</button>
                          <button
                            type="button"
                            disabled={busyKey === `order-settle-exception-${order.id}` || settlementExceptionDraft.reasonNote.trim().length < 4}
                            onClick={() => void submitSettlementException(order)}
                          >{settlementExceptionDraft.confirmed ? '再次确认异常结清' : '核对并继续'}</button>
                        </div>
                      </>}
                    </div>
                  )}
                  {order.settlementException != null && <p className="cashier-guidance">
                    已异常结清 ¥{formatAmount(order.settlementException.settledAmountMinor)}；未生成付款。
                  </p>}
                </section>
                {order.kdsTasks.length > 0 && <section className="cashier-kds-section" aria-label="关联出品任务">
                  <h3>关联出品</h3>
                  {order.kdsTasks.every((task) => task.succeededRefundAmountMinor <= 0)
                    ? <p className="cashier-guidance">出品任务仍在等待接单或制作。退款成功后可在此终止未开始制作的任务；请先在上方「收款与退款」完成退款。</p>
                    : <>
                      <p className="cashier-workbench-boundary">退款成功不等于自动取消制作。仅未开始制作的任务可由具备出品异常权限的员工核对、填写原因后终止；制作中或已送达必须转入现场异常复核。</p>
                      {order.kdsTasks.map((task) => {
                        const confirmedRefund = task.succeededRefundAmountMinor > 0
                        const canCancel = confirmedRefund && ['pending', 'accepted'].includes(task.status)
                        const requiresEscalation = confirmedRefund && ['preparing', 'ready'].includes(task.status)
                        const drafting = kdsCancellationDraft?.taskId === task.id
                        return <div className={`cashier-kds-task is-${task.status}`} key={task.id}>
                          <div className="cashier-kds-heading">
                            <span><b>{task.stationCode === 'bar' ? '吧台出品' : '后厨出品'}</b><small>{task.quantity} 份 · {kdsStatusLabel(task.status)}</small></span>
                            {confirmedRefund && <strong>已退款 ¥{formatAmount(task.succeededRefundAmountMinor)}</strong>}
                          </div>
                          {!confirmedRefund && <p>未见与该出品明细关联的渠道退款成功记录，不能从这里终止任务。</p>}
                          {requiresEscalation && <p className="cashier-kds-escalation">该任务已进入{kdsStatusLabel(task.status)}，请由现场负责人核对实物、库存和客人沟通结果；本页不提供取消。</p>}
                          {canCancel && !view.actions.canManageKdsException && <p className="cashier-kds-escalation">退款已成功，但当前账号没有“处理出品异常”权限，请交给值班经理处理。</p>}
                          {canCancel && view.actions.canManageKdsException && (drafting ? <div className="cashier-refund-form">
                            <label className="cashier-field"><span>现场核对说明</span><textarea
                              value={kdsCancellationDraft.reasonNote}
                              maxLength={500}
                              placeholder="至少4个字，例如：客人取消，吧台确认尚未开始制作"
                              onChange={(event) => setKdsCancellationDraft({
                                ...kdsCancellationDraft,
                                reasonNote: event.target.value,
                                confirmed: false,
                              })}
                            /></label>
                            <p className="cashier-guidance">此操作只终止未开始制作的出品任务；退款、原订单、库存和原营业日事实不会被改写。</p>
                            <div className="cashier-form-actions">
                              <button type="button" className="is-secondary" onClick={() => setKdsCancellationDraft(null)}>返回</button>
                              <button
                                type="button"
                                disabled={busyKey === `refund-kds-cancel-${task.id}` || kdsCancellationDraft.reasonNote.trim().length < 4}
                                onClick={() => void submitKdsCancellation(task)}
                              >{kdsCancellationDraft.confirmed ? '再次确认终止出品' : '核对并继续'}</button>
                            </div>
                          </div> : <button
                            type="button"
                            className="cashier-secondary-action"
                            disabled={busyKey !== null}
                            onClick={() => setKdsCancellationDraft({ taskId: task.id, reasonNote: '', confirmed: false })}
                          >核对退款后处理出品</button>)}
                        </div>
                      })}
                    </>}
                </section>}
              </div>}
            </article>
          })}
        </div>}

    <p className="cashier-workbench-boundary">线上退款只有支付渠道回传成功后才入账；现金和实体POS必须登记独立退款凭证。</p>
  </div>
}

function ManualCollectionPanel({ order, actions, busyKey, onMutation, onCreateOnlinePayment }: {
  order: CashierWorkbenchOrder
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
  onCreateOnlinePayment?: (input: Readonly<CashierOnlinePaymentInput>) => Promise<OnlinePaymentAction | null>
}) {
  const [provider, setProvider] = useState<'cash' | 'physical_pos' | 'external_manual' | null>(null)
  const [receiptReference, setReceiptReference] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [externalMethodCode, setExternalMethodCode] = useState<'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'>('bank_transfer')
  const [collectionNote, setCollectionNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [onlineAction, setOnlineAction] = useState<OnlinePaymentAction | null>(null)
  const [showScanner, setShowScanner] = useState(false)
  const [onlineError, setOnlineError] = useState<string | null>(null)
  const [recollectionReason, setRecollectionReason] = useState('')
  const [recollectionConfirmed, setRecollectionConfirmed] = useState(false)
  const activeOnlinePayment = order.payments.find((payment) => (
    (payment.provider === 'postar' || payment.provider === 'wechat')
    && (payment.status === 'created' || payment.status === 'pending')
    && (payment.retryReleasedAt === null || payment.retryReleasedAt === undefined)
    && (payment.providerTransactionId !== null
      || (payment.providerActionState !== null && payment.providerActionState !== 'failed'))
  ))
  const unpresentedOnlinePayment = order.payments.find((payment) => (
    (payment.provider === 'postar' || payment.provider === 'wechat')
    && (payment.status === 'created' || payment.status === 'pending')
    && (payment.retryReleasedAt === null || payment.retryReleasedAt === undefined)
    && payment.providerTransactionId === null
    && (payment.providerActionState === null || payment.providerActionState === 'failed')
  ))
  const canCreateOnline = actions.canInitiateOnlinePayment
    && actions.onlinePaymentProvider !== null
    && onCreateOnlinePayment !== undefined
  const hasCompletedRefund = order.payments.some((payment) => payment.refunds.some((refund) => refund.status === 'succeeded'))
  const requiresRecollectionAuthorization = hasCompletedRefund && order.outstandingAmountMinor > 0
  const canCollect = order.status !== 'cancelled' && order.outstandingAmountMinor > 0
    && (!requiresRecollectionAuthorization || order.recollectionAuthorization !== null)
    && (canCreateOnline || actions.canRecordManualCash || actions.canRecordManualPos || actions.canRecordManualExternal)
  if (requiresRecollectionAuthorization && order.recollectionAuthorization === null) {
    const canAuthorize = actions.canAuthorizeRecollection === true
    const authorizationKey = `refund-recollection-authorize-${order.id}`
    const authorize = async () => {
      if (!canAuthorize || recollectionReason.trim().length < 4) return
      if (!recollectionConfirmed) { setRecollectionConfirmed(true); return }
      const completed = await onMutation(
        authorizationKey,
        `/api/orders/${encodeURIComponent(order.id)}/recollection-authorizations`,
        { reason: recollectionReason.trim() },
        '已授权本单重新收款。授权仅适用于当前余额且会自动过期；请在下方选择实际收款方式。',
      )
      if (completed) { setRecollectionReason(''); setRecollectionConfirmed(false) }
    }
    return <div className="cashier-manual-collection is-blocked" aria-label="退款后重新收款授权">
      <div><strong>退款后重新收款</strong><small>已完成退款不会自动恢复收款。需由收银确认客人仍要支付，再开启一次性收款。</small></div>
      {canAuthorize ? <div className="cashier-manual-result">
        <label className="cashier-field"><span>重新收款原因</span><textarea value={recollectionReason} maxLength={500}
          placeholder="至少4个字，例如：原渠道退款后，顾客确认改用实体POS付款"
          onChange={(event) => { setRecollectionReason(event.target.value); setRecollectionConfirmed(false) }} /></label>
        {recollectionConfirmed && <p className="cashier-guidance">请再次确认：退款已完成，顾客明确同意重新支付 ¥{formatAmount(order.outstandingAmountMinor)}；本授权仅限本单、限时且只可使用一次。</p>}
        <div className="cashier-action-row"><button type="button" className="cashier-primary-action"
          disabled={busyKey !== null || recollectionReason.trim().length < 4}
          onClick={() => void authorize()}>{busyKey === authorizationKey ? <LoaderCircle className="is-spinning" size={17} /> : null}{recollectionConfirmed ? '确认授权重新收款' : '核对并继续'}</button></div>
      </div> : <p className="cashier-guidance">当前账号无“授权退款后重新收款”权限，请交给具备退款复核权限的收银处理。</p>}
    </div>
  }
  if (!canCollect) return null
  const blocked = activeOnlinePayment !== undefined
  const mutationKey = provider === null ? '' : `manual-payment-${provider}-${order.id}`

  async function releaseUnresolvedPayment(): Promise<void> {
    if (activeOnlinePayment === undefined) return
    await onMutation(
      `payment-retry-release-${activeOnlinePayment.id}`,
      `/api/payments/${encodeURIComponent(activeOnlinePayment.id)}/retry-release`,
      { reason: '未收到明确成功结果，改用或再次发起收款' },
      '已按未到账释放原收款尝试。现在可以重新出示二维码、扫描付款码或登记实际收到的现场款；若旧渠道稍后到账，会保留到收工退款/对账。',
    )
  }

  async function createPayment(method: 'native_qr' | 'auth_code', customerAuthCode?: string) {
    if (!canCreateOnline || actions.onlinePaymentProvider === null || blocked) return false
    setOnlineError(null)
    const action = await onCreateOnlinePayment({
      orderId: order.id,
      provider: actions.onlinePaymentProvider,
      method,
      ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
    })
    if (action === null) {
      setOnlineError('收款没有发起成功，请核对上方提示。')
      return false
    }
    setOnlineAction(action)
    setShowScanner(false)
    return true
  }

  async function submit() {
    if (provider === null || blocked || receiptReference.trim().length < 3) return
    if (provider === 'physical_pos' && terminalId.trim().length < 2) return
    if (provider === 'external_manual' && collectionNote.trim().length < 2) return
    if (!confirmed) { setConfirmed(true); return }
    const completed = await onMutation(
      mutationKey,
      '/api/payments/manual',
      {
        orderId: order.id,
        provider,
        method: provider === 'cash' ? 'cash' : provider === 'physical_pos' ? 'card' : 'manual',
        receiptReference: receiptReference.trim(),
        ...(provider === 'physical_pos' && terminalId.trim() ? { terminalId: terminalId.trim() } : {}),
        ...(provider === 'external_manual' ? {
          externalMethodCode,
          collectionNote: collectionNote.trim(),
        } : {}),
      },
      provider === 'cash'
        ? '现金收款已登记，订单支付状态已刷新；已配置收银打印路由时会生成支付凭条。'
        : provider === 'physical_pos'
          ? '实体POS收款已登记，订单支付状态已刷新；已配置收银打印路由时会生成支付凭条。'
          : '其他线下收款已登记，订单支付状态已刷新并进入日结对账。',
    )
    if (completed) {
      setProvider(null); setReceiptReference(''); setTerminalId(''); setCollectionNote(''); setConfirmed(false)
    }
  }

  const qrValue = onlineAction?.presentation === 'qr'
    && typeof onlineAction.payload?.qrCodeUrl === 'string' ? onlineAction.payload.qrCodeUrl : null

  return <div className={`cashier-manual-collection${blocked ? ' is-blocked' : ''}`}>
    <div><strong>现场收款</strong><small>剩余应收 ¥{formatAmount(order.outstandingAmountMinor)}；{order.recollectionAuthorization !== null ? '退款后重新收款授权已生效，请在到期前完成一次实际收款。' : '可让顾客扫二维码、扫顾客付款码，或登记已实际收到的现金/POS/其他款项。'}</small></div>
    {onlineAction !== null && onlineAction.status !== 'failed' ? <div className="cashier-manual-result" aria-live="polite">
      {qrValue !== null ? <><CashierPaymentQr value={qrValue} /><strong>请顾客扫码付款</strong><p>到账前不要重复收款；本页下方会保留这笔付款的渠道查单入口。</p></>
        : <><strong>顾客付款码已受理</strong><p>请勿重复扫码，实际到账以支付渠道回传和下方查单结果为准。</p></>}
      <button type="button" className="cashier-quiet-action" onClick={() => setOnlineAction(null)}>暂时收起</button>
    </div> : blocked ? <div className="cashier-channel-pending"><p>已有线上支付“{shortReference(activeOnlinePayment.publicId)}”正在等待明确结果。若现场确认未收到款，可直接按未到账重新收款；旧渠道若随后到账，会自动保留在收工退款/对账待办。</p><div className="cashier-action-row"><button type="button" className="cashier-primary-action" disabled={busyKey !== null} onClick={() => void releaseUnresolvedPayment()}><RefreshCcw size={16} />按未到账重新收款</button></div></div> : <>
      {unpresentedOnlinePayment !== undefined && <p className="cashier-guidance">系统发现一笔尚未向支付渠道发起的线上记录。登记现场收款时会在同一笔操作中安全关闭该记录，不需要客人继续线上待支付。</p>}
      {provider === null ? <div className="cashier-action-row">
        {canCreateOnline && <button type="button" className="cashier-primary-action" disabled={busyKey !== null} onClick={() => void createPayment('native_qr')}><QrCode size={17} />出示付款二维码</button>}
        {canCreateOnline && <button type="button" className="cashier-secondary-action" disabled={busyKey !== null} onClick={() => setShowScanner(true)}><ScanLine size={17} />扫顾客付款码</button>}
        {actions.canRecordManualCash && <button type="button" className="cashier-primary-action" disabled={busyKey !== null} onClick={() => setProvider('cash')}>登记现金收款</button>}
        {actions.canRecordManualPos && <button type="button" className="cashier-secondary-action" disabled={busyKey !== null} onClick={() => setProvider('physical_pos')}>登记实体POS收款</button>}
        {actions.canRecordManualExternal && <button type="button" className="cashier-secondary-action" disabled={busyKey !== null} onClick={() => setProvider('external_manual')}>登记其他线下收款</button>}
      </div> : <div className="cashier-manual-result">
        <strong>{manualCollectionLabel(provider)}</strong>
        <p>只在款项已经实际收到后登记。系统将记录当前登录员工、时间和凭证，不允许代填他人身份。</p>
        {provider === 'external_manual' && <label className="cashier-field"><span>实际收款方式</span><select value={externalMethodCode} onChange={(event) => { setExternalMethodCode(event.target.value as typeof externalMethodCode); setConfirmed(false) }}><option value="bank_transfer">银行转账</option><option value="mobile_wallet">其他扫码或数字钱包</option><option value="stored_value_voucher">储值卡或代金凭证</option><option value="corporate_account">公司账户结算</option><option value="other">其他经批准方式</option></select></label>}
        <label className="cashier-field"><span>{provider === 'cash' ? '现金收款凭证号' : provider === 'physical_pos' ? 'POS小票/交易号' : '外部交易号或凭证号'}</span><input value={receiptReference} maxLength={256} placeholder={provider === 'cash' ? '例如 XJ-20260824-L01-001' : provider === 'physical_pos' ? '例如 POS-20260824-0001' : '填写可供日结核对的真实凭证号'} onChange={(event) => { setReceiptReference(event.target.value); setConfirmed(false) }} /></label>
        {provider === 'physical_pos' && <label className="cashier-field"><span>POS终端编号</span><input value={terminalId} maxLength={128} placeholder="例如 POS-01" onChange={(event) => { setTerminalId(event.target.value); setConfirmed(false) }} /></label>}
        {provider === 'external_manual' && <label className="cashier-field"><span>收款说明</span><textarea value={collectionNote} maxLength={500} placeholder="说明收款平台、核对对象或其他可复核信息" onChange={(event) => { setCollectionNote(event.target.value); setConfirmed(false) }} /></label>}
        {confirmed && <p className="cashier-guidance">请再次核对：已经实际收到{manualCollectionAmountLabel(provider)} ¥{formatAmount(order.outstandingAmountMinor)}，凭证号为“{receiptReference.trim()}”。确认后将计入收款和对账，并在订单收清后允许继续结台。</p>}
        <div className="cashier-action-row">
          <button type="button" className="cashier-quiet-action" disabled={busyKey !== null} onClick={() => { setProvider(null); setConfirmed(false) }}>返回</button>
          <button type="button" className="cashier-primary-action" disabled={busyKey !== null || receiptReference.trim().length < 3 || (provider === 'physical_pos' && terminalId.trim().length < 2) || (provider === 'external_manual' && collectionNote.trim().length < 2)} onClick={() => void submit()}>
            {busyKey === mutationKey ? <LoaderCircle className="is-spinning" size={17} /> : null}{confirmed ? `确认已收到${manualCollectionAmountLabel(provider)}` : '核对并继续'}
          </button>
        </div>
      </div>}
      {onlineAction?.status === 'failed' && <p className="cashier-guidance">上一次线上收款未成功，可重新生成二维码、重新扫码或改用现场收款。</p>}
      {onlineError !== null && <p className="cashier-guidance" role="alert">{onlineError}</p>}
    </>}
    {showScanner && <CustomerPaymentCodeScanner
      tableCode={order.tableCode}
      amountLabel={`¥${formatAmount(order.outstandingAmountMinor)}`}
      onClose={() => setShowScanner(false)}
      onConfirm={(customerAuthCode) => createPayment('auth_code', customerAuthCode)}
    />}
  </div>
}

/**
 * Activity registrations stay in the same cashier screen, but are never
 * rendered as table orders and never reveal attendee contact data.  All
 * controls are capability-gated again by the server on command execution.
 */
function ActivityCashierPanel({ registrations, auth, actions, busyKey, onMutation }: {
  registrations: readonly CashierWorkbenchActivityRegistration[]
  auth: StaffAuthView
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  return <section className="cashier-activity-worklist" aria-label="活动收银工作台">
    <header>
      <span><b>活动收银</b><small>仅显示报名、支付、退款和库存名额恢复状态；不显示顾客联系方式。</small></span>
      <strong>{registrations.length} 项</strong>
    </header>
    {registrations.length === 0
      ? <p className="cashier-guidance">本营业日没有待处理的活动收银事项。已完成的活动收款和退款会进入日结对账。</p>
      : <div className="cashier-order-list">
        {registrations.map((registration) => <ActivityCashierRegistrationCard
          key={registration.id}
          registration={registration}
          auth={auth}
          actions={actions}
          busyKey={busyKey}
          expanded={expandedId === registration.id}
          onToggle={() => setExpandedId((current) => current === registration.id ? null : registration.id)}
          onMutation={onMutation}
        />)}
      </div>}
  </section>
}

function ActivityCashierRegistrationCard({ registration, auth, actions, busyKey, expanded, onToggle, onMutation }: {
  registration: CashierWorkbenchActivityRegistration
  auth: StaffAuthView
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  expanded: boolean
  onToggle(): void
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const [provider, setProvider] = useState<'cash' | 'physical_pos' | 'external_manual' | null>(null)
  const [receiptReference, setReceiptReference] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [externalMethodCode, setExternalMethodCode] = useState<'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'>('bank_transfer')
  const [collectionNote, setCollectionNote] = useState('')
  const [collectionConfirmed, setCollectionConfirmed] = useState(false)
  const [recollectionReason, setRecollectionReason] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const payment = registration.payment
  const refund = payment?.refunds[0] ?? null
  const recollectionAuthorization = registration.recollectionAuthorization ?? null
  const isRefunded = registration.paymentStatus === 'refunded' || registration.status === 'refunded'
  const dueMinor = isRefunded ? registration.paidAmountMinor : registration.amountDueMinor
  const onlineActionPending = payment !== null
    && (payment.provider === 'postar' || payment.provider === 'wechat')
    && (payment.status === 'created' || payment.status === 'pending')
    && (payment.providerTransactionId !== null
      || (payment.providerActionState !== null && payment.providerActionState !== 'failed'))
  const canManual = provider !== null
    && ((provider === 'cash' && actions.canRecordManualCash)
      || (provider === 'physical_pos' && actions.canRecordManualPos)
      || (provider === 'external_manual' && actions.canRecordManualExternal))
  const needsAuthorization = isRefunded && dueMinor > 0 && recollectionAuthorization === null
  const canCollect = dueMinor > 0 && refund === null && !onlineActionPending
    && (!needsAuthorization)
    && (actions.canRecordManualCash || actions.canRecordManualPos || actions.canRecordManualExternal)
  const canRequestRefund = payment !== null && payment.remainingRefundableMinor > 0
    && refund === null && actions.canRequestRefund
  const collectionKey = provider === null ? '' : `activity-manual-payment-${provider}-${registration.id}`

  async function submitCollection() {
    if (!canManual || provider === null || !collectionConfirmed || receiptReference.trim().length < 3) return
    if (provider === 'physical_pos' && terminalId.trim().length < 2) return
    if (provider === 'external_manual' && collectionNote.trim().length < 2) return
    const completed = await onMutation(
      collectionKey,
      `/api/activity-registrations/${encodeURIComponent(registration.publicId)}/manual-collections`,
      {
        provider,
        method: provider === 'cash' ? 'cash' : provider === 'physical_pos' ? 'card' : 'manual',
        receiptReference: receiptReference.trim(),
        ...(provider === 'physical_pos' ? { terminalId: terminalId.trim() } : {}),
        ...(provider === 'external_manual' ? { externalMethodCode, collectionNote: collectionNote.trim() } : {}),
      },
      '活动现场收款已登记，并已写入日结对账。',
    )
    if (completed) {
      setProvider(null); setReceiptReference(''); setTerminalId(''); setCollectionNote(''); setCollectionConfirmed(false)
    }
  }

  return <article className="cashier-order cashier-activity-registration" data-cashier-activity-registration-id={registration.id}>
    <button type="button" className="cashier-order-toggle" aria-expanded={expanded} onClick={onToggle}>
      <span><b>{registration.activityTitle}</b><small>{shortReference(registration.publicId)} · {registration.partySize} 人 · {formatTime(registration.startsAt)}</small></span>
      <span><strong>¥{formatAmount(isRefunded ? registration.paidAmountMinor : dueMinor)}</strong><em>{paymentStatusLabel(registration.paymentStatus)}</em></span>
      <ChevronDown size={18} className={expanded ? 'is-open' : ''} />
    </button>
    {expanded && <div className="cashier-order-detail">
      <section>
        <h3>活动报名事实</h3>
        <div className="cashier-line"><span><b>活动编号</b><small>{shortReference(registration.activityPublicId)} · 报名状态：{registration.status}</small></span><strong>{registration.partySize} 人</strong></div>
        <p className="cashier-workbench-boundary">本页不显示或导出顾客联系方式。活动退款只能由店内收银处理，顾客端没有自助退款入口。</p>
      </section>
      <section>
        <h3>收款、退款与受控重收</h3>
        {onlineActionPending && <p className="cashier-channel-pending">这笔活动付款已经向线上渠道发起，系统已锁定其他收款入口。请先等待或查询渠道结果，避免重复收款。</p>}
        {needsAuthorization && <div className="cashier-manual-collection is-blocked">
          <div><strong>退款后重新收款</strong><small>退款已释放活动名额和套餐库存；重新收款前会重新校验活动名额、套餐名额和物料库存。</small></div>
          {actions.canAuthorizeRecollection ? <>
            <label className="cashier-field"><span>重新收款原因</span><textarea value={recollectionReason} maxLength={500} placeholder="至少4个字，例如：顾客确认改用实体POS付款" onChange={(event) => setRecollectionReason(event.target.value)} /></label>
            <button type="button" className="cashier-primary-action" disabled={busyKey !== null || recollectionReason.trim().length < 4} onClick={() => void onMutation(
              `activity-recollection-authorize-${registration.id}`,
              `/api/activity-registrations/${encodeURIComponent(registration.publicId)}/recollection-authorizations`,
              { reason: recollectionReason.trim() },
              '已授权一次活动重新收款；实际收款前仍会重新占用名额和库存。',
            )}>授权重新收款</button>
          </> : <p className="cashier-guidance">当前账号不能授权退款后重新收款，请交给有该权限的收银或管理人员。</p>}
        </div>}
        {recollectionAuthorization !== null && <p className="cashier-guidance">已授权一次重新收款 ¥{formatAmount(recollectionAuthorization.amountMinor)}，到 {formatTime(recollectionAuthorization.expiresAt)} 前有效；若名额或库存不足，收款会被安全拒绝。</p>}
        {canCollect && <div className="cashier-manual-collection">
          <div><strong>登记活动现场收款</strong><small>应收 ¥{formatAmount(dueMinor)}；仅在实际收到款项后登记，凭证会和当前员工、时间一起进入审计与日结。</small></div>
          {provider === null ? <div className="cashier-action-row">
            {actions.canRecordManualCash && <button type="button" className="cashier-primary-action" disabled={busyKey !== null} onClick={() => setProvider('cash')}>登记现金</button>}
            {actions.canRecordManualPos && <button type="button" className="cashier-secondary-action" disabled={busyKey !== null} onClick={() => setProvider('physical_pos')}>登记实体POS</button>}
            {actions.canRecordManualExternal && <button type="button" className="cashier-secondary-action" disabled={busyKey !== null} onClick={() => setProvider('external_manual')}>登记其他方式</button>}
          </div> : <div className="cashier-manual-result">
            {provider === 'external_manual' && <label className="cashier-field"><span>实际收款方式</span><select value={externalMethodCode} onChange={(event) => { setExternalMethodCode(event.target.value as typeof externalMethodCode); setCollectionConfirmed(false) }}><option value="bank_transfer">银行转账</option><option value="mobile_wallet">其他扫码或数字钱包</option><option value="stored_value_voucher">储值卡或代金凭证</option><option value="corporate_account">公司账户结算</option><option value="other">其他经批准方式</option></select></label>}
            <label className="cashier-field"><span>{provider === 'cash' ? '现金收款凭证号' : provider === 'physical_pos' ? 'POS小票/交易号' : '外部交易号或凭证号'}</span><input value={receiptReference} maxLength={256} onChange={(event) => { setReceiptReference(event.target.value); setCollectionConfirmed(false) }} /></label>
            {provider === 'physical_pos' && <label className="cashier-field"><span>POS终端编号</span><input value={terminalId} maxLength={128} onChange={(event) => { setTerminalId(event.target.value); setCollectionConfirmed(false) }} /></label>}
            {provider === 'external_manual' && <label className="cashier-field"><span>收款说明</span><textarea value={collectionNote} maxLength={500} onChange={(event) => { setCollectionNote(event.target.value); setCollectionConfirmed(false) }} /></label>}
            {collectionConfirmed && <p className="cashier-guidance">请确认已实际收到 ¥{formatAmount(dueMinor)}，凭证“{receiptReference.trim()}”真实可核对。提交后会计入收款与日结。</p>}
            <div className="cashier-action-row"><button type="button" className="cashier-quiet-action" disabled={busyKey !== null} onClick={() => { setProvider(null); setCollectionConfirmed(false) }}>返回</button><button type="button" className="cashier-primary-action" disabled={busyKey !== null || receiptReference.trim().length < 3 || (provider === 'physical_pos' && terminalId.trim().length < 2) || (provider === 'external_manual' && collectionNote.trim().length < 2)} onClick={() => { if (!collectionConfirmed) setCollectionConfirmed(true); else void submitCollection() }}>{collectionConfirmed ? '确认已实际收款' : '核对并继续'}</button></div>
          </div>}
        </div>}
        {canRequestRefund && <div className="cashier-refund-form">
          <h4>发起活动退款</h4>
          <p className="cashier-guidance">退款金额为本次活动实际收款 ¥{formatAmount(payment.remainingRefundableMinor)}。顾客不能自助退款，申请后需由非申请人复核。</p>
          <label className="cashier-field"><span>退款原因</span><textarea value={refundReason} maxLength={1000} placeholder="至少2个字；说明活动、原收款和退款原因" onChange={(event) => setRefundReason(event.target.value)} /></label>
          <button type="button" className="cashier-danger-action" disabled={busyKey !== null || refundReason.trim().length < 2} onClick={() => void onMutation(
            `activity-refund-request-${registration.id}`,
            `/api/staff/community-activity-registrations/${encodeURIComponent(registration.publicId)}/refunds`,
            { reason: refundReason.trim() },
            '活动退款申请已提交，等待非申请人复核。',
          )}>发起全额退款</button>
        </div>}
        {refund !== null && <ActivityRefundBlock
          refund={refund}
          payment={payment!}
          auth={auth}
          actions={actions}
          busyKey={busyKey}
          onMutation={onMutation}
        />}
      </section>
    </div>}
  </article>
}

function ActivityRefundBlock({ refund, payment, auth, actions, busyKey, onMutation }: {
  refund: CashierWorkbenchRefund
  payment: CashierWorkbenchPayment
  auth: StaffAuthView
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const [decisionReason, setDecisionReason] = useState('')
  const [manualReceipt, setManualReceipt] = useState('')
  return <RefundBlock
    refund={refund}
    payment={payment}
    auth={auth}
    actions={actions}
    busyKey={busyKey}
    decisionReason={decisionReason}
    manualReceipt={manualReceipt}
    manualProvider={payment.provider === 'cash' || payment.provider === 'physical_pos' || payment.provider === 'external_manual'}
    onDecisionReason={(_, reason) => setDecisionReason(reason)}
    onManualReceipt={(_, receipt) => setManualReceipt(receipt)}
    onMutation={onMutation}
  />
}

function CashierPaymentQr({ value }: { value: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(value, {
      width: 260, margin: 1, errorCorrectionLevel: 'M',
    })).then((next) => { if (active) setImage(next) })
    return () => { active = false }
  }, [value])
  return image === null
    ? <LoaderCircle className="is-spinning" />
    : <img className="staff-payment-qr" src={image} alt="顾客扫码付款二维码" />
}

function PaymentBlock({
  payment,
  auth,
  actions,
  busyKey,
  refundDraft,
  decisionReasons,
  manualReceipts,
  onOpenRefund,
  onCancelRefund,
  onToggleRefundItem,
  onRefundAmount,
  onRefundReason,
  onSubmitRefund,
  onDecisionReason,
  onManualReceipt,
  onMutation,
}: {
  payment: CashierWorkbenchPayment
  auth: StaffAuthView
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  refundDraft: RefundDraft | null
  decisionReasons: Record<string, string>
  manualReceipts: Record<string, string>
  onOpenRefund(payment: CashierWorkbenchPayment): void
  onCancelRefund(): void
  onToggleRefundItem(itemId: string, remainingMinor: number): void
  onRefundAmount(itemId: string, value: string): void
  onRefundReason(reason: string): void
  onSubmitRefund(payment: CashierWorkbenchPayment): Promise<void>
  onDecisionReason(refundId: string, reason: string): void
  onManualReceipt(refundId: string, receipt: string): void
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const drafting = refundDraft?.paymentId === payment.id
  const selectedTotal = drafting
    ? Object.values(refundDraft.amounts).reduce((sum, value) => sum + (yuanToMinor(value) ?? 0), 0)
    : 0
  const validRefund = drafting
    && refundDraft.reason.trim().length >= 2
    && selectedTotal > 0
    && selectedTotal <= payment.remainingRefundableMinor
    && Object.entries(refundDraft.amounts).every(([itemId, amount]) => {
      const amountMinor = yuanToMinor(amount)
      const item = payment.refundableItems.find((candidate) => candidate.id === itemId)
      return amountMinor !== null
        && amountMinor > 0
        && item !== undefined
        && amountMinor <= item.remainingRefundableMinor
    })
  const manualProvider = payment.provider === 'cash'
    || payment.provider === 'physical_pos'
    || payment.provider === 'external_manual'
  return <div className="cashier-payment-block">
    <div className="cashier-payment-heading">
      <span><b>{providerLabel(payment.provider)}</b><small>{shortReference(payment.publicId)} · {paymentStatusLabel(payment.status)}</small></span>
      <span><strong>¥{formatAmount(payment.amountMinor)}</strong><small>剩余可退 ¥{formatAmount(payment.remainingRefundableMinor)}</small></span>
    </div>

    {actions.canRequestRefund && payment.remainingRefundableMinor > 0 && !drafting && <button type="button" className="cashier-secondary-action" onClick={() => onOpenRefund(payment)}>
      选择原商品发起退款
    </button>}

    {actions.canViewReconciliation && payment.provider === 'postar'
      && (payment.status === 'created' || payment.status === 'pending')
      && payment.providerActionState !== null && payment.providerActionState !== 'failed'
      && <div className="cashier-provider-query">
      <p>这笔线上付款尚无明确结果。查询只读取支付渠道的签名结果，不会再次扣款。</p>
      <button
        type="button"
        className="cashier-secondary-action"
        disabled={busyKey !== null}
        onClick={() => void onMutation(
          `payment-provider-query-${payment.id}`,
          `/api/payments/${encodeURIComponent(payment.id)}/provider-query`,
          {},
          '已完成渠道查单，结果已按渠道回传更新。',
        )}
      >{busyKey === `payment-provider-query-${payment.id}` ? <LoaderCircle className="is-spinning" size={17} /> : null}查询渠道结果</button>
    </div>}

    {actions.canExecuteRefund && payment.provider === 'postar' && payment.refunds
      .filter((refund) => refund.status === 'processing')
      .map((refund) => <div className="cashier-provider-query" key={`refund-query-${refund.id}`}>
        <p>这笔线上退款正在等待渠道确认。查询只读取退款结果，不会再次提交退款。</p>
        <button
          type="button"
          className="cashier-secondary-action"
          disabled={busyKey !== null}
          onClick={() => void onMutation(
            `refund-provider-query-${refund.id}`,
            `/api/refunds/${encodeURIComponent(refund.id)}/provider-query`,
            {},
            '已完成退款渠道查询，结果已按渠道回传更新。',
          )}
        >{busyKey === `refund-provider-query-${refund.id}` ? <LoaderCircle className="is-spinning" size={17} /> : null}查询退款渠道结果</button>
      </div>)}

    {drafting && <div className="cashier-refund-form">
      <h4>选择本次退款商品和金额</h4>
      {payment.refundableItems.map((item) => {
        const selected = refundDraft.amounts[item.id] !== undefined
        return <label className={`cashier-refund-item${selected ? ' is-selected' : ''}`} key={item.id}>
          <input
            type="checkbox"
            checked={selected}
            disabled={item.remainingRefundableMinor <= 0}
            onChange={() => onToggleRefundItem(item.id, item.remainingRefundableMinor)}
          />
          <span><b>{item.productName}</b><small>原实付 ¥{formatAmount(item.totalAmountMinor)} · 剩余可退 ¥{formatAmount(item.remainingRefundableMinor)}</small></span>
          {selected && <input
            type="text"
            inputMode="decimal"
            aria-label={`${item.productName}退款金额`}
            value={refundDraft.amounts[item.id] ?? ''}
            onChange={(event) => onRefundAmount(item.id, event.target.value)}
          />}
        </label>
      })}
      <label className="cashier-field"><span>退款原因</span><textarea value={refundDraft.reason} maxLength={1_000} placeholder="例如：商品未出品，客人取消" onChange={(event) => onRefundReason(event.target.value)} /></label>
      <div className="cashier-form-total"><span>本次发起</span><strong>¥{formatAmount(selectedTotal)}</strong></div>
      {selectedTotal > payment.remainingRefundableMinor && <p className="cashier-inline-error">所选金额超过该支付单剩余可退额。</p>}
      {drafting && Object.entries(refundDraft.amounts).some(([itemId, amount]) => {
        const amountMinor = yuanToMinor(amount)
        const item = payment.refundableItems.find((candidate) => candidate.id === itemId)
        return item === undefined || amountMinor === null || amountMinor <= 0 || amountMinor > item.remainingRefundableMinor
      }) && <p className="cashier-inline-error">单项退款金额必须大于0，且不能超过该商品剩余可退额。</p>}
      <div className="cashier-action-row">
        <button type="button" className="cashier-quiet-action" onClick={onCancelRefund}><X size={17} />取消</button>
        <button type="button" className="cashier-primary-action" disabled={!validRefund || busyKey !== null} onClick={() => void onSubmitRefund(payment)}>
          {busyKey === `refund-request-${payment.id}` ? <LoaderCircle className="is-spinning" size={17} /> : <Send size={17} />}提交退款
        </button>
      </div>
    </div>}

    {payment.refunds.map((refund) => <RefundBlock
      key={refund.id}
      refund={refund}
      payment={payment}
      auth={auth}
      actions={actions}
      busyKey={busyKey}
      decisionReason={decisionReasons[refund.id] ?? ''}
      manualReceipt={manualReceipts[refund.id] ?? ''}
      manualProvider={manualProvider}
      onDecisionReason={onDecisionReason}
      onManualReceipt={onManualReceipt}
      onMutation={onMutation}
    />)}
  </div>
}

function RefundBlock({
  refund,
  payment,
  auth,
  actions,
  busyKey,
  decisionReason,
  manualReceipt,
  manualProvider,
  onDecisionReason,
  onManualReceipt,
  onMutation,
}: {
  refund: CashierWorkbenchRefund
  payment: CashierWorkbenchPayment
  auth: StaffAuthView
  actions: CashierWorkbenchView['actions']
  busyKey: string | null
  decisionReason: string
  manualReceipt: string
  manualProvider: boolean
  onDecisionReason(refundId: string, reason: string): void
  onManualReceipt(refundId: string, receipt: string): void
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const [manualConfirmation, setManualConfirmation] = useState<'failed' | 'succeeded' | null>(null)
  const ownRequest = refund.requestedByEmployeeId === auth.employee.id
  const canDecide = refund.status === 'requested' && actions.canApproveRefund && !ownRequest
  const canBegin = (refund.status === 'approved'
    || (refund.status === 'processing' && refund.providerSubmissionState === 'not_started'))
    && actions.canExecuteRefund
  const canRecordManual = refund.status === 'processing' && actions.canExecuteRefund && manualProvider
  return <div className={`cashier-refund-row is-${refund.status}`}>
    <div className="cashier-refund-heading">
      <span><b>退款 ¥{formatAmount(refund.amountMinor)}</b><small>{refundStatusLabel(refund.status)} · {refund.requestedByEmployeeName}发起</small></span>
      <Clock3 size={17} />
    </div>
    <p>{refund.reason}</p>
    {refund.decisionReason && <small>复核说明：{refund.decisionReason}</small>}
    {refund.receiptReference && <small>退款凭证：{refund.receiptReference}</small>}

    {refund.status === 'requested' && ownRequest && <p className="cashier-guidance">发起人不能复核自己的退款，请交给收银处理。</p>}
    {refund.status === 'requested' && !actions.canApproveRefund && <p className="cashier-guidance">等待具备退款复核权限和额度的收银处理。</p>}
    {canDecide && <div className="cashier-decision-form">
      <label className="cashier-field"><span>复核说明</span><input value={decisionReason} placeholder="核对原支付、商品、金额和原因" onChange={(event) => onDecisionReason(refund.id, event.target.value)} /></label>
      <div className="cashier-action-row">
        <button
          type="button"
          className="cashier-danger-action"
          disabled={decisionReason.trim().length < 2 || busyKey !== null}
          onClick={() => void onMutation(
            `refund-reject-${refund.id}`,
            `/api/refunds/${encodeURIComponent(refund.id)}/reject`,
            { reason: decisionReason },
            '退款申请已驳回，可由申请人更正后重新提交。',
          )}
        ><X size={17} />复核驳回</button>
        <button
          type="button"
          className="cashier-primary-action"
          disabled={decisionReason.trim().length < 2 || busyKey !== null}
          onClick={() => void onMutation(
            `refund-approve-${refund.id}`,
            `/api/refunds/${encodeURIComponent(refund.id)}/approve`,
            { reason: decisionReason },
            '退款已复核通过，下一步仍需执行退款或等待支付渠道。',
          )}
        ><Check size={17} />复核通过</button>
      </div>
    </div>}

    {canBegin && <button
      type="button"
      className="cashier-primary-action is-full"
      disabled={busyKey !== null}
      onClick={() => void onMutation(
        `refund-execute-${refund.id}`,
        `/api/refunds/${encodeURIComponent(refund.id)}/execute`,
        {},
        manualProvider
          ? '已进入人工退款处理，请完成退款后登记独立凭证。'
          : '退款已进入待渠道处理，尚未证明渠道受理或退款成功。',
      )}
    >{busyKey === `refund-execute-${refund.id}` ? <LoaderCircle className="is-spinning" size={17} /> : <ReceiptText size={17} />}{manualProvider ? '开始人工退款' : '进入渠道待处理'}</button>}

    {refund.status === 'processing' && !manualProvider && payment.provider === 'postar'
      && refund.providerSubmissionState !== 'not_started' && actions.canExecuteRefund
      && <div className="cashier-provider-query">
        <button
          type="button"
          className="cashier-quiet-action"
          disabled={busyKey !== null}
          onClick={() => void onMutation(
            `refund-provider-query-${refund.id}`,
            `/api/refunds/${encodeURIComponent(refund.id)}/provider-query`,
            {},
            '已查询渠道退款结果。',
          )}
        >{busyKey === `refund-provider-query-${refund.id}` ? <LoaderCircle className="is-spinning" size={17} /> : <RefreshCcw size={17} />}查询渠道结果</button>
      </div>}
    {refund.status === 'processing' && !manualProvider && refund.providerSubmissionState !== 'not_started'
      && <p className="cashier-channel-pending">待支付渠道回传结果。本页不能把线上退款手工改成成功。</p>}
    {refund.status === 'processing' && !manualProvider && refund.providerSubmissionState === 'not_started'
      && <p className="cashier-guidance">上次提交支付渠道失败，可再次进入渠道待处理重试。</p>}

    {canRecordManual && <div className="cashier-manual-result">
      <label className="cashier-field"><span>{payment.provider === 'cash' ? '现金退款凭证号' : 'POS退款小票/交易号'}</span><input value={manualReceipt} placeholder="必须与原收款凭证分开" onChange={(event) => onManualReceipt(refund.id, event.target.value)} /></label>
      <div className="cashier-action-row">
        <button
          type="button"
          className="cashier-danger-action"
          disabled={manualReceipt.trim().length === 0 || busyKey !== null}
          onClick={() => setManualConfirmation('failed')}
        >登记失败</button>
        <button
          type="button"
          className="cashier-primary-action"
          disabled={manualReceipt.trim().length === 0 || busyKey !== null}
          onClick={() => setManualConfirmation('succeeded')}
        >登记已退</button>
      </div>
      {manualConfirmation !== null && <div className="cashier-manual-confirm" role="dialog" aria-modal="true" aria-label="确认人工退款结果">
        <strong>{manualConfirmation === 'succeeded' ? '确认款项已经实际退给客人？' : '确认本次人工退款没有完成？'}</strong>
        <p>{manualConfirmation === 'succeeded'
          ? `确认后将凭证“${manualReceipt.trim()}”写入退款账，不能只凭口头结果登记。`
          : '确认后本次处理会标记失败，不会占用已退款金额。'}</p>
        <div className="cashier-action-row">
          <button type="button" className="cashier-quiet-action" onClick={() => setManualConfirmation(null)}>返回核对</button>
          <button
            type="button"
            className={manualConfirmation === 'succeeded' ? 'cashier-primary-action' : 'cashier-danger-action'}
            disabled={busyKey !== null}
            onClick={() => {
              const succeeded = manualConfirmation === 'succeeded'
              setManualConfirmation(null)
              void onMutation(
                `refund-manual-${succeeded ? 'success' : 'failed'}-${refund.id}`,
                `/api/refunds/${encodeURIComponent(refund.id)}/manual-result`,
                { succeeded, receiptReference: manualReceipt },
                succeeded ? '人工退款凭证已登记并写入退款账。' : '已登记人工退款失败，金额未记入退款账。',
              )
            }}
          >{manualConfirmation === 'succeeded' ? '确认已实际退款' : '确认退款失败'}</button>
        </div>
      </div>}
    </div>}
  </div>
}

function yuanToMinor(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)) return null
  const [yuan, decimal = ''] = normalized.split('.')
  const amount = Number(yuan) * 100 + Number(decimal.padEnd(2, '0'))
  return Number.isSafeInteger(amount) ? amount : null
}

function orderHasRefundablePayment(order: CashierWorkbenchOrder): boolean {
  return order.payments.some((payment) => payment.remainingRefundableMinor > 0)
}

function orderRefundCounts(order: CashierWorkbenchOrder): { requested: number; processing: number } {
  let requested = 0
  let processing = 0
  for (const payment of order.payments) {
    for (const refund of payment.refunds) {
      if (refund.status === 'requested') requested += 1
      if (refund.status === 'approved' || refund.status === 'processing') processing += 1
    }
  }
  return { requested, processing }
}

function orderWorkflowGuidance(
  order: CashierWorkbenchOrder,
  actions: CashierWorkbenchView['actions'],
): string | null {
  const { requested, processing } = orderRefundCounts(order)
  if (processing > 0 && actions.canExecuteRefund) {
    return '这笔订单有退款待执行或待查渠道。请先在下方「收款与退款」处理，不要点顶部的「检查并结束」。'
  }
  if (requested > 0 && actions.canApproveRefund) {
    return '这笔订单有退款待收银复核。请先在下方「收款与退款」复核通过或驳回。'
  }
  if (order.paymentStatus === 'paid' && orderHasRefundablePayment(order) && actions.canRequestRefund) {
    return '已收款。请先在下方「收款与退款」点击「选择原商品发起退款」。'
  }
  if (order.paymentStatus === 'paid' && orderHasRefundablePayment(order) && !actions.canRequestRefund) {
    return '已收款。本岗位不能直接发起退款：请店长或服务员登录后在本页发起，再由收银复核并执行渠道退款。'
  }
  return null
}

function businessDayFactRouteAccess(actionRoute: string, permissions: readonly string[]): {
  allowed: boolean
  moduleLabel: string
} {
  const route = actionRoute.split('?')[0] ?? actionRoute
  const module = staffModuleForRoute(route)
  if (module === null) return { allowed: false, moduleLabel: '对应业务页面' }
  const effective = new Set(permissions)
  return {
    allowed: module.permissionCodes.some((permission) => effective.has(permission)),
    moduleLabel: module.label,
  }
}

export function businessDayFactNavigation(fact: BusinessDayBlockerFact):
  | { kind: 'cashier_order'; orderId: string; query: string }
  | { kind: 'route'; route: string; context: BusinessDayNavigationContext } {
  const target = new URL(fact.actionRoute, 'http://localhost')
  if (target.pathname === '/staff/payments' && fact.orderId !== null) return {
    kind: 'cashier_order',
    orderId: fact.orderId,
    query: fact.orderPublicId ?? fact.reference,
  }
  return { kind: 'route', route: fact.actionRoute, context: { businessDayBlockerFact: fact } }
}

function shortReference(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function formatAmount(value: number): string { return (Math.abs(value) / 100).toFixed(2) }
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
function providerLabel(value: string): string {
  return ({ postar: '星驿在线支付', wechat: '微信支付', cash: '现金', physical_pos: '实体POS', external_manual: '其他线下收款', simulation: '模拟支付' } as Record<string, string>)[value] ?? value
}
function manualCollectionLabel(provider: 'cash' | 'physical_pos' | 'external_manual'): string {
  return provider === 'cash' ? '登记现金收款' : provider === 'physical_pos' ? '登记实体POS收款' : '登记其他线下收款'
}
function manualCollectionAmountLabel(provider: 'cash' | 'physical_pos' | 'external_manual'): string {
  return provider === 'cash' ? '现金' : provider === 'physical_pos' ? 'POS款项' : '其他线下款项'
}
function paymentStatusLabel(value: string): string {
  return ({ created: '待提交', pending: '待支付', succeeded: '已收款', failed: '支付失败', closed: '已关闭', partially_refunded: '部分已退', refunded: '已全退', unpaid: '未支付', partially_paid: '部分支付', paid: '已支付' } as Record<string, string>)[value] ?? value
}
function refundStatusLabel(value: string): string {
  return ({ requested: '待收银复核', approved: '复核通过待执行', rejected: '复核驳回', processing: '处理中', succeeded: '已退款', failed: '退款失败', cancelled: '已取消' } as Record<string, string>)[value] ?? value
}
function itemStatusLabel(value: string): string {
  return ({ submitted: '已下单', accepted: '已接单', preparing: '制作中', ready: '待送达', delivered: '已送达', cancelled: '已取消' } as Record<string, string>)[value] ?? value
}
function kdsStatusLabel(value: CashierWorkbenchKdsTask['status']): string {
  return ({ pending: '待接单', accepted: '已接单未制作', preparing: '制作中', ready: '制作完成', cancelled: '已取消', failed: '制作异常' } as Record<CashierWorkbenchKdsTask['status'], string>)[value]
}
