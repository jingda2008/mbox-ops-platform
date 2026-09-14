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
  const [selected, setSelected] = useState<string[]>([])
  const [batchReason, setBatchReason] = useState('')
  const [results, setResults] = useState<Array<{ id: string; label: string; message: string }>>([])
  const { confirmAction } = useConfirmationDialog()
  useEffect(() => {
    let active = true
    setLoading(true); setData(null); setError(''); setSelected([])
    void api.getEndpoint<{ data: StockCountReviewPage }>(`/api/inventory/stock-counts?status=${status}&page=${page}`)
      .then(result => { if (active) setData(result.data) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '盘点记录读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, auth.employee.id, status, page, revision, refreshToken])

  const reviewable = data?.counts.filter(count => count.status === 'submitted' && count.canReview) ?? []
  const chosen = reviewable.filter(count => selected.includes(count.id))
  const hasStale = chosen.some(count => count.lines.some(line => line.stale))
  function sendDecision(count: StockCountReview, action: 'approve' | 'reject', reason: string) {
    const body = action === 'reject' ? { reason } : {}
    return executeRecoverableCommand(`inventory-count-review:${auth.employee.id}:${count.id}:${action}`, body,
      `inventory-review-${crypto.randomUUID()}`, key => api.postEndpoint(`/api/inventory/stock-counts/${count.id}/${action}`, body, { idempotencyKey: key }))
  }

  async function decideBatch(action: 'approve' | 'reject') {
    if (locked.current || loading || chosen.length === 0 || (action === 'approve' && hasStale)) return
    const reason = batchReason.trim()
    if (action === 'reject' && reason.length < 2) { setNotice('请填写至少2字的批量退回原因'); return }
    const counts = [...chosen]
    locked.current = true; setBusy(true)
    try {
      if (!(await confirmAction({ title: action === 'approve' ? '批量核对盘点' : '批量退回盘点',
        description: action === 'approve'
          ? `已选${counts.length}张盘点单、${counts.reduce((total, count) => total + count.lines.length, 0)}项商品。请先核对实盘数量；通过的单据将调整库存，每单仍会检查权限和库存变化。`
          : `将退回已选${counts.length}张盘点单，库存不变。统一退回原因：${reason}`,
        confirmLabel: action === 'approve' ? '确认批量通过' : '确认批量退回' }))) return
      setResults([]); setNotice('')
      let succeeded = 0
      const completed: typeof results = []
      // Preserve each original command's permissions, transaction and recovery key.
      // One conflict must not hide the outcomes of the other selected counts.
      for (const count of counts) {
        setNotice(`正在处理 ${completed.length + 1}/${counts.length}`)
        let message: string
        try {
          await sendDecision(count, action, reason)
          succeeded++
          message = action === 'approve' ? '已通过，库存已更新' : '已退回，库存未改变'
        } catch (error) {
          message = `未完成，请核对原单：${error instanceof Error ? error.message : '结果尚未确认，再次操作沿用原请求'}`
        }
        completed.push({ id: count.id, label: `${count.createdByName} · ${count.lines.map(line => line.itemName).join('、')} · ${count.publicId}`, message })
        setResults([...completed])
      }
      setNotice(`本批${counts.length}张：${succeeded}张已${action === 'approve' ? '通过' : '退回'}，${counts.length - succeeded}张未完成。具体结果见下方。`)
      setSelected([]); setRevision(value => value + 1)
      try { await onChanged() } catch { setNotice(current => `${current} 库存汇总暂未刷新，请刷新核对。`) }
    } finally { locked.current = false; setBusy(false) }
  }

  async function decide(count: StockCountReview, action: 'approve' | 'reject') {
    if (locked.current || !count.canReview) return
    const reason = (reasons[count.id] ?? '').trim()
    if (action === 'reject' && reason.length < 2) { setNotice('请填写至少2字的退回原因'); return }
    locked.current = true; setBusy(true)
    try {
      if (action === 'approve' && !(await confirmAction({ title: '确认盘点差异',
        description: `请核对${count.createdByName}提交的${count.lines.length}项实盘数量。通过后将按差异调整库存；盘点后库存有变动时会拒绝生效。`,
        confirmLabel: '核对通过' }))) return
      await sendDecision(count, action, reason)
      setNotice(action === 'approve' ? '盘点已审核通过，库存已按差异更新' : '盘点已退回，库存未改变')
      setReasons(current => { const next = { ...current }; delete next[count.id]; return next })
      setRevision(value => value + 1)
      try { await onChanged() } catch { setNotice(current => `${current}；库存汇总暂未刷新，请刷新核对。`) }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : '审核结果尚未确认，请刷新核对；再次操作沿用原请求')
      setRevision(value => value + 1)
    } finally { locked.current = false; setBusy(false) }
  }

  return <section className="inventory-stock-counts" aria-label="盘点复核">
    <header><h2>盘点复核</h2><button type="button" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>刷新盘点</button></header>
    <p>{data?.canApprove ? '核对实盘数量后，可勾选批量通过或退回；本人提交的盘点须由另一名有审批权限的同事复核。' : '这里显示本人提交的盘点。请由有盘点审批权限的同事在“库存 → 盘点复核”处理。'}</p>
    <nav aria-label="盘点状态">
      <button type="button" disabled={busy} aria-pressed={status === 'submitted'} onClick={() => { setStatus('submitted'); setPage(0) }}>待复核</button>
      <button type="button" disabled={busy} aria-pressed={status === 'processed'} onClick={() => { setStatus('processed'); setPage(0) }}>已处理</button>
    </nav>
    {loading && <p role="status">正在读取盘点记录</p>}
    {error && <p role="alert">{error}，请点“刷新盘点”重试。</p>}
    {notice && <p role="status">{notice}</p>}
    {results.length > 0 && <section aria-label="本批审核结果"><h3>本批审核结果</h3><ul>{results.map(result => <li key={result.id}>{result.label}：{result.message}</li>)}</ul></section>}
    {status === 'submitted' && data?.canApprove && reviewable.length > 0 && <div className="inventory-stock-count-batch" role="group" aria-label="批量盘点复核">
      <label className="inventory-stock-count-select"><input type="checkbox" disabled={busy || loading} checked={chosen.length === reviewable.length}
        onChange={event => setSelected(event.target.checked ? reviewable.map(count => count.id) : [])} />全选当前页可复核单据</label>
      <span>已选 {chosen.length} 张，仅处理当前页</span>
      <div className="inventory-stock-count-actions">
        <button type="button" disabled={busy || loading} onClick={() => setSelected(reviewable.filter(count => !count.lines.some(line => line.stale)).map(count => count.id))}>选中可通过</button>
        <button type="button" disabled={busy || loading} onClick={() => setSelected(reviewable.filter(count => count.lines.some(line => line.stale)).map(count => count.id))}>选中需重盘</button>
        <button type="button" disabled={busy || loading || chosen.length === 0 || hasStale} onClick={() => void decideBatch('approve')}>批量通过</button>
      </div>
      {hasStale && <p>所选含库存已变化的盘点，只能退回重盘；“选中可通过”可排除这些单据。</p>}
      <div className="inventory-stock-count-actions">
        <label>批量退回原因<input maxLength={1000} disabled={busy} value={batchReason} onChange={event => setBatchReason(event.target.value)} /></label>
        <button type="button" disabled={busy || loading || chosen.length === 0} onClick={() => void decideBatch('reject')}>批量退回</button>
      </div>
    </div>}
    {!loading && data?.counts.length === 0 && <p>{status === 'submitted' ? '当前没有待复核盘点' : '当前没有已处理盘点'}</p>}
    {data?.counts.map(count => <article key={count.id} aria-label={`盘点 ${count.publicId}`}>
      <header><strong>{count.createdByName}的盘点</strong><span>{count.status === 'submitted' ? '待复核' : count.status === 'approved' ? '已通过' : '已退回'}</span></header>
      {count.status === 'submitted' && count.canReview && <label className="inventory-stock-count-select"><input type="checkbox" disabled={busy || loading}
        checked={selected.includes(count.id)} onChange={event => setSelected(current => event.target.checked ? [...current, count.id] : current.filter(id => id !== count.id))} />选择此盘点</label>}
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
