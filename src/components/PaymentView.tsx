import {
  Banknote,
  CheckCircle2,
  CircleAlert,
  Clock3,
  CreditCard,
  FileCheck2,
  Landmark,
  LoaderCircle,
  ReceiptText,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  WalletCards,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import * as api from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import {
  PHYSICAL_POS_CHANNEL,
  type PaymentDomainState,
  type PaymentIntent,
  type PaymentIntentStatus,
  type Refund,
  type RefundStatus,
} from '../shared/payment-contracts'
import type { Order, OrderItem } from '../shared/order-contracts'
import './PaymentView.css'

interface PaymentViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
}

interface PaymentApi {
  createTablePaymentIntent: (tableSessionId: string, channel: string) => Promise<unknown>
  simulatePaymentSuccess: (paymentIntentId: string) => Promise<unknown>
  reportPhysicalPos: (
    paymentIntentId: string,
    terminalId: string,
    terminalTransactionId: string,
    paymentMethod: string,
    receiptReference: string,
  ) => Promise<unknown>
  requestItemRefund: (
    paymentIntentId: string,
    orderId: string,
    orderItemId: string,
    quantity: number,
    reason: string,
  ) => Promise<unknown>
  approveAndCompleteRefund: (refundId: string) => Promise<unknown>
}

type BootstrapWithPayments = BootstrapResponse & { paymentDomain?: PaymentDomainState }
type Notice = { tone: 'success' | 'error'; message: string }
type RefundDraft = { paymentIntentId: string; orderId: string; orderItemId: string; quantity: number; reason: string }

