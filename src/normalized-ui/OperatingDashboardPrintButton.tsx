import { useRef, useState } from 'react'
import type { NormalizedApiClient } from '../normalized-api'

interface Props {
  api: NormalizedApiClient
  period: 'day' | 'month' | 'year'
  anchor: string
  reportAsOf: string
  employeeId: string
  scopeKey?: string
  allowNew?: boolean
  blockedReason?: string
}
interface Receipt { requestId: string; jobIds: string[]; asOf: string }
const rememberedKeys = new Map<string, string>()
function storedKey(scope: string) {
  try {
    const key = sessionStorage.getItem(scope)
    if (key && /^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return key
  } catch { /* In-page recovery remains available when storage is disabled. */ }
  return rememberedKeys.get(scope) ?? null
}
function remember(scope: string, key: string | null) {
  if (key) rememberedKeys.set(scope, key); else rememberedKeys.delete(scope)
  try { if (key) sessionStorage.setItem(scope, key); else sessionStorage.removeItem(scope) } catch { /* Keep the in-page key. */ }
}

export function OperatingDashboardPrintButton(props: Props) {
  const scope = `mbox-operating-print:${props.scopeKey ?? ''}:${props.employeeId}:${props.period}:${props.anchor}`
  return <PrintAction key={scope} {...props} storageKey={scope} />
}

function PrintAction({ api, period, anchor, reportAsOf, storageKey, allowNew = true, blockedReason }: Props & { storageKey: string }) {
  const key = useRef(storedKey(storageKey))
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [message, setMessage] = useState(key.current ? '保留了本期间的打印请求，请先核对原任务。' : '')
  async function print() {
    if (active.current || receipt || (!allowNew && !key.current)) return
    active.current = true; setBusy(true)
    key.current ??= crypto.randomUUID()
    remember(storageKey, key.current)
    try {
      const result = await api.postEndpoint<Receipt>('/api/hardware/operating-report',
        { period, anchorDate: anchor }, { idempotencyKey: key.current })
      if (!result || typeof result.requestId !== 'string' || !Array.isArray(result.jobIds) || typeof result.asOf !== 'string') {
        throw new Error('打印回执不完整')
      }
      setReceipt(result)
      setMessage(`已生成经营汇总打印任务，数据时间：${result.asOf}。任务成功不代表已经出纸。`)
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : '打印结果尚未确认'}；原请求已保留，请核对同一次结果。`)
    } finally { active.current = false; setBusy(false) }
  }
  async function progress() {
    if (!receipt || active.current) return
    active.current = true; setBusy(true)
    try {
      const response = await api.getEndpoint<{ data: Array<{ status: string }> }>(`/api/hardware/print-requests/${encodeURIComponent(receipt.requestId)}`)
      const labels: Record<string, string> = { pending: '待打印', printing: '正在提交', printed: '已提交打印机', failed: '失败待核对', dead: '需人工处理', cancelled: '已取消' }
      setMessage(response.data.length ? response.data.map((job, index) => `任务${index + 1}：${labels[job.status] ?? '待核对'}`).join('；') + '。请核对实际出纸。' : '未读到任务，请保留原请求，不要重复打印。')
    } catch { setMessage('任务状态暂未读取，原请求保留，请稍后重试核对。') }
    finally { active.current = false; setBusy(false) }
  }
  return <section aria-label="经营汇总打印">
    <p>打印六项指标及收入、成本分类，保留覆盖和暂估说明。页面数据时间：{reportAsOf}；打印时重新读取，票据注明生成时间。</p>
    {!allowNew && <p>{blockedReason || '所选期间尚未核对，暂不能生成新票据。'}{key.current ? '已保留的原打印请求仍可核对。' : ''}</p>}
    <button type="button" disabled={busy || receipt !== null || (!allowNew && !key.current)} aria-busy={busy} onClick={() => void print()}>
      {busy ? '正在确认结果…' : receipt ? '已生成打印任务' : key.current ? '核对原打印请求' : '打印经营汇总'}
    </button>
    {message && <p role="status">{message}</p>}
    {receipt && <><button type="button" disabled={busy} onClick={() => void progress()}>查询原任务进度</button>
      <details><summary>原打印记录</summary><p>{receipt.requestId}</p><p>需补打时先核对原纸票；确认后才重新生成。</p>
        <button type="button" disabled={busy || !allowNew} onClick={() => {
          if (active.current) return
          remember(storageKey, null); key.current = null; setReceipt(null)
          setMessage('已核对原打印；下一次将按最新数据生成新票据。')
        }}>已核对原票，准备重新生成</button>
      </details></>}
  </section>
}
