import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, CircleAlert, Clock3, LoaderCircle, PackageOpen, RefreshCw } from 'lucide-react'
import { StaffActionsApiError, type StaffActionsApiPort } from './staff-actions-api'
import type { StaffTableOrderDetail, StaffTableOrderItemFulfillmentStatus } from './types'

export interface TableOrderStatusPanelProps {
  api: StaffActionsApiPort
  table: Readonly<{ code: string; activeSession: { id: string } }>
}

const STATUS_PRESENTATION: Record<StaffTableOrderItemFulfillmentStatus, {
  label: string
  detail: string
  className: string
}> = {
  delivered: { label: '已送达', detail: '已上桌', className: 'is-delivered' },
  ready_for_delivery: { label: '待送达', detail: '已做好，等送上桌', className: 'is-ready' },
  preparing: { label: '制作中', detail: '正在制作', className: 'is-preparing' },
  pending: { label: '待制作', detail: '尚未开始制作', className: 'is-pending' },
  awaiting_payment: { label: '待付款', detail: '付款后才会出品', className: 'is-pending' },
  not_required: { label: '无需出品', detail: '不需要送达', className: 'is-neutral' },
  cancelled: { label: '已取消', detail: '不再出品', className: 'is-neutral' },
  attention: { label: '待处理', detail: '请联系吧台或店长核对', className: 'is-attention' },
}

export function TableOrderStatusPanel({ api, table }: TableOrderStatusPanelProps) {
  const [orders, setOrders] = useState<StaffTableOrderDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<TableOrderStatusError | null>(null)
  const [refreshAttempt, setRefreshAttempt] = useState(0)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true)
  const [referenceCopied, setReferenceCopied] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (api.loadTableOrderDetails === undefined) {
      throw new Error('本桌点单详情暂时不可用，请刷新后重试')
    }
    const next = await api.loadTableOrderDetails(table.activeSession.id, signal)
    setOrders(next)
    setAutoRefreshEnabled(true)
  }, [api, table.activeSession.id])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setReferenceCopied(false)
    void refresh(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setError(presentOrderDetailsError(reason))
        setAutoRefreshEnabled(false)
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [refresh, refreshAttempt])

  useEffect(() => {
    if (!autoRefreshEnabled) return undefined
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === 'visible') setRefreshAttempt((current) => current + 1)
    }, 10_000)
    return () => globalThis.clearInterval(timer)
  }, [autoRefreshEnabled])

  const retry = () => {
    setAutoRefreshEnabled(true)
    setRefreshAttempt((current) => current + 1)
  }

  const copyReference = () => {
    const referenceId = error?.referenceId
    if (referenceId === undefined || referenceId === null || navigator.clipboard === undefined) return
    void navigator.clipboard.writeText(referenceId)
      .then(() => setReferenceCopied(true))
      .catch(() => setReferenceCopied(false))
  }

  const items = useMemo(() => orders.flatMap((order) => order.items), [orders])
  const deliveredQuantity = totalQuantity(items.filter((item) => item.fulfillmentStatus === 'delivered'))
  const pendingQuantity = totalQuantity(items.filter((item) => (
    !['delivered', 'cancelled', 'not_required'].includes(item.fulfillmentStatus)
  )))
  const attentionQuantity = totalQuantity(items.filter((item) => item.fulfillmentStatus === 'attention'))

  return <section className="staff-table-order-status" aria-label={`${table.code}本桌点单详情`}>
    <header>
      <div><PackageOpen size={18} /><span><strong>本桌点单</strong><small>已上 / 未上以送达记录为准</small></span></div>
      <button type="button" aria-label="刷新本桌点单状态" disabled={loading} onClick={retry}>
        <RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> 刷新
      </button>
    </header>
    {loading && items.length === 0 ? <p className="staff-table-order-status-loading"><LoaderCircle className="is-spinning" /> 正在读取本桌点单</p>
      : error !== null && items.length === 0 ? <OrderDetailsErrorNotice error={error} copied={referenceCopied} onCopy={copyReference} />
        : items.length === 0 ? <p className="staff-table-order-status-empty">本桌暂时没有已提交的商品。</p>
          : <>
            <div className="staff-table-order-status-summary" aria-label="出品汇总">
              <span className="is-delivered"><Check size={16} />已上 {deliveredQuantity} 份</span>
              <span><Clock3 size={16} />未上 {pendingQuantity} 份</span>
              {attentionQuantity > 0 && <span className="is-attention"><CircleAlert size={16} />待核对 {attentionQuantity} 份</span>}
            </div>
            {error !== null && <OrderDetailsErrorNotice error={error} copied={referenceCopied} onCopy={copyReference} />}
            <div className="staff-table-order-status-list">
              {orders.map((order) => <article key={order.publicId}>
                <header><strong title={order.publicId}>{shortOrderLabel(order.publicId)}</strong><small>{order.items.length} 个商品</small></header>
                {order.items.map((item) => {
                  const status = STATUS_PRESENTATION[item.fulfillmentStatus]
                  return <div className="staff-table-order-status-item" key={item.id}>
                    <span><strong>{item.productName}</strong><small>{stationLabel(item.fulfillmentStation)} · {status.detail}</small></span>
                    <b>×{item.quantity}</b>
                    <em className={status.className}>{status.label}</em>
                  </div>
                })}
              </article>)}
            </div>
          </>}
  </section>
}

interface TableOrderStatusError {
  message: string
  referenceId: string | null
}

function presentOrderDetailsError(reason: unknown): TableOrderStatusError {
  if (reason instanceof StaffActionsApiError) {
    if (reason.status !== null && reason.status >= 500) {
      return { message: '本桌点单暂未显示，收款不受影响。', referenceId: reason.referenceId }
    }
    if (reason.status === 403) return { message: '当前无权查看本桌点单。', referenceId: null }
    if (reason.status === 401) return { message: '登录状态已失效，请重新进入。', referenceId: null }
    return { message: reason.message, referenceId: reason.referenceId }
  }
  return { message: reason instanceof Error ? reason.message : '本桌点单详情暂时无法读取', referenceId: null }
}

function OrderDetailsErrorNotice(props: Readonly<{
  error: TableOrderStatusError
  copied: boolean
  onCopy(): void
}>) {
  return <p className="staff-table-order-status-error" role="alert">
    <CircleAlert size={17} />
    <span>{props.error.message}</span>
    {props.error.referenceId !== null && <button type="button" onClick={props.onCopy}>
      {props.copied ? '已复制' : '复制参考号'}
    </button>}
  </p>
}

function totalQuantity(items: ReadonlyArray<{ quantity: number }>): number {
  return items.reduce((total, item) => total + item.quantity, 0)
}

function shortOrderLabel(publicId: string): string {
  return publicId.length > 8 ? `订单 · ${publicId.slice(-8)}` : `订单 · ${publicId}`
}

function stationLabel(station: StaffTableOrderDetail['items'][number]['fulfillmentStation']): string {
  if (station === 'bar') return '吧台'
  if (station === 'kitchen') return '后厨'
  if (station === 'cashier') return '现场'
  return '无需出品'
}
