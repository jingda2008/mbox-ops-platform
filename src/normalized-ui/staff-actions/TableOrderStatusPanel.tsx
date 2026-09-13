import {ItemAfterSalesPanel} from '../ItemAfterSalesPanel'
import {ItemAfterSalesApi} from '../item-after-sales-api'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleAlert, Clock3, LoaderCircle, PackageOpen, RefreshCw } from 'lucide-react'
import { startTableOrderRefresh } from './table-order-refresh'
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

export function TableOrderStatusPanel(props: TableOrderStatusPanelProps) {
  return <TableOrderStatusContent key={props.table.activeSession.id} {...props} />
}

function TableOrderStatusContent({ api, table }: TableOrderStatusPanelProps) {
  const [afterSalesAccess,setAfterSalesAccess]=useState<{enabled:boolean;recoveryAvailable?:boolean;employeeId:string}|null>(null)
  const afterSalesRecovery=useMemo(()=>afterSalesAccess?new ItemAfterSalesApi(afterSalesAccess.employeeId):null,[afterSalesAccess])
  const [afterSalesItem,setAfterSalesItem]=useState<string|null>(null)
  useEffect(()=>{let active=true;void api.loadItemAfterSalesAccess?.().then(value=>{if(active)setAfterSalesAccess(value)}).catch(()=>{});return()=>{active=false}},[api])
  const [orders, setOrders] = useState<StaffTableOrderDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<TableOrderStatusError | null>(null)
  const [referenceCopied, setReferenceCopied] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const refreshControl = useRef<ReturnType<typeof startTableOrderRefresh> | null>(null)

  useEffect(() => {
    const control=startTableOrderRefresh({
      load: async (signal) => {
        if (!api.loadTableOrderDetails) throw new Error('本桌点单详情暂时不可用')
        return api.loadTableOrderDetails(table.activeSession.id, signal)
      },
      visible: () => document.visibilityState === 'visible',
      retryable: (reason) => !(reason instanceof StaffActionsApiError)
        || reason.status === null || reason.status >= 500 || reason.status === 408 || reason.status === 429,
      onStart: () => setLoading(true),
      onSuccess: (next) => { setOrders(next);setError(null);setUpdatedAt(new Date());setReferenceCopied(false) },
      onError: (reason) => setError(presentOrderDetailsError(reason)),
      onSettled: () => setLoading(false),
    })
    refreshControl.current=control
    const resume=()=>control.resume()
    window.addEventListener('online',resume)
    document.addEventListener('visibilitychange',resume)
    return ()=>{
      control.dispose();refreshControl.current=null
      window.removeEventListener('online',resume)
      document.removeEventListener('visibilitychange',resume)
    }
  }, [api, table.activeSession.id])

  const retry = () => refreshControl.current?.retry()

  const copyReference = () => {
    const referenceId = error?.referenceId
    if (referenceId === undefined || referenceId === null || navigator.clipboard === undefined) return
    void navigator.clipboard.writeText(referenceId)
      .then(() => setReferenceCopied(true))
      .catch(() => setReferenceCopied(false))
  }

  const items = useMemo(() => orders.flatMap((order) => order.items), [orders])
  const orderTotal = orders.every(order => Number.isSafeInteger(order.totalAmountMinor))
    ? orders.reduce((sum, order) => sum + order.totalAmountMinor!, 0) : null
  const refundedTotal = items.every(item => Number.isSafeInteger(item.refundedAmountMinor))
    ? items.reduce((sum, item) => sum + item.refundedAmountMinor!, 0) : null
  const increasedAmount=orders.reduce((sum,order)=>sum+(order.receivableIncreaseMinor??0),0)
  const stoppedAmount=orders.reduce((sum,order)=>sum+(order.stoppedAmountMinor??0),0)
  const deliveredQuantity=items.reduce((sum,item)=>sum+(item.quantities?.delivered??(item.fulfillmentStatus==='delivered'?item.quantity:0)),0)
  const pendingQuantity=items.reduce((sum,item)=>sum+(item.quantities?item.quantities.pending:!['delivered','cancelled','not_required'].includes(item.fulfillmentStatus)?item.quantity:0),0)
  const attentionQuantity = totalQuantity(items.filter((item) => item.fulfillmentStatus === 'attention'))

  return <section className="staff-table-order-status" aria-label={`${table.code}本桌点单详情`}>
    <header>
      <div><PackageOpen size={18} /><span><strong>本桌点单</strong><small>已上 / 未上以送达记录为准</small></span></div>
      <button type="button" aria-label="刷新本桌点单状态" disabled={loading} onClick={retry}>
        <RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> 刷新
      </button>
    </header>
    {updatedAt !== null && <p>{error ? '数据待更新 · ' : ''}最近更新 {updatedAt.toLocaleTimeString('zh-CN', {hour12:false})}</p>}
    {loading && items.length === 0 ? <p className="staff-table-order-status-loading"><LoaderCircle className="is-spinning" /> 正在读取本桌点单</p>
      : error !== null && items.length === 0 ? <OrderDetailsErrorNotice error={error} copied={referenceCopied} onCopy={copyReference} />
        : items.length === 0 ? <p className="staff-table-order-status-empty">本桌暂时没有已提交的商品。</p>
          : <>
            <p aria-label="本桌消费金额">消费原金额 {orderTotal===null?'待更新':`¥${(orderTotal/100).toFixed(2)}`}
              {refundedTotal!==null&&refundedTotal>0&&` · 已退款 ¥${(refundedTotal/100).toFixed(2)}`}
              {increasedAmount>0&&` · 套餐按单点价补差 ¥${(increasedAmount/100).toFixed(2)}`}
              {stoppedAmount>0&&` · 退菜减额 ¥${(stoppedAmount/100).toFixed(2)}`}
              <small> · 原成交金额含优惠，实收及待收请查看收款明细</small></p>
            <div className="staff-table-order-status-summary" aria-label="出品汇总">
              <span className="is-delivered"><Check size={16} />已上 {deliveredQuantity} 份</span>
              <span><Clock3 size={16} />未上 {pendingQuantity} 份</span>
              {attentionQuantity > 0 && <span className="is-attention"><CircleAlert size={16} />待核对 {attentionQuantity} 份</span>}
            </div>
            {error !== null && <OrderDetailsErrorNotice error={error} copied={referenceCopied} onCopy={copyReference} />}
            <div className="staff-table-order-status-list">
              {orders.map((order) => <article key={order.publicId}>
                <header><strong title={order.publicId}>{shortOrderLabel(order.publicId)}</strong><small>{order.paymentStatus === 'refunded' ? '已退款 · ' : order.paymentStatus === 'partially_refunded' ? '含退款 · ' : ''}{order.items.length} 个商品</small></header>
                {order.replacementSource&&<p>换品新单 · 原单 {shortOrderLabel(order.replacementSource.orderPublicId)}；分别收退款。
                  {afterSalesAccess&&(afterSalesAccess.enabled||afterSalesAccess.recoveryAvailable)&&<button type="button" onClick={()=>setAfterSalesItem(order.replacementSource!.orderItemId)}>查看换品原商品</button>}</p>}
                {order.items.map((item) => {
                  const status = STATUS_PRESENTATION[item.fulfillmentStatus]
                  return <div className="staff-table-order-status-item" key={item.id}>
                    <span><strong>{item.productName}</strong><small>{stationLabel(item.fulfillmentStation)} · {status.detail}</small><small>{item.includedInBundle ? '已含套餐，不另收费' : item.unitPriceMinor !== undefined && item.totalAmountMinor !== undefined ? `单价 ¥${(item.unitPriceMinor/100).toFixed(2)} · 小计 ¥${(item.totalAmountMinor/100).toFixed(2)}` : '成交金额暂未读取'}</small>{(item.refundedAmountMinor ?? 0)>0 && <small>已退 ¥{((item.refundedAmountMinor ?? 0)/100).toFixed(2)}</small>}</span>
                    {item.quantities&&<small>暂停 {item.quantities.held} · 停止 {item.quantities.stopped} · 已备齐 {item.quantities.ready} · 已送达 {item.quantities.delivered}</small>}
                    <b>×{item.quantity}</b>
                    <em className={status.className}>{status.label}</em>
                    {(afterSalesAccess?.enabled||afterSalesAccess?.recoveryAvailable&&item.quantities||afterSalesRecovery?.pending(item.id))&&<button type="button" onClick={()=>setAfterSalesItem(item.id)}>{afterSalesAccess?.enabled?(item.includedInBundle?'处理套餐内商品':'停止 / 退款'):'处理原申请'}</button>}
                  </div>
                })}
              </article>)}
            </div>
          </>}
    {afterSalesItem&&afterSalesAccess&&<ItemAfterSalesPanel itemId={afterSalesItem} employeeId={afterSalesAccess.employeeId} onClose={()=>setAfterSalesItem(null)} onChanged={retry}/>}
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
