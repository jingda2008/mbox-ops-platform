import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import type { LoyaltyRefundReviewItem, LoyaltyRefundReviewCommandResult, LoyaltyRefundReviewRequestView, LoyaltyRefundReviewView } from '../shared/loyalty-refund-review'
import { canSendRefundReview, LoyaltyRefundReviewRecovery, refundReviewPermissions, refundReviewRequestBody, reviewDefinitelyNotCommitted, type RefundReviewCommand, type RefundReviewIntent } from './loyalty-refund-review-recovery'

export function LoyaltyRefundReviewPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  if (!refundReviewPermissions(auth.permissions).view) return null
  return <RefundReviewWorkspace key={`${auth.employee.id}:${auth.session.id}`} api={api} auth={auth} />
}
function RefundReviewWorkspace({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const [rows, setRows] = useState<LoyaltyRefundReviewView[]>([])
  const [scopeKey, setScopeKey] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  const [pending, setPending] = useState<RefundReviewIntent | null>(null)
  const [storageError, setStorageError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true), revision = useRef(0), flight = useRef(false), currentAuth = useRef(auth)
  currentAuth.current = auth
  const access = refundReviewPermissions(auth.permissions)
  const load = useCallback(async (expectedScopeKey?: string) => {
    const turn = ++revision.current
    setPhase('loading')
    try {
      const response = await api.getEndpoint<{ data: LoyaltyRefundReviewView[]; meta: { scopeKey: string } }>('/api/staff/loyalty/refund-reviews')
      if (!alive.current || turn !== revision.current) throw new Error('读取已中断，请保留原操作后恢复')
      if (!Array.isArray(response.data) || typeof response.meta?.scopeKey !== 'string' || !response.meta.scopeKey) throw new Error('退款核对数据不完整，请重新读取')
      if (expectedScopeKey && response.meta.scopeKey !== expectedScopeKey) throw new Error('门店范围已改变，请切回原门店核对原操作')
      setRows(response.data); setScopeKey(response.meta.scopeKey); setPhase('ready')
      try { setPending(new LoyaltyRefundReviewRecovery(response.meta.scopeKey, auth.employee.id, localStorage).pending()); setStorageError('') }
      catch (error) { setStorageError(message(error)) }
    } catch (error) {
      if (alive.current && turn === revision.current) {
        const forbidden = [401, 403].includes((error as { status?: number })?.status ?? 0)
        if (forbidden) { setRows([]); setPending(null); setScopeKey(''); setStorageError('') }
        setPhase(forbidden ? 'forbidden' : 'error'); setNotice(message(error))
      }
      throw error
    }
  }, [api, auth.employee.id])
  useEffect(() => { alive.current = true; void load().catch(() => {}); return () => { alive.current = false } }, [load])

  async function execute(command: RefundReviewCommand | null) {
    if (flight.current || !scopeKey || storageError || phase === 'forbidden') return
    flight.current = true; setBusy(true); setNotice('')
    let recovery: LoyaltyRefundReviewRecovery | null = null
    try {
      recovery = new LoyaltyRefundReviewRecovery(scopeKey, auth.employee.id, localStorage)
      const result = await recovery.execute(command, currentAuth.current.permissions, intent => {
        if (!alive.current || !canSendRefundReview(intent, currentAuth.current.employee.id, currentAuth.current.permissions)) throw new Error('当前员工权限已改变，请恢复原员工授权后核对')
        setPending(intent)
        const path = intent.kind === 'request'
          ? `/api/staff/loyalty/refund-reviews/${encodeURIComponent(intent.refundId)}/requests`
          : `/api/staff/loyalty/refund-review-requests/${encodeURIComponent(intent.requestId)}/decisions`
        return api.postEndpoint<LoyaltyRefundReviewCommandResult>(path, intent.body, { idempotencyKey: intent.key, timeoutMs: 20_000 }).then(data => ({ data }))
      }, () => load(scopeKey))
      if (alive.current) setNotice(result.status === 'approved' ? `复核已入账：积分变动 ${result.pointsDelta}，成长值变动 ${result.growthDelta}；当前退款状态已重新读取。` : result.status === 'rejected' ? '原申请已驳回并留存记录，退款仍须重新核对。' : '申请已确认，等待另一名授权人员复核；积分与成长值尚未冲回。')
    } catch (error) {
      if (alive.current) {
        if ([401, 403].includes((error as { status?: number })?.status ?? 0)) { setRows([]); setPending(null); setScopeKey(''); setPhase('forbidden'); setNotice('当前登录或权限无法核验，请恢复原员工授权后读取；原操作记录保留。') }
        else if (reviewDefinitelyNotCommitted(error)) { setNotice(`${message(error)}；服务端已确认本次操作未写入，请重新核对当前退款。`); await load().catch(() => {}) }
        else setNotice(`${message(error)}；操作结果尚未确认，请恢复原操作，不要重新提交同一事项。`)
      }
    } finally {
      if (alive.current) {
        try { setPending(recovery?.pending() ?? null) } catch (error) { setStorageError(message(error)) }
        setBusy(false)
      }
      flight.current = false
    }
  }
  if (phase === 'forbidden') return <section className="staff-module-summary" aria-label="退款积分核对"><p role="alert">{notice}</p><button type="button" onClick={() => void load().catch(() => {})}>重新核验当前权限</button></section>
  return <section id="loyalty-refund-reviews" className="staff-module-summary loyalty-policy-panel" aria-label="退款积分核对"><div>
    <strong>退款积分与成长值核对</strong>
    <small>财务按真实退货商品填写销售退款明细，由另一名授权人员复核。系统按原计分资格和规则冲回；真实超收退回不扣奖励。</small>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {storageError && <p role="alert">{storageError}；记录恢复前暂停提交。</p>}
    <button type="button" disabled={busy || phase === 'loading'} onClick={() => void load().catch(() => {})}>{phase === 'loading' ? '正在核对' : '刷新退款核对记录'}</button>
    {pending && <section aria-label="原退款核对操作待恢复"><p>退款 {pending.refundPublicId} 的原{pending.kind === 'request' ? '申请' : '复核'}结果待确认。已保留原明细、核对依据与操作凭据。</p>
      <button type="button" disabled={busy || !canSendRefundReview(pending, auth.employee.id, auth.permissions)} onClick={() => void execute(null)}>{busy ? '正在核对原结果' : '恢复原操作结果'}</button>
      {!canSendRefundReview(pending, auth.employee.id, auth.permissions) && <p>请恢复原员工对应授权后核对，不能改由另一员工重放。</p>}
    </section>}
    {phase === 'ready' && rows.length === 0 && <p>当前没有退款积分待核记录。</p>}
    <div className="activity-admin-list">{rows.map(row => <RefundReviewCard key={`${row.refundId}:${row.basisVersion}`} review={row} employeeId={auth.employee.id} canRequest={access.request} canApprove={access.approve} disabled={busy || !!pending || !!storageError || phase !== 'ready'} execute={execute} />)}</div>
  </div></section>
}
function RefundReviewCard({ review, employeeId, canRequest, canApprove, disabled, execute }: {
  review: LoyaltyRefundReviewView; employeeId: string; canRequest: boolean; canApprove: boolean; disabled: boolean; execute(command: RefundReviewCommand): Promise<void>
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({}), [historicalAmounts, setHistoricalAmounts] = useState<Record<string, Record<string, string>>>({}), [reason, setReason] = useState(''), [error, setError] = useState('')
  const currentRequest = review.requests.some(request => request.status === 'requested' && request.basisVersion === review.basisVersion)
  async function request(event: FormEvent) {
    event.preventDefault(); if (disabled) return
    try { const body = refundReviewRequestBody(review, amounts, reason, historicalAmounts); setError(''); await execute({ kind: 'request', refundId: review.refundId, refundPublicId: review.refundPublicId, body }) }
    catch (error) { setError(message(error)) }
  }
  return <article><div style={{ minWidth: 0, width: '100%' }}>
    <strong>{review.refundPublicId} · {review.status === 'resolved' ? '已核对入账' : '财务待核'}</strong><small>原订单 {review.orderPublicId}</small>
    <p>本笔退款 {money(review.refundAmountMinor, review.currency)}；其中真实超收 {money(review.excessAmountMinor, review.currency)}；需明确商品的销售退款 {money(review.salesRefundAmountMinor, review.currency)}。</p>
    {review.blockingRefundPublicId && <p role="status">请先处理同一订单的退款 {review.blockingRefundPublicId}，然后重新读取本笔。</p>}
    {canRequest && review.status === 'pending' && !currentRequest && !review.blockingRefundPublicId && <form className="staff-module-form" onSubmit={event => void request(event)}>
      <fieldset disabled={disabled}><legend>选择实际退货商品与对应退款金额</legend>
      {review.salesRefundAmountMinor > 0 ? <AllocationFields items={review.items} currency={review.currency} amounts={amounts} onChange={setAmounts} /> : <p>本笔属于真实超收退回，无需选择退货商品，不扣奖励；仍由另一人核对原收款依据。</p>}
      {review.historicalRefunds.map(history => <fieldset key={history.refundId}><legend>历史退款 {history.refundPublicId} 归属补证</legend>
        <p>原退款 {money(history.refundAmountMinor, review.currency)}，其中超收 {money(history.excessAmountMinor, review.currency)}；本组商品金额须合计 {money(history.salesRefundAmountMinor, review.currency)}。只补原销售退款归属，不再次退款或扣奖。</p>
        <AllocationFields items={history.items} currency={review.currency} amounts={historicalAmounts[history.refundId] ?? {}} onChange={next => setHistoricalAmounts(current => ({ ...current, [history.refundId]: next }))} />
      </fieldset>)}
      <label>核对依据<textarea minLength={3} maxLength={1000} required value={reason} onChange={event => setReason(event.target.value)} placeholder="说明真实退货商品、金额及核对依据" /></label>
      {error && <p role="alert">{error}</p>}<button type="submit">提交分摊申请，交另一人复核</button></fieldset>
    </form>}
    {review.requests.map(request => <ReviewRequest key={request.requestId} request={request} review={review} employeeId={employeeId} canApprove={canApprove} disabled={disabled} execute={execute} />)}
  </div></article>
}
function ReviewRequest({ request, review, employeeId, canApprove, disabled, execute }: {
  request: LoyaltyRefundReviewRequestView; review: LoyaltyRefundReviewView; employeeId: string; canApprove: boolean; disabled: boolean; execute(command: RefundReviewCommand): Promise<void>
}) {
  const [reason, setReason] = useState(''), [error, setError] = useState('')
  const actionable = ['requested', 'stale'].includes(request.status) && review.status === 'pending'
  const stale = request.status === 'stale' || request.basisVersion !== review.basisVersion
  async function decide(decision: 'approve' | 'reject') {
    if (disabled || !canApprove || request.requestedByEmployeeId === employeeId) return
    if (reason.trim().length < 3 || reason.trim().length > 1000) return setError('复核说明请填写3至1000字')
    setError(''); await execute({ kind: 'decision', refundId: review.refundId, refundPublicId: review.refundPublicId, requestId: request.requestId, requestedByEmployeeId: request.requestedByEmployeeId, body: { basisVersion: request.basisVersion, decision, reason: reason.trim() } })
  }
  return <section aria-label={`分摊申请 ${request.requestId}`}>
    <strong>{statusLabel(request.status)} · 申请人 {request.requestedByName}</strong><small>{new Date(request.createdAt).toLocaleString('zh-CN')} · {request.reason}</small>
    <ul>{request.allocations.map(item => <li key={item.orderItemId}>{review.items.find(row => row.orderItemId === item.orderItemId)?.productName ?? '原订单商品'}：{money(item.salesRefundAmountMinor, review.currency)}</li>)}</ul>
    {(request.historicalAllocations ?? []).map(history => <div key={history.refundId}><small>历史退款 {review.historicalRefunds.find(row => row.refundId === history.refundId)?.refundPublicId ?? history.refundId} 归属补证（不重复扣奖）</small><ul>{history.allocations.map(item => <li key={item.orderItemId}>{review.items.find(row => row.orderItemId === item.orderItemId)?.productName ?? '原订单商品'}：{money(item.salesRefundAmountMinor, review.currency)}</li>)}</ul></div>)}
    {request.decisionReason && <p>{request.decidedByName}：{request.decisionReason}</p>}
    {actionable && stale && <p>付款或退款事实已变化，本申请不能批准。请驳回或按刷新后的明细重新申请。</p>}
    {actionable && request.requestedByEmployeeId === employeeId && <p>这是本人申请，请由另一名具备财务及会员复核权限的员工处理。</p>}
    {actionable && canApprove && request.requestedByEmployeeId !== employeeId && <fieldset disabled={disabled}><legend>异人复核</legend>
      <label>复核说明<textarea minLength={3} maxLength={1000} required value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p>批准后按所选商品的原计分资格冲回积分与成长值；本操作不再次发起退款。</p>
      {error && <p role="alert">{error}</p>}<button type="button" disabled={stale || !!review.blockingRefundPublicId} onClick={() => void decide('approve')}>确认商品分摊并冲回奖励</button><button type="button" onClick={() => void decide('reject')}>驳回此申请</button>
    </fieldset>}
  </section>
}
function AllocationFields({ items, currency, amounts, onChange }: { items: LoyaltyRefundReviewItem[]; currency: string; amounts: Record<string, string>; onChange(next: Record<string, string>): void }) {
  return <>{items.map(item => <div key={item.orderItemId}>
    <label><input type="checkbox" checked={Object.hasOwn(amounts, item.orderItemId)} disabled={item.maxSalesReturnAmountMinor <= 0} onChange={event => { const next = { ...amounts }; if (event.target.checked) next[item.orderItemId] = ''; else delete next[item.orderItemId]; onChange(next) }} />{item.productName} · 原数量 {item.quantity} · {item.loyaltyEligible ? '原单可计分' : '原单不计分'}</label>
    <small>原退款分摊 {money(item.refundAllocatedAmountMinor, currency)}；当前商品退款上限 {money(item.maxSalesReturnAmountMinor, currency)}</small>
    {Object.hasOwn(amounts, item.orderItemId) && <label>{item.productName} 销售退款金额（元）<input inputMode="decimal" value={amounts[item.orderItemId]} onChange={event => onChange({ ...amounts, [item.orderItemId]: event.target.value })} placeholder="填写实际金额" required /></label>}
  </div>)}</>
}
function statusLabel(status: LoyaltyRefundReviewRequestView['status']) { return ({ requested: '等待复核', approved: '已批准入账', rejected: '已驳回', stale: '事实已变化', superseded: '已由后续申请接续' })[status] }
function money(value: number, currency: string) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value / 100) }
function message(error: unknown) { return error instanceof Error ? error.message : '退款核对结果暂时无法读取' }
