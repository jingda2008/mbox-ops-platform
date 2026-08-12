import {
  AlertCircle,
  Bell,
  Check,
  LoaderCircle,
  MessageCircleWarning,
  RefreshCw,
  Send,
  Store,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../api'
import { MenuOrderingWorkspace, type MenuSubmitOptions } from '../../components/MenuOrderingWorkspace'
import type { MenuRecommendationScene } from '../../shared/contracts'
import {
  GuestApiClient,
  GuestApiError,
  type GuestOrderResult,
  type GuestSessionView,
  type GuestTableOrder,
} from './guest-api'
import {
  formatMoney,
  parseGuestAccess,
  parseGuestTableCode,
  safeIdempotencyKey,
  tokenFreeLocation,
  type GuestMenuProduct,
  type GuestMood,
} from './guest-model'
import { guestMenuProductToMenuProduct } from './menu-product-adapter'
import './guest-app.css'

type GuestApiPort = Pick<GuestApiClient, 'scanTable' | 'loadSession' | 'searchMenu' | 'submitOrder' | 'loadTableOrders' | 'requestService' | 'recordMood'>
type ServiceType = 'call_staff' | 'complaint' | 'custom'
type Panel = 'orders' | 'complaint' | 'custom' | 'checkout' | null

export interface GuestAppProps {
  apiFactory?: (deviceKey: string) => GuestApiPort
}

interface ToastState {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
}

const moods: ReadonlyArray<{ code: GuestMood; asset: string; label: string }> = [
  { code: 'happy', asset: 'happy', label: '开心' },
  { code: 'excited', asset: 'tipsy', label: '微醺' },
  { code: 'listening', asset: 'listen', label: '听歌' },
  { code: 'social', asset: 'interactive', label: '互动' },
  { code: 'celebrating', asset: 'celebrate', label: '庆祝' },
  { code: 'quiet', asset: 'quiet', label: '安静' },
]

const guestOrderSafety = {
  enabled: true,
  duplicateWindowSeconds: 600,
  maxOrdersPerMinute: 5,
  requireSubmitConfirmation: true,
  requireContinuationConfirmationSeconds: 120,
} as const

export function GuestApp({ apiFactory }: GuestAppProps) {
  const [phase, setPhase] = useState<'booting' | 'waiting' | 'ready' | 'blocked'>('booting')
  const [gateMessage, setGateMessage] = useState('正在连接您的桌位…')
  const [table, setTable] = useState<GuestSessionView['table'] | null>(null)
  const [products, setProducts] = useState<GuestMenuProduct[]>([])
  const [partySize, setPartySize] = useState(1)
  const [recommendationScene, setRecommendationScene] = useState<MenuRecommendationScene | undefined>()
  const [menuLoading, setMenuLoading] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [serviceDetail, setServiceDetail] = useState('')
  const [pendingService, setPendingService] = useState<ServiceType | null>(null)
  const [selectedMood, setSelectedMood] = useState<GuestMood | null>(null)
  const [pendingMood, setPendingMood] = useState<GuestMood | null>(null)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [orderResult, setOrderResult] = useState<GuestOrderResult | null>(null)
  const [tableOrders, setTableOrders] = useState<GuestTableOrder[]>([])
  const [tableOrdersLoading, setTableOrdersLoading] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const apiRef = useRef<GuestApiPort | null>(null)
  const tableCodeRef = useRef<string | null>(null)
  const qrCredentialRef = useRef<string | null>(null)
  const menuRequest = useRef(0)
  const orderSubmittingRef = useRef(false)
  const serviceSubmittingRef = useRef(false)
  const toastSequence = useRef(0)

  const menuProducts = useMemo(() => products.map(guestMenuProductToMenuProduct), [products])

  const notify = useCallback((message: string, tone: ToastState['tone'] = 'info') => {
    setToast({ id: ++toastSequence.current, message, tone })
  }, [])

  const blockForSession = useCallback((error: unknown) => {
    if (error instanceof GuestApiError && (error.status === 401 || error.code === 'TABLE_SESSION_ENDED')) {
      setPhase('blocked')
      setGateMessage('这桌的服务时段已经结束，请重新扫描桌面二维码。')
      return true
    }
    return false
  }, [])

  const loadMenu = useCallback(async () => {
    const api = apiRef.current
    if (api === null) return
    const requestId = ++menuRequest.current
    setMenuLoading(true)
    setMenuError(null)
    try {
      const result = await api.searchMenu('')
      if (requestId !== menuRequest.current) return
      setProducts(result.products)
      setPartySize(result.partySize)
      setRecommendationScene(result.recommendationScene)
    } catch (error) {
      if (requestId !== menuRequest.current || blockForSession(error)) return
      setMenuError(errorMessage(error, '菜单暂时没有加载出来，请再试一次。'))
    } finally {
      if (requestId === menuRequest.current) setMenuLoading(false)
    }
  }, [blockForSession])

  const loadTableOrders = useCallback(async (quiet = false) => {
    const api = apiRef.current
    if (api === null) return
    if (!quiet) setTableOrdersLoading(true)
    try {
      setTableOrders(await api.loadTableOrders())
    } catch (error) {
      if (!blockForSession(error) && !quiet) notify(errorMessage(error, '本桌订单暂时没有更新，请再试一次。'), 'error')
    } finally {
      if (!quiet) setTableOrdersLoading(false)
    }
  }, [blockForSession, notify])

  const acceptSession = useCallback((session: GuestSessionView, expectedTable: string) => {
    if (session.table.code.toUpperCase() !== expectedTable.toUpperCase()) {
      setPhase('blocked')
      setGateMessage('当前会话与桌号不一致，请重新扫描所在桌面的二维码。')
      return false
    }
    setTable(session.table)
    if (session.status === 'waiting_for_table') {
      setPhase('waiting')
      setGateMessage(session.message ?? '座位正在准备中，请稍候。')
      return false
    }
    qrCredentialRef.current = null
    setPhase('ready')
    return true
  }, [])

  const connectTable = useCallback(async () => {
    const api = apiRef.current
    const expectedTable = tableCodeRef.current
    if (api === null || expectedTable === null) return
    setPhase('booting')
    setGateMessage('正在连接您的桌位…')
    try {
      const credential = qrCredentialRef.current
      const session = credential === null ? await api.loadSession() : await api.scanTable(credential)
      acceptSession(session, expectedTable)
    } catch (error) {
      setPhase('blocked')
      setGateMessage(errorMessage(error, '暂时没有连接上桌边服务，请重试。'))
    }
  }, [acceptSession])

  useEffect(() => {
    const currentUrl = new URL(window.location.href)
    const expectedTable = parseGuestTableCode(currentUrl.href)
    tableCodeRef.current = expectedTable
    const parsed = parseGuestAccess(currentUrl.href)
    if (parsed.access !== null) {
      qrCredentialRef.current = parsed.access.tableQrToken
      window.history.replaceState(null, '', tokenFreeLocation(currentUrl))
    }
    if (expectedTable === null) {
      setPhase('blocked')
      setGateMessage(parsed.error ?? '没有识别到桌号，请重新扫描桌面二维码。')
      return
    }
    const deviceKey = resolveDeviceKey(window.sessionStorage)
    apiRef.current = apiFactory?.(deviceKey) ?? new GuestApiClient(deviceKey)
    void connectTable()
    return () => { menuRequest.current += 1 }
  }, [apiFactory, connectTable])

  useEffect(() => {
    if (phase !== 'ready') return
    void loadMenu()
    void loadTableOrders(true)
  }, [loadMenu, loadTableOrders, phase])

  useEffect(() => {
    if (phase !== 'ready' || panel !== 'orders') return
    const refresh = () => { if (document.visibilityState === 'visible') void loadTableOrders(true) }
    const timer = window.setInterval(refresh, 8_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadTableOrders, panel, phase])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 3_200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const requestService = useCallback(async (requestType: ServiceType, detail: string | null) => {
    const api = apiRef.current
    if (api === null || pendingService !== null || serviceSubmittingRef.current) return
    serviceSubmittingRef.current = true
    setPendingService(requestType)
    haptic(8)
    try {
      const result = await api.requestService(
        { requestType, detail },
        { idempotencyKey: safeIdempotencyKey(`guest-service-${requestType}`) },
      )
      notify(result.message, result.status === 'rate_limited' ? 'info' : 'success')
      setPanel(null)
      setServiceDetail('')
    } catch (error) {
      if (!blockForSession(error)) notify(errorMessage(error, '这次没有送达，请再试一次。'), 'error')
    } finally {
      serviceSubmittingRef.current = false
      setPendingService(null)
    }
  }, [blockForSession, notify, pendingService])

  const selectMood = useCallback(async (mood: GuestMood) => {
    const api = apiRef.current
    if (api === null || pendingMood !== null || mood === selectedMood) return
    const previous = selectedMood
    setSelectedMood(mood)
    setPendingMood(mood)
    haptic(5)
    try {
      await api.recordMood(mood, { idempotencyKey: safeIdempotencyKey(`guest-mood-${mood}`) })
    } catch (error) {
      setSelectedMood(previous)
      if (!blockForSession(error)) notify('刚才的心情没有记录上，可以再选一次。', 'error')
    } finally {
      setPendingMood(null)
    }
  }, [blockForSession, notify, pendingMood, selectedMood])

  const submitOrder = useCallback(async (
    items: Array<{ productId: string; quantity: number }>,
    options: MenuSubmitOptions,
  ) => {
    const api = apiRef.current
    if (api === null || items.length === 0 || orderSubmittingRef.current) return
    if (!options.confirmedDuplicateOrderId) {
      const duplicate = findRecentDuplicateOrder(tableOrders, items)
      if (duplicate !== null) {
        throw new ApiError(
          `本桌刚点过 ${duplicate.names.join('、')}，请确认是否继续加单。`,
          409,
          'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
          { conflictingOrderId: duplicate.orderId },
        )
      }
    }
    orderSubmittingRef.current = true
    setSubmittingOrder(true)
    haptic(8)
    try {
      const result = await api.submitOrder(
        { items, note: options.fulfillmentNote || null },
        { idempotencyKey: safeIdempotencyKey('guest-order') },
      )
      setOrderResult(result)
      setPanel('checkout')
      notify('订单已经送达吧台与收银。', 'success')
      void loadTableOrders(true)
    } catch (error) {
      if (!blockForSession(error)) throw error
    } finally {
      orderSubmittingRef.current = false
      setSubmittingOrder(false)
    }
  }, [blockForSession, loadTableOrders, notify, tableOrders])

  if (phase !== 'ready') {
    return <GuestGate phase={phase} message={gateMessage} table={table} onRetry={() => void connectTable()} />
  }

  return (
    <main className="guest-app guest-app-restored-menu" data-testid="normalized-guest-app">
      <header className="guest-header">
        <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · LIVEHOUSE</small></div></div>
        <button type="button" className="guest-table" onClick={() => { setPanel('orders'); void loadTableOrders() }}>
          <small>本桌已点 · {tableOrders.reduce((sum, order) => sum + order.items.reduce((count, item) => count + item.quantity, 0), 0)}件</small>
          <strong>{table?.displayName ?? table?.code}</strong>
        </button>
      </header>

      <section className="guest-mood" aria-labelledby="guest-mood-title">
        <div><small>YOUR MOOD</small><h2 id="guest-mood-title">今晚是什么状态？</h2></div>
        <div className={selectedMood === null ? 'guest-mood-options' : 'guest-mood-options has-selection'}>
          {moods.map((mood) => <button
            type="button"
            key={mood.code}
            className={selectedMood === mood.code ? 'is-selected' : ''}
            aria-pressed={selectedMood === mood.code}
            aria-label={`心情：${mood.label}`}
            onClick={() => void selectMood(mood.code)}
          ><img src={`/brand/moods-v2/${mood.asset}.webp`} alt="" aria-hidden="true" decoding="async" /><small>{mood.label}</small></button>)}
        </div>
      </section>

      <section className="guest-service-strip" aria-label="桌边服务">
        <button type="button" disabled={pendingService !== null} onClick={() => void requestService('call_staff', null)}>
          {pendingService === 'call_staff' ? <LoaderCircle className="is-spinning" /> : <Bell />}<span>呼叫服务员</span>
        </button>
        <button type="button" disabled={pendingService !== null} onClick={() => { setServiceDetail(''); setPanel('complaint') }}>
          <MessageCircleWarning /><span>投诉 / 不满意</span>
        </button>
        <button type="button" disabled={pendingService !== null} onClick={() => { setServiceDetail(''); setPanel('custom') }}>
          <Send /><span>个性需求</span>
        </button>
      </section>

      {menuError !== null && <div className="guest-inline-error"><AlertCircle /><span>{menuError}</span><button type="button" onClick={() => void loadMenu()}>重试</button></div>}
      {menuLoading && menuProducts.length === 0 ? <div className="guest-menu-loading"><LoaderCircle className="is-spinning" /> 正在准备菜单</div> : (
        <MenuOrderingWorkspace
          products={menuProducts}
          tableLabel={table?.displayName ?? table?.code ?? ''}
          submitLabel="确认订单并微信支付"
          submitHint="确认后会创建本桌订单，并进入微信支付。"
          busy={submittingOrder}
          orderSafety={guestOrderSafety}
          compactCart
          deemphasizeCollapsedTotal
          guestSalesMode
          partySize={partySize}
          recommendationScene={recommendationScene}
          onSubmit={submitOrder}
        />
      )}

      {panel !== null && <GuestPanel title={panelTitle(panel)} onClose={() => panel !== 'checkout' && setPanel(null)} dismissible={panel !== 'checkout'}>
        {panel === 'orders' && <TableOrdersPanel orders={tableOrders} loading={tableOrdersLoading} onRefresh={() => void loadTableOrders()} />}
        {(panel === 'complaint' || panel === 'custom') && <ServicePanel
          kind={panel}
          detail={serviceDetail}
          pending={pendingService !== null}
          onDetailChange={setServiceDetail}
          onSubmit={() => void requestService(panel, serviceDetail.trim() || null)}
        />}
        {panel === 'checkout' && orderResult !== null && <CheckoutPanel result={orderResult} onClose={() => setPanel(null)} />}
      </GuestPanel>}

      {toast !== null && <div className={`guest-toast is-${toast.tone}`} role="status"><Check />{toast.message}</div>}
    </main>
  )
}

function findRecentDuplicateOrder(
  orders: readonly GuestTableOrder[],
  items: readonly { productId: string; quantity: number }[],
): { orderId: string; names: string[] } | null {
  const cutoff = Date.now() - guestOrderSafety.duplicateWindowSeconds * 1_000
  const requested = new Set(items.map((item) => item.productId))
  for (const order of orders) {
    if (Date.parse(order.createdAt) < cutoff) continue
    const names = order.items
      .filter((item) => item.status !== 'cancelled' && requested.has(item.productId))
      .map((item) => item.name)
    if (names.length > 0) return { orderId: order.publicId, names: [...new Set(names)] }
  }
  return null
}

function GuestGate({ phase, message, table, onRetry }: {
  phase: 'booting' | 'waiting' | 'blocked'
  message: string
  table: GuestSessionView['table'] | null
  onRetry: () => void
}) {
  return <main className="guest-gate">
    <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · LIVEHOUSE</small></div></div>
    <section>
      <span className="guest-gate-icon">{phase === 'booting' ? <LoaderCircle className="is-spinning" /> : phase === 'waiting' ? <Store /> : <AlertCircle />}</span>
      <small>{table?.displayName ?? '桌边服务'}</small>
      <h1>{phase === 'booting' ? '正在为您准备' : phase === 'waiting' ? '座位正在准备' : '需要重新连接'}</h1>
      <p>{message}</p>
      {phase !== 'booting' && <button type="button" onClick={onRetry}><RefreshCw />{phase === 'waiting' ? '我已入座，继续' : '重新连接'}</button>}
    </section>
  </main>
}

function GuestPanel({ title, dismissible, onClose, children }: { title: string; dismissible: boolean; onClose: () => void; children: React.ReactNode }) {
  return <div className="guest-panel-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose() }}>
    <section className="guest-panel" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2>{dismissible && <button type="button" aria-label="关闭" onClick={onClose}><X /></button>}</header>
      {children}
    </section>
  </div>
}

function TableOrdersPanel({ orders, loading, onRefresh }: { orders: GuestTableOrder[]; loading: boolean; onRefresh: () => void }) {
  return <div className="guest-table-orders">
    <div className="guest-table-orders-toolbar"><span>{orders.length === 0 ? '还没有已确认的订单' : `共 ${orders.length} 轮`}</span><button type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'is-spinning' : ''} />刷新</button></div>
    {orders.map((order) => <article key={order.publicId} className={order.visibility === 'private_pending' ? 'is-private' : ''}>
      <header><strong>{order.visibility === 'private_pending' ? '我的待支付订单' : `本桌第 ${order.round} 轮`}</strong><span>{orderStatusCopy(order)}</span></header>
      <div>{order.items.map((item) => <p key={item.productId}><span>{item.name} × {item.quantity}</span><small>{itemStatusCopy(item.status)}</small></p>)}</div>
    </article>)}
  </div>
}

function orderStatusCopy(order: GuestTableOrder): string {
  if (order.visibility === 'private_pending') return '等待付款'
  if (order.status === 'completed') return '已完成'
  return order.items.every((item) => item.status === 'delivered' || item.status === 'cancelled') ? '已送齐' : '准备中'
}

function itemStatusCopy(status: GuestTableOrder['items'][number]['status']): string {
  if (status === 'delivered') return '已送达'
  if (status === 'ready') return '待送达'
  if (status === 'cancelled') return '已取消'
  if (status === 'preparing' || status === 'accepted') return '制作中'
  return '已下单'
}

function ServicePanel({ kind, detail, pending, onDetailChange, onSubmit }: {
  kind: 'complaint' | 'custom'
  detail: string
  pending: boolean
  onDetailChange: (value: string) => void
  onSubmit: () => void
}) {
  const custom = kind === 'custom'
  return <div className="guest-service-panel">
    <p>{custom ? '告诉我们您现在需要什么，伙伴会尽快到桌确认。' : '这里会直接提醒值班经理，我们会当场了解并处理。'}</p>
    <label><span>{custom ? '补充说明' : '哪里没有照顾好您'}</span><textarea autoFocus maxLength={500} value={detail} onChange={(event) => onDetailChange(event.target.value)} placeholder={custom ? '例如：需要两杯温水' : '简单说说情况，方便我们马上处理'} /></label>
    <button type="button" className="guest-primary" disabled={pending || (custom && detail.trim().length < 2)} onClick={onSubmit}>
      {pending ? <><LoaderCircle className="is-spinning" />正在送达</> : <><Send />提交给现场伙伴</>}
    </button>
  </div>
}

function CheckoutPanel({ result, onClose }: { result: GuestOrderResult; onClose: () => void }) {
  const paymentCopy = paymentStatusCopy(result)
  return <div className="guest-checkout-result">
    <span className="guest-checkout-icon"><Check /></span><small>订单 {result.order.publicId}</small><h3>{paymentCopy.title}</h3><p>{paymentCopy.detail}</p>
    {result.order.attentionRequired && <div className="guest-attention">备注已重点标记给出品和配送人员</div>}
    <div className="guest-checkout-amount"><span>本次应付</span><strong>{formatMoney(result.settlement.payableAmountMinor, result.settlement.currency)}</strong></div>
    <button type="button" className="guest-primary" onClick={onClose}>返回菜单</button>
  </div>
}

function paymentStatusCopy(result: GuestOrderResult): { title: string; detail: string } {
  if (result.payment.status === 'paid') return { title: '支付已经完成', detail: '吧台与收银已经收到付款状态。' }
  if (result.payment.simulated) return { title: '测试订单已建立', detail: '当前是测试支付，仍待人工测试确认，没有产生真实收款。' }
  if (result.payment.mode === 'wechat_jsapi') return { title: '订单已建立，等待微信支付', detail: '支付状态以微信支付通道返回结果为准，请勿重复下单。' }
  return { title: '订单已建立，等待扫码支付', detail: '支付二维码仍待支付通道返回，请勿重复下单。' }
}

function panelTitle(panel: Exclude<Panel, null>): string {
  if (panel === 'orders') return '本桌已点'
  if (panel === 'complaint') return '我们想马上处理好'
  if (panel === 'custom') return '告诉我们您的需要'
  return '订单与支付状态'
}

function resolveDeviceKey(storage: Storage): string {
  const key = 'mbox-normalized-guest-device-v1'
  try {
    const existing = storage.getItem(key)
    if (existing !== null && existing.length >= 8 && existing.length <= 256) return existing
    const created = `guest-web-${crypto.randomUUID()}`
    storage.setItem(key, created)
    return created
  } catch {
    return `guest-web-${crypto.randomUUID()}`
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof GuestApiError ? error.message : fallback
}

function haptic(duration: number): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  navigator.vibrate(duration)
}
