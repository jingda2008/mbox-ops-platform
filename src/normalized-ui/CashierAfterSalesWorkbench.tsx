import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  LoaderCircle,
  ReceiptText,
  Search,
  Send,
  X,
} from 'lucide-react'
import type {
  CashierWorkbenchPayment,
  CashierWorkbenchRefund,
  CashierWorkbenchView,
} from '../shared/cashier-workbench-contracts'
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

export function CashierAfterSalesWorkbench({ api, auth, onLoginRequired, refreshToken }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  onLoginRequired(): void
  refreshToken: number
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [view, setView] = useState<CashierWorkbenchView | null>(null)
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<WorkbenchNotice | null>(null)
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

  return <CashierAfterSalesWorkbenchView
    auth={auth}
    view={view}
    phase={phase}
    message={message}
    busyKey={busyKey}
    notice={notice}
    noticeRef={noticeRef}
    onSearch={setQuery}
    onReload={() => void load(query)}
    onMutation={mutate}
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
  initialExpandedOrderId = null,
  onSearch,
  onReload,
  onMutation,
}: {
  auth: StaffAuthView
  view: CashierWorkbenchView | null
  phase: 'loading' | 'ready' | 'error'
  message: string | null
  busyKey: string | null
  notice: WorkbenchNotice | null
  noticeRef?: RefObject<HTMLDivElement | null>
  initialExpandedOrderId?: string | null
  onSearch(query: string): void
  onReload(): void
  onMutation(key: string, endpoint: string, body: unknown, successMessage: string): Promise<boolean>
}) {
  const [searchDraft, setSearchDraft] = useState(view?.query ?? '')
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(initialExpandedOrderId)
  const [refundDraft, setRefundDraft] = useState<RefundDraft | null>(null)
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({})
  const [manualReceipts, setManualReceipts] = useState<Record<string, string>>({})

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

  if (phase === 'loading' && view === null) {
    return <div className="cashier-workbench-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在读取本营业日订单</strong></div>
  }
  if (phase === 'error' && view === null) {
    return <div className="cashier-workbench-state is-error" role="alert"><CircleAlert /><strong>暂时没有接上收银数据</strong><p>{message}</p><button type="button" onClick={onReload}>重试</button></div>
  }
  if (view === null) return null

  return <div className="cashier-workbench">
    {notice && <div ref={noticeRef} className={`cashier-workbench-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      {notice.kind === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}
      <span>{notice.text}</span>
    </div>}

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
      <span className={view.summary.requestedRefundCount > 0 ? 'has-attention' : ''}><b>{view.summary.requestedRefundCount}</b><small>待复核</small></span>
      <span className={view.summary.processingRefundCount > 0 ? 'has-attention' : ''}><b>{view.summary.processingRefundCount}</b><small>待执行</small></span>
      {(view.summary.carryoverOrderCount ?? 0) > 0 && <span className="has-attention"><b>{view.summary.carryoverOrderCount}</b><small>交班遗留</small></span>}
    </div>

    {view.orders.length === 0
      ? <div className="cashier-workbench-state"><ReceiptText /><strong>{view.query ? '没有找到对应订单' : '本营业日暂无可处理订单'}</strong><p>可按桌号、订单号、支付单号或退款单号查找。</p></div>
      : <div className="cashier-order-list">
          {view.orders.map((order) => {
            const expanded = expandedOrderId === order.id
            return <article className="cashier-order" key={order.id}>
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
                {order.carryover && <p className="cashier-guidance">这是前一营业日尚未闭环的退款事项；处理结果继续记在原订单，不会并入今日营业额。</p>}
                <section>
                  <h3>原订单商品</h3>
                  {order.items.map((item) => <div className="cashier-line" key={item.id}>
                    <span><b>{item.productName}</b><small>{item.quantity} 件 · {itemStatusLabel(item.status)}</small></span>
                    <strong>¥{formatAmount(item.totalAmountMinor)}</strong>
                  </div>)}
                </section>
                <section>
                  <h3>收款与退款</h3>
                  {order.payments.length === 0
                    ? <p className="cashier-guidance">该订单尚无支付记录，不能申请退款。</p>
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
                </section>
              </div>}
            </article>
          })}
        </div>}

    <p className="cashier-workbench-boundary">线上退款只有支付渠道回传成功后才入账；现金和实体POS必须登记独立退款凭证。</p>
  </div>
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
  const manualProvider = payment.provider === 'cash' || payment.provider === 'physical_pos'
  return <div className="cashier-payment-block">
    <div className="cashier-payment-heading">
      <span><b>{providerLabel(payment.provider)}</b><small>{shortReference(payment.publicId)} · {paymentStatusLabel(payment.status)}</small></span>
      <span><strong>¥{formatAmount(payment.amountMinor)}</strong><small>剩余可退 ¥{formatAmount(payment.remainingRefundableMinor)}</small></span>
    </div>

    {actions.canRequestRefund && payment.remainingRefundableMinor > 0 && !drafting && <button type="button" className="cashier-secondary-action" onClick={() => onOpenRefund(payment)}>
      选择原商品发起退款
    </button>}

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
  const canBegin = refund.status === 'approved' && actions.canExecuteRefund
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

    {refund.status === 'processing' && !manualProvider && <p className="cashier-channel-pending">待支付渠道回传结果。本页不能把线上退款手工改成成功。</p>}

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
                { succeeded, receiptReference: manualReceipt, occurredAt: new Date().toISOString() },
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

function shortReference(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function formatAmount(value: number): string { return (Math.abs(value) / 100).toFixed(2) }
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
function providerLabel(value: string): string {
  return ({ postar: '星驿在线支付', wechat: '微信支付', cash: '现金', physical_pos: '实体POS', simulation: '模拟支付' } as Record<string, string>)[value] ?? value
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