const paymentClient = api as unknown as PaymentApi
const ONLINE_SIMULATION_CHANNEL = 'wechat_mock'
const emptyPaymentDomain: PaymentDomainState = {
  paymentIntents: [],
  paymentNotifications: [],
  paymentStatusQueries: [],
  physicalPosReports: [],
  refunds: [],
  idempotencyRecords: [],
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

export function PaymentView({ data, onRefresh }: PaymentViewProps) {
  const paymentDomain = (data as BootstrapWithPayments).paymentDomain ?? emptyPaymentDomain
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [posIntentId, setPosIntentId] = useState('')
  const [terminalId, setTerminalId] = useState('POS-01')
  const [terminalTransactionId, setTerminalTransactionId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('银行卡')
  const [receiptReference, setReceiptReference] = useState('')
  const [refundDraft, setRefundDraft] = useState<RefundDraft | null>(null)

  const tableAccounts = useMemo(
    () => buildTableAccounts(data, paymentDomain.paymentIntents, paymentDomain.refunds),
    [data, paymentDomain.paymentIntents, paymentDomain.refunds],
  )
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

  async function execute(actionKey: string, successMessage: string, operation: () => Promise<unknown>) {
    setBusyAction(actionKey)
    setNotice(null)
    try {
      await operation()
      await onRefresh()
      setNotice({ tone: 'success', message: successMessage })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '收银操作失败，请重试' })
    } finally {
      setBusyAction('')
    }
  }

  function createIntent(tableSessionId: string, channel: string) {
    const channelLabel = channel === PHYSICAL_POS_CHANNEL ? '物理POS收款单' : '线上联调支付意图'
    void execute(`create:${tableSessionId}:${channel}`, `${channelLabel}已创建`, () =>
      paymentClient.createTablePaymentIntent(tableSessionId, channel),
    )
  }

  function simulateSuccess(intent: PaymentIntent) {
    void execute(`simulate:${intent.id}`, '联调模拟回调已完成，不代表真实资金入账', () =>
      paymentClient.simulatePaymentSuccess(intent.id),
    )
  }

  function submitPhysicalPos(event: FormEvent) {
    event.preventDefault()
    if (!effectivePosIntentId || !terminalTransactionId.trim()) {
      setNotice({ tone: 'error', message: '请选择支付意图并填写POS交易流水号' })
      return
    }
    void execute(`pos:${effectivePosIntentId}`, 'POS收款已人工报送，当前状态为待对账', async () => {
      await paymentClient.reportPhysicalPos(
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
      await paymentClient.requestItemRefund(
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
      paymentClient.approveAndCompleteRefund(refund.id),
    )
  }

  return (
    <section className="payment-view">
      <header className="payment-heading">
        <div>
          <span className="eyebrow">桌账、支付、退款与对账</span>
          <h2>收银工作台</h2>
        </div>
        <span className="payment-mode"><CircleAlert size={15} />真实微信支付尚未接入</span>
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

      <section className="cashier-section table-account-section">
        <SectionTitle icon={ReceiptText} eyebrow="按桌次归集" title="未收款订单" meta={`${tableAccounts.length}个桌次`} />
        <div className="table-account-list">
          {tableAccounts.length === 0 && <EmptyState icon={FileCheck2} text="当前没有可收款桌账" />}
          {tableAccounts.map((account) => (
            <article className="table-account-row" key={account.tableSessionId}>
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
              <div className="table-account-orders">
                {account.orders.map((order) => (
                  <div className="order-summary" key={order.id}>
                    <span>订单 {shortId(order.id)}</span>
                    <strong>{order.items.map((item) => `${item.name}×${item.quantity}`).join('、')}</strong>
                    <b>{money(order.amounts.payableAmount)}</b>
                  </div>
                ))}
              </div>
              <div className="table-account-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => createIntent(account.tableSessionId, ONLINE_SIMULATION_CHANNEL)}
                >
                  {busyAction === `create:${account.tableSessionId}:${ONLINE_SIMULATION_CHANNEL}` ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
                  生成线上联调单
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={account.collectableAmount <= 0 || Boolean(busyAction)}
                  onClick={() => createIntent(account.tableSessionId, PHYSICAL_POS_CHANNEL)}
                >
                  <CreditCard size={16} />生成POS收款单
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="payment-work-grid">
        <section className="cashier-section intent-section">
          <SectionTitle icon={Landmark} eyebrow="逐笔追踪商品分摊" title="支付意图" meta={`${paymentDomain.paymentIntents.length}笔`} />
          <div className="payment-intent-list">
            {paymentDomain.paymentIntents.length === 0 && <EmptyState icon={ReceiptText} text="尚未创建支付意图" />}
            {paymentDomain.paymentIntents.toReversed().map((intent) => (
              <PaymentIntentRow
                key={intent.id}
                data={data}
                intent={intent}
                busyAction={busyAction}
                onSimulate={simulateSuccess}
                onRefund={(draft) => setRefundDraft(draft)}
              />
            ))}
          </div>
        </section>

        <section className="cashier-section pos-section">
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
        </section>
      </div>

      <section className="cashier-section refund-section">
        <SectionTitle icon={RefreshCcw} eyebrow="按原支付商品追溯" title="商品退款与审批" meta={`${pendingRefunds.length}笔待审批`} />
        {refundDraft && (
          <form className="refund-request-form" onSubmit={submitRefund}>
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
          {paymentDomain.refunds.toReversed().map((refund) => (
            <article className="refund-row" key={refund.id}>
              <div className="refund-status">
                <span className={`payment-status status-${refund.status}`}>{refundStatusLabels[refund.status]}</span>
                <small>{formatTime(refund.requestedAt)}</small>
              </div>
              <div className="refund-details">
                <strong>{refund.items.map((item) => `${refundItemLabel(data, item.orderId, item.orderItemId)}×${item.quantity}`).join('、')}</strong>
                <span>{refund.reason} · 申请人 {refund.requestedBy}</span>
              </div>
              <b>{money(refund.amount)}</b>
              {refund.status === 'requested' && (
                <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={() => approveRefund(refund)}>
                  {busyAction === `refund-approve:${refund.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
                  审批并完成
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}

function PaymentIntentRow({ data, intent, busyAction, onSimulate, onRefund }: {
  data: BootstrapResponse
  intent: PaymentIntent
  busyAction: string
  onSimulate: (intent: PaymentIntent) => void
  onRefund: (draft: RefundDraft) => void
}) {
  const table = tableFromSession(data, intent.tableSessionId)
  const isSimulation = intent.channel === ONLINE_SIMULATION_CHANNEL
  const canRefund = intent.status === 'succeeded'
  return (
    <article className="payment-intent-row">
      <div className="intent-overview">
        <span className={`payment-status status-${intent.status}`}>{intentStatusLabels[intent.status]}</span>
        <div><strong>{table?.code ?? shortId(intent.tableSessionId)} · {money(intent.amount)}</strong><small>{isSimulation ? '微信支付联调模拟器' : intent.channel === PHYSICAL_POS_CHANNEL ? '物理POS' : intent.channel}</small></div>
        <time>{formatTime(intent.createdAt)}</time>
      </div>
      <div className="intent-lines">
        {intent.lineAllocations.map((line) => {
          const item = findOrderItem(data, line.orderId, line.orderItemId)
          return (
            <div className="intent-line" key={`${intent.id}:${line.orderItemId}`}>
              <span><strong>{item?.name ?? line.orderItemId}</strong><small>{item?.specification || `订单 ${shortId(line.orderId)}`}</small></span>
              <span>{line.quantity}份 × {money(line.unitPaidAmount)}</span>
              <b>{money(line.paidAmount)}</b>
              {canRefund && (
                <button className="secondary-button" type="button" onClick={() => onRefund({ paymentIntentId: intent.id, orderId: line.orderId, orderItemId: line.orderItemId, quantity: 1, reason: '' })}>
                  <RotateCcw size={14} />按商品退款
                </button>
              )}
            </div>
          )
        })}
      </div>
      {isSimulation && intent.status === 'pending' && (
        <div className="simulation-action">
          <div><CircleAlert size={16} /><span><strong>仅供接口联调</strong>此操作生成模拟成功回调，不发生真实扣款或资金结算。</span></div>
          <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => onSimulate(intent)}>
            {busyAction === `simulate:${intent.id}` ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
            模拟支付成功
          </button>
        </div>
      )}
    </article>
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
  for (const order of data.orderDomain.orders) {
    if (order.status === 'draft' || order.status === 'authorization_pending') continue
    const orders = ordersBySession.get(order.tableSessionId) ?? []
    orders.push(order)
    ordersBySession.set(order.tableSessionId, orders)
  }
  const activeIntents = intents.filter((intent) => !['failed', 'closed'].includes(intent.status))
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
    return {
      tableSessionId,
      tableCode: table?.code ?? '未知桌台',
      tableName: table?.displayName ?? '未匹配桌台',
      orders,
      totalAmount,
      reservedAmount,
      collectableAmount: Math.max(0, totalAmount - allocatedAmount),
    }
  }).filter((account) => account.totalAmount > 0)
}

function tableFromSession(data: BootstrapResponse, tableSessionId: string) {
  return data.tables.find((table) => tableSessionId.startsWith(`session:${table.id}:`))
}

function findOrderItem(data: BootstrapResponse, orderId: string, orderItemId: string): OrderItem | undefined {
  return data.orderDomain.orders.find((order) => order.id === orderId)?.items.find((item) => item.id === orderItemId)
}

function refundItemLabel(data: BootstrapResponse, orderId: string, orderItemId: string) {
  return findOrderItem(data, orderId, orderItemId)?.name ?? `商品 ${shortId(orderItemId)}`
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}

function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
