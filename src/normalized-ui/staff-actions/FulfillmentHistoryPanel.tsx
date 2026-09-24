import { useEffect, useMemo, useRef, useState } from 'react'
import type { OperatingHistory } from '../../shared/operating-history'
import { StaffActionsApiError, type StaffActionsApiPort } from './staff-actions-api'
import { RefreshQueue } from './refresh-queue'

export function FulfillmentHistoryPanel({ api, kind, refreshRevision = 0, onOpenItem }: {
  api: StaffActionsApiPort
  kind: 'prepared' | 'delivered'
  refreshRevision?: number
  onOpenItem?(itemId: string): void
}) {
  const [date, setDate] = useState(''), [table, setTable] = useState(''), [page, setPage] = useState(0)
  const query = useMemo(() => ({ api, kind, date, table, page }), [api, kind, date, table, page])
  const [snapshot, setSnapshot] = useState<{ query: typeof query; data: OperatingHistory } | null>(null)
  const [failure, setFailure] = useState<{ query: typeof query; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const previousRevision = useRef(refreshRevision)
  const data = snapshot?.query === query ? snapshot.data : null
  const error = failure?.query === query ? failure.message : ''
  const refresh = useMemo(() => new RefreshQueue(async signal => {
    setBusy(true)
    try {
      if (!query.api.loadFulfillmentHistory) throw new Error('历史查询入口暂不可用')
      const next = await query.api.loadFulfillmentHistory(query, signal)
      if (!signal.aborted) { setSnapshot({ query, data: next }); setFailure(null) }
    } catch (reason) {
      if (signal.aborted) return
      if (reason instanceof StaffActionsApiError && [401, 403].includes(reason.status ?? 0)) setSnapshot(null)
      setFailure({ query, message: reason instanceof Error ? reason.message : '历史暂未读取成功' })
    } finally { if (!signal.aborted) setBusy(false) }
  }), [query])

  useEffect(() => {
    const poll = () => { if (document.visibilityState === 'visible') void refresh.request() }
    void refresh.request()
    const timer = globalThis.setInterval(poll, 10_000)
    document.addEventListener('visibilitychange', poll)
    return () => { refresh.cancel(); globalThis.clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [refresh])
  useEffect(() => {
    if (previousRevision.current === refreshRevision) return
    previousRevision.current = refreshRevision
    void refresh.request(true)
  }, [refresh, refreshRevision])

  return <section className="staff-fulfillment-history" aria-label={kind === 'prepared' ? '我的历史制作' : '已送达历史'}>
    <form onSubmit={event => { event.preventDefault(); void refresh.request(true) }}>
      <label>营业日<input type="date" value={date || data?.businessDate || ''} onChange={event => { setDate(event.target.value); setPage(0) }} /></label>
      <label>桌号<input value={table} placeholder="全部桌台" onChange={event => { setTable(event.target.value); setPage(0) }} /></label>
      <button disabled={busy}>刷新</button>
    </form>
    {error && <p role="alert" data-action-reveal="off">{error}{data ? '；当前保留上次成功记录。' : ''}</p>}
    {busy && <p role="status" data-action-reveal="off">正在读取历史</p>}
    {kind==='delivered'&&data?.sharedDeliveries!==undefined&&<section aria-label="共用取餐屏送达记录">
      <h3>共用取餐屏</h3><p>按当前可见桌台显示，不计入个人送达数量。</p>
      {data.sharedDeliveries.map(receipt=><article className="staff-action-card staff-fulfillment-history-order" key={receipt.receiptId}>
        <header><strong>{receipt.tableCode}</strong><small>共用取餐屏 · {new Date(receipt.deliveredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></header>
        {receipt.pickupTableCode!==receipt.tableCode&&<p>取走时桌号：{receipt.pickupTableCode}</p>}
        <div className="staff-fulfillment-history-items">{receipt.items.map((item,index)=><div className="staff-fulfillment-history-item" key={`${item.itemId}:${item.kind}:${index}`}>
          <strong>{item.name} · 已送达 {item.quantity} 份{item.kind==='remake'?' · 重做':''}</strong>
          {[item.specification,item.itemNote,item.orderNote].filter(Boolean).map((note,index)=><p className="staff-action-note" key={index}>{note}</p>)}
          {onOpenItem&&<button type="button" disabled={!!error} onClick={()=>onOpenItem(item.itemId)}>商品处理</button>}
        </div>)}</div>
      </article>)}
      {!busy&&!error&&data.sharedDeliveries.length===0&&<p>本页没有共用取餐屏送达记录。</p>}
    </section>}
    {kind==='delivered'&&data&&data.orders.length>0&&<h3>本人送达记录</h3>}
    {data?.orders.map(order => <article className="staff-action-card staff-fulfillment-history-order" key={order.id}>
      <header><strong>{order.tableCode}</strong><small>{order.publicId}</small></header>
      <div className="staff-fulfillment-history-items">{order.items.map(item => <div className="staff-fulfillment-history-item" key={item.id}>
        <strong>{item.name} · {item.workQuantity === undefined ? `原单 ${item.quantity} 份` : `本人${kind === 'prepared' ? '制作' : '送达'} ${item.workQuantity} 份`}</strong>{item.note && <p className="staff-action-note">备注：{item.note}</p>}
        {onOpenItem && <button type="button" disabled={!!error} onClick={() => onOpenItem(item.id)}>商品处理</button>}
        {item.fulfillmentClosureNote&&<p>{item.fulfillmentClosureNote}</p>}
        <p>{kind === 'prepared' ? item.preparedBy : item.deliveredBy} · {((kind === 'prepared' ? item.preparedAt : item.deliveredAt)
          ? new Date((kind === 'prepared' ? item.preparedAt : item.deliveredAt)!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '完成时间未留存')}</p>
      </div>)}</div>
    </article>)}
    {!busy && !error && data?.orders.length === 0 && <p>{kind==='prepared'?'该营业日没有本人制作完成记录。':'本页没有本人送达记录。'}</p>}
    <nav><button disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>第{page + 1}页</span><button disabled={busy || !data?.hasMore} onClick={() => setPage(value => value + 1)}>下一页</button></nav>
  </section>
}
