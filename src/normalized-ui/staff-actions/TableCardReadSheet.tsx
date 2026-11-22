import {useEffect, useRef, useState} from 'react'
import {SessionMoneySummary} from '../SessionMoneySummary'
import type {StaffActionsApiPort, StaffTablePendingReview} from './staff-actions-api'
import type {StaffActionTableSession} from './types'
import {TableOrderStatusPanel} from './TableOrderStatusPanel'
import {shortPaymentOrderLabel} from './table-payment-model'

type Props = {
  api: StaffActionsApiPort
  table: {code: string; activeSession: StaffActionTableSession}
  mode: 'bill' | 'review'
  canViewOrders: boolean
  onClose(): void
  onCollect(orderId: string): void
}

export function TableCardReadSheet({api,table,mode,canViewOrders,onClose,onCollect}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [review,setReview] = useState<StaffTablePendingReview | null>(null)
  const [revision,setRevision] = useState(0)
  const [error,setError] = useState('')
  const [canQuery,setCanQuery] = useState(false)
  const [checking,setChecking] = useState(false)
  const [result,setResult] = useState('')
  const title = mode === 'bill' ? '账单' : '查原付款'
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  useEffect(() => {
    if (mode !== 'review') return
    const controller = new AbortController()
    setError('')
    setReview(null)
    void Promise.all([
      api.loadTablePendingReview!(table.activeSession.id,controller.signal),
      api.loadAssistedOrderAccess(controller.signal),
    ]).then(([data,access]) => {
      if (controller.signal.aborted) return
      setReview(data)
      setCanQuery(access.canQueryOnlinePayment)
    }).catch(() => {
      if (!controller.signal.aborted) setError('本桌付款记录暂时无法读取，请重新读取。')
    })
    return () => controller.abort()
  }, [api,mode,revision,table.activeSession.id])

  async function query(id: string, publicId: string) {
    if (checking || !canQuery) return
    setChecking(true)
    setResult('')
    try {
      const status = await api.queryOnlinePayment(id)
      const label = {pending:'渠道仍在处理中，请勿重复收款',succeeded:'渠道已确认到账',failed:'渠道已确认失败',closed:'渠道已关闭原付款'}[status]
      setResult(`${publicId} · ${label}`)
      setRevision(value => value + 1)
    } catch {
      setResult(`${publicId} · 原付款结果暂时无法确认，请稍后再查。`)
    } finally { setChecking(false) }
  }

  return <dialog ref={dialog} className="table-service-dialog staff-table-read-sheet" aria-label={table.code + title} onCancel={onClose}>
    <header><h2>{table.code} · {title}</h2><button type="button" onClick={onClose}>关闭</button></header>
    {mode === 'bill' ? <>
      <SessionMoneySummary money={table.activeSession}/>
      {canViewOrders && <TableOrderStatusPanel api={api} table={table}/>}
    </> : <>
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
      {!review && !error && <p>正在读取本桌原付款…</p>}
      {review && <section aria-label="待确认的原付款">
        {review.attempts.length === 0 && <p>本桌当前没有待确认的原付款。</p>}
        {review.attempts.map(attempt => <article key={attempt.id}>
          <strong>支付确认中 · 原付款 ¥{(attempt.amountMinor / 100).toFixed(2)}</strong>
          <div>付款号 {attempt.publicId}</div>
          <div>对应原单 {attempt.orderLabels.map(shortPaymentOrderLabel).join('、')}</div>
          {canQuery ? <button type="button" disabled={checking} onClick={() => void query(attempt.id,attempt.publicId)}>查询这笔付款结果</button> : <p>请由收银按此付款号核对渠道结果。</p>}
        </article>)}
      </section>}
      <button type="button" disabled={checking} onClick={() => setRevision(value => value + 1)}>重新读取本桌付款</button>
      {review && review.collectibleOrders.length > 0 && <section aria-label="可单独收款的原单">
        <h3>可单独收款的原单</h3>
        {review.collectibleOrders.map(order => <button key={order.id} disabled={checking} type="button" onClick={() => onCollect(order.id)}>
          {shortPaymentOrderLabel(order.publicId)} · 收款 ¥{(order.outstandingAmountMinor / 100).toFixed(2)}
        </button>)}
      </section>}
    </>}
  </dialog>
}
