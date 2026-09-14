import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import type { StockCountReview, StockCountReviewPage } from '../shared/inventory-stock-count'
import { inventoryEmployeeUnit, inventoryQuantityForEmployee, formatInventoryQuantityWithUnit } from './inventory-presentation'
import { executeRecoverableCommand } from './recoverable-command'
import { useConfirmationDialog } from './ConfirmationDialog'
import './inventory-stock-count.css'

export function InventoryStockCountPanel({ api, auth, refreshToken, onChanged, onRecount }: {
  api: NormalizedApiClient; auth: StaffAuthView; refreshToken: unknown; onChanged(): Promise<void>
  onRecount?(inventoryItemId: string): void
}) {
  const [status, setStatus] = useState<'submitted' | 'processed'>('submitted')
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0)
  const [data, setData] = useState<StockCountReviewPage | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), locked = useRef(false)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const { confirmAction } = useConfirmationDialog()
  useEffect(() => {
    let active = true
    setLoading(true); setData(null); setError('')
    void api.getEndpoint<{ data: StockCountReviewPage }>(`/api/inventory/stock-counts?status=${status}&page=${page}`)
      .then(result => { if (active) setData(result.data) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '盘点记录读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, auth.employee.id, status, page, revision, refreshToken])

  async function decide(count: StockCountReview, action: 'approve' | 'reject') {
    if (locked.current || !count.canReview) return
    const reason = (reasons[count.id] ?? '').trim()
    if (action === 'reject' && reason.length < 2) { setNotice('请填写至少2字的退回原因'); return }
    locked.current = true; setBusy(true)
    try {
      if (action === 'approve' && !(await confirmAction({ title: '确认盘点差异',
        description: `请核对${count.createdByName}提交的${count.lines.length}项实盘数量。通过后将按差异调整库存；盘点后库存有变动时会拒绝生效。`,
        confirmLabel: '核对通过' }))) return
      const body = action === 'reject' ? { reason } : {}
      await executeRecoverableCommand(`inventory-count-review:${auth.employee.id}:${count.id}:${action}`, body,
        `inventory-review-${crypto.randomUUID()}`, key => api.postEndpoint(`/api/inventory/stock-counts/${count.id}/${action}`, body, { idempotencyKey: key }))
      setNotice(action === 'approve' ? '盘点已审核通过，库存已按差异更新' : '盘点已退回，库存未改变')
      setReasons(current => { const next = { ...current }; delete next[count.id]; return next })
      setRevision(value => value + 1)
      await onChanged()
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '审核结果尚未确认，请刷新核对；再次操作沿用原请求')
      setRevision(value => value + 1)
    } finally { locked.current = false; setBusy(false) }
  }

  return <section className="inventory-stock-counts" aria-label="盘点复核">
    <header><h2>盘点复核</h2><button type="button" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>刷新盘点</button></header>
    <p>{data?.canApprove ? '请逐单核对实盘数量；本人提交的盘点须由另一名有审批权限的同事复核。' : '这里显示本人提交的盘点。请由有盘点审批权限的同事在“库存 → 盘点复核”处理。'}</p>
    <nav aria-label="盘点状态">
      <button type="button" disabled={busy} aria-pressed={status === 'submitted'} onClick={() => { setStatus('submitted'); setPage(0) }}>待复核</button>
      <button type="button" disabled={busy} aria-pressed={status === 'processed'} onClick={() => { setStatus('processed'); setPage(0) }}>已处理</button>
    </nav>
    {loading && <p role="status">正在读取盘点记录</p>}
    {error && <p role="alert">{error}，请点“刷新盘点”重试。</p>}
    {notice && <p role="status">{notice}</p>}
    {!loading && data?.counts.length === 0 && <p>{status === 'submitted' ? '当前没有待复核盘点' : '当前没有已处理盘点'}</p>}
    {data?.counts.map(count => <article key={count.id} aria-label={`盘点 ${count.publicId}`}>
      <header><strong>{count.createdByName}的盘点</strong><span>{count.status === 'submitted' ? '待复核' : count.status === 'approved' ? '已通过' : '已退回'}</span></header>
      <small>{count.publicId} · 提交于{dateTime(count.submittedAt)}</small>
      {count.note && <p>{count.note}</p>}
      {count.lines.map(line => <div className="inventory-stock-count-line" key={line.inventoryItemId}>
        <strong>{line.itemName}</strong>
        <span>盘点时账面 {quantity(line.systemQuantity, line)} · 实盘 {quantity(line.countedQuantity, line)}</span>
        <span>差异 {quantity(line.varianceQuantity, line)} · 当前账面 {quantity(line.currentQuantity, line)}</span>
        {line.reason && <span>说明：{line.reason}</span>}
        {line.stale && <p className="staff-module-warning">盘点后库存已变动，不能直接通过；{count.canReview ? '请退回后由盘点人重新清点提交。' : '请联系其他有审批权限的同事退回，再重新清点提交。'}</p>}
        {count.status === 'rejected' && onRecount && <button type="button" disabled={busy || loading} onClick={() => onRecount(line.inventoryItemId)}>重新盘点：{line.itemName}</button>}
      </div>)}
      {count.status === 'submitted' && !count.canReview && <p>{count.createdByEmployeeId === auth.employee.id ? '本人提交，等待其他有审批权限的同事复核。' : '当前账号没有此盘点的审批权限。'}</p>}
      {count.canReview && <div className="inventory-stock-count-actions">
        <button type="button" disabled={busy || loading || count.lines.some(line => line.stale)} onClick={() => void decide(count, 'approve')}>审核通过</button>
        <label>退回原因<input maxLength={1000} disabled={busy} value={reasons[count.id] ?? ''} onChange={event => setReasons(current => ({ ...current, [count.id]: event.target.value }))} /></label>
        <button type="button" disabled={busy || loading} onClick={() => void decide(count, 'reject')}>退回盘点</button>
      </div>}
      {count.decidedAt && <p>{count.decidedByName} · {dateTime(count.decidedAt)} · {count.decisionReason}</p>}
    </article>)}
    <nav aria-label="盘点分页"><button type="button" disabled={loading || busy || page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>第{page + 1}页</span><button type="button" disabled={loading || busy || !data?.hasMore} onClick={() => setPage(value => value + 1)}>下一页</button></nav>
  </section>
}

function dateTime(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }
function quantity(value: string, line: StockCountReview['lines'][number]) {
  const negative = value.startsWith('-')
  const converted = inventoryQuantityForEmployee(negative ? value.slice(1) : value, line.categoryCode, line.baseUnit, line.packageVolumeMl)
  return formatInventoryQuantityWithUnit(converted === null ? value : `${negative ? '-' : ''}${converted}`,
    converted === null ? line.baseUnit : inventoryEmployeeUnit(line.categoryCode, line.baseUnit))
}
