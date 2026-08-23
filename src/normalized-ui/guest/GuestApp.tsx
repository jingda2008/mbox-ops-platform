import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  LoaderCircle,
  MessageCircleWarning,
  Music2,
  RefreshCw,
  ScanLine,
  Send,
  Store,
  WifiOff,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../shared/api-error'
import { MenuOrderingWorkspace, type MenuSubmitOptions } from '../../components/MenuOrderingWorkspace'
import type { MenuRecommendationScene } from '../../shared/contracts'
import {
  GuestApiClient,
  GuestApiError,
  type GuestOrderResult,
  type GuestDailyPerformanceView,
  type OnlinePaymentAction,
  type GuestSessionView,
  type GuestTableOrder,
} from './guest-api'
import {
  formatMoney,
  guestCartStorageKey,
  parseGuestAccess,
  parseGuestTableCode,
  safeIdempotencyKey,
  tokenFreeLocation,
  type GuestMenuProduct,
  type GuestMood,
} from './guest-model'
import { guestGatePresentation, type GuestGateReason } from './guest-gate-model'
import { guestMenuProductToMenuProduct } from './menu-product-adapter'
import './guest-app.css'

type GuestApiPort = Pick<GuestApiClient, 'scanTable' | 'loadSession' | 'searchMenu' | 'submitOrder' | 'loadTableOrders' | 'loadTodayPerformance' | 'payTableOrder' | 'requestService' | 'recordMood'>
type ServiceType = 'call_staff' | 'complaint' | 'custom'
type Panel = 'orders' | 'complaint' | 'custom' | 'checkout' | null
export type { GuestGateReason } from './guest-gate-model'

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
  duplicateWindowSeconds: 45,
  maxOrdersPerMinute: 5,
  requireSubmitConfirmation: true,
  requireContinuationConfirmationSeconds: 120,
} as const

export function GuestApp({ apiFactory }: GuestAppProps) {
  const [phase, setPhase] = useState<'booting' | 'waiting' | 'ready' | 'blocked'>('booting')
  const [gateReason, setGateReason] = useState<GuestGateReason>('connecting')
  const [gateMessage, setGateMessage] = useState('正在连接您的桌位…')
  const [gateRefreshing, setGateRefreshing] = useState(false)
  const [table, setTable] = useState<GuestSessionView['table'] | null>(null)
  const [cartStorageKey, setCartStorageKey] = useState<string | undefined>()
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
  const [moodExpanded, setMoodExpanded] = useState(false)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [orderResult, setOrderResult] = useState<GuestOrderResult | null>(null)
  const [tableOrders, setTableOrders] = useState<GuestTableOrder[]>([])
  const [tableOrdersLoading, setTableOrdersLoading] = useState(false)
  const [performance, setPerformance] = useState<GuestDailyPerformanceView | null>(null)
  const [performanceLoading, setPerformanceLoading] = useState(false)
  const [performanceError, setPerformanceError] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const apiRef = useRef<GuestApiPort | null>(null)
  const tableCodeRef = useRef<string | null>(null)
  const qrCredentialRef = useRef<string | null>(null)
  const menuRequest = useRef(0)
  const orderSubmittingRef = useRef(false)
  const serviceSubmittingRef = useRef(false)
  const paymentSubmittingRef = useRef(new Set<string>())
  const connectingRef = useRef(false)
  const toastSequence = useRef(0)

  const menuProducts = useMemo(() => products.map(guestMenuProductToMenuProduct), [products])

  const notify = useCallback((message: string, tone: ToastState['tone'] = 'info') => {
    setToast({ id: ++toastSequence.current, message, tone })
  }, [])

  const blockForSession = useCallback((error: unknown) => {
    if (error instanceof GuestApiError && (error.status === 401 || error.code === 'TABLE_SESSION_ENDED')) {
      setPhase('blocked')
      setGateReason(error.code.includes('ENDED') ? 'session_ended' : 'scan_required')
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
      if (!blockForSession(error)) {
        notify(
          errorMessage(error, quiet ? '本桌历史订单刚才没有更新，点击右上角可重试。' : '本桌历史订单暂时没有更新，请再试一次。'),
          'error',
        )
      }
    } finally {
      if (!quiet) setTableOrdersLoading(false)
    }
  }, [blockForSession, notify])

  const loadPerformance = useCallback(async () => {
    const api = apiRef.current
    if (api === null) return
    setPerformanceLoading(true)
    setPerformanceError(null)
    try {
      setPerformance(await api.loadTodayPerformance())
    } catch (error) {
      if (!blockForSession(error)) {
        setPerformanceError(errorMessage(error, '演出信息暂时没有更新，点一下可重试。'))
      }
    } finally {
      setPerformanceLoading(false)
    }
  }, [blockForSession])

  const payTableOrder = useCallback(async (orderPublicId: string) => {
    const api = apiRef.current
    if (api === null || paymentSubmittingRef.current.has(orderPublicId)) return
    paymentSubmittingRef.current.add(orderPublicId)
    haptic(8)
    try {
      const action = await api.payTableOrder(orderPublicId, {
        idempotencyKey: safeIdempotencyKey(`guest-pay-${orderPublicId}`),
      })
      if (action.status === 'failed') {
        notify('支付机构刚才没有受理，订单仍在本桌，可以重新发起付款。', 'info')
        await loadTableOrders(true)
        return
      }
      if (action.status === 'unknown') {
        notify('付款结果暂时无法确认，请先让收银核对，避免重复付款。', 'info')
        await loadTableOrders(true)
        return
      }
      if (action.payload === null) {
        notify('订单已经同步，付款入口正在准备，请稍后从“本桌历史订单”继续。', 'info')
        return
      }
      if (action.payload.presentation === 'simulation') {
        notify('测试付款流程已完成，未产生真实扣款。', 'success')
        await loadTableOrders(true)
        return
      }
      await presentOnlinePayment(action)
      notify(action.presentation === 'qr' ? '正在打开微信收银台。' : '付款已发起，请按微信页面完成。', 'success')
    } catch (error) {
      if (!blockForSession(error)) notify(errorMessage(error, '付款暂时没有发起，请稍后再试。'), 'error')
    } finally {
      paymentSubmittingRef.current.delete(orderPublicId)
    }
  }, [blockForSession, loadTableOrders, notify])

  const acceptSession = useCallback((session: GuestSessionView, expectedTable: string) => {
    if (session.table.code.toUpperCase() !== expectedTable.toUpperCase()) {
      setPhase('blocked')
      setGateReason('table_mismatch')
      setGateMessage('当前会话与桌号不一致，请重新扫描所在桌面的二维码。')
      return false
    }
    setTable(session.table)
    if (session.status === 'waiting_for_table') {
      setCartStorageKey(undefined)
      setPhase('waiting')
      setGateReason('waiting')
      setGateMessage(session.message ?? '座位正在准备中，请稍候。')
      return false
    }
    setCartStorageKey(guestCartStorageKey(session))
    qrCredentialRef.current = null
    setPhase('ready')
    return true
  }, [])

  const connectTable = useCallback(async (quiet = false) => {
    const api = apiRef.current
    const expectedTable = tableCodeRef.current
    if (api === null || expectedTable === null || connectingRef.current) return
    connectingRef.current = true
    if (quiet) {
      setGateRefreshing(true)
    } else {
      setPhase('booting')
      setGateReason('connecting')
      setGateMessage('正在连接您的桌位…')
    }
    try {
      const credential = qrCredentialRef.current
      const session = credential === null ? await api.loadSession() : await api.scanTable(credential)
      acceptSession(session, expectedTable)
    } catch (error) {
      if (quiet && error instanceof GuestApiError && error.retryable) {
        setGateMessage('网络刚才有点慢，我们会继续自动更新。')
        return
      }
      setPhase('blocked')
      setGateReason(classifyGateError(error))
      setGateMessage(errorMessage(error, '暂时没有连接上桌边服务，请重试。'))
    } finally {
      connectingRef.current = false
      setGateRefreshing(false)
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
      setGateReason('scan_required')
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
    void loadPerformance()
  }, [loadMenu, loadPerformance, loadTableOrders, phase])

  useEffect(() => {
    if (phase !== 'waiting') return
    const refresh = () => { if (document.visibilityState === 'visible') void connectTable(true) }
    const timer = window.setInterval(refresh, 8_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [connectTable, phase])

  useEffect(() => {
    if (phase !== 'ready' || (panel !== 'orders' && panel !== 'checkout')) return
    const refresh = () => { if (document.visibilityState === 'visible') void loadTableOrders(true) }
    const timer = window.setInterval(refresh, panel === 'checkout' ? 2_000 : 8_000)
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
        {
          items,
          note: options.fulfillmentNote || null,
          ...(options.confirmedDuplicateOrderId
            ? { confirmedDuplicateOrderId: options.confirmedDuplicateOrderId }
            : {}),
        },
        { idempotencyKey: safeIdempotencyKey('guest-order') },
      )
      setOrderResult(result)
      setPanel('checkout')
      void loadTableOrders(true)
      notify('订单已经送达吧台与收银，请完成付款。', 'success')
      if (!result.payment.simulated
        && result.payment.providerAction.status === 'pending'
        && result.payment.providerAction.payload !== null) {
        try {
          await presentOnlinePayment(result.payment.providerAction)
        } catch (paymentError) {
          notify(errorMessage(paymentError, '订单已建立，付款暂未拉起，可在“本桌历史订单”继续支付。'), 'info')
        }
      }
    } catch (error) {
      if (error instanceof GuestApiError
        && error.code === 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED') {
        throw new ApiError(error.message, error.status ?? 409, error.code, error.details)
      }
      if (blockForSession(error)) {
        throw new ApiError('订单没有提交，已为您保留购物车。重新扫码并开台后可继续。', 401, 'GUEST_SESSION_RECONNECT_REQUIRED')
      }
      throw error
    } finally {
      orderSubmittingRef.current = false
      setSubmittingOrder(false)
    }
  }, [blockForSession, loadTableOrders, notify, tableOrders])

  if (phase !== 'ready') {
    return <GuestGate
      reason={gateReason}
      message={gateMessage}
      table={table}
      refreshing={gateRefreshing}
      onRetry={() => void connectTable(phase === 'waiting')}
    />
  }

  return (
    <main className="guest-app guest-app-restored-menu" data-testid="normalized-guest-app">
      <h1 className="guest-page-title">M-BOX {table?.displayName ?? table?.code} 桌边点单</h1>
      <header className="guest-header">
        <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · LIVEHOUSE</small></div></div>
        <button type="button" className="guest-table" onClick={() => { setPanel('orders'); void loadTableOrders() }}>
          <small>历史已下单 · {tableOrders.reduce((sum, order) => sum + order.items.reduce((count, item) => count + item.quantity, 0), 0)}件</small>
          <strong>{table?.displayName ?? table?.code}</strong>
        </button>
      </header>

      <GuestPerformanceCard
        performance={performance}
        loading={performanceLoading}
        error={performanceError}
        onRetry={() => void loadPerformance()}
      />

      <section className={`guest-mood${moodExpanded ? ' is-expanded' : ''}`} aria-labelledby="guest-mood-title">
        <button className="guest-mood-toggle" type="button" aria-expanded={moodExpanded} onClick={() => setMoodExpanded((value) => !value)}>
          <span><small>可选</small><strong id="guest-mood-title">记录今晚心情</strong></span>
          <span>{selectedMood === null ? '用于优化推荐' : `已选：${moods.find((item) => item.code === selectedMood)?.label ?? '已记录'}`}</span>
          <ChevronRight aria-hidden="true" />
        </button>
        {moodExpanded && <div className={selectedMood === null ? 'guest-mood-options' : 'guest-mood-options has-selection'}>
          {moods.map((mood) => <button
            type="button"
            key={mood.code}
            className={selectedMood === mood.code ? 'is-selected' : ''}
            aria-pressed={selectedMood === mood.code}
            aria-label={`心情：${mood.label}`}
            onClick={() => void selectMood(mood.code)}
          ><img src={`/brand/moods-v2/${mood.asset}.webp`} alt="" aria-hidden="true" decoding="async" /><small>{mood.label}</small></button>)}
        </div>}
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

      {menuError !== null && <div className="guest-inline-error" role="alert"><AlertCircle /><span>{menuError}</span><button type="button" onClick={() => void loadMenu()}>重试</button></div>}
      {menuLoading && menuProducts.length === 0 ? <div className="guest-menu-loading"><LoaderCircle className="is-spinning" /> 正在准备菜单</div> : (
        <MenuOrderingWorkspace
          key={cartStorageKey}
          products={menuProducts}
          tableLabel={table?.displayName ?? table?.code ?? ''}
          submitLabel="确认订单并微信支付"
          submitHint="这里只提交本次购物车；历史订单不会重复提交。"
          busy={submittingOrder}
          orderSafety={guestOrderSafety}
          compactCart
          deemphasizeCollapsedTotal
          guestSalesMode
          partySize={partySize}
          recommendationScene={recommendationScene}
          cartStorageKey={cartStorageKey}
          onSubmit={submitOrder}
        />
      )}

      {panel !== null && <GuestPanel title={panelTitle(panel)} onClose={() => panel !== 'checkout' && setPanel(null)} dismissible={panel !== 'checkout'}>
        {panel === 'orders' && <TableOrdersPanel orders={tableOrders} loading={tableOrdersLoading} onRefresh={() => void loadTableOrders()} onPay={(orderId) => void payTableOrder(orderId)} />}
        {(panel === 'complaint' || panel === 'custom') && <ServicePanel
          kind={panel}
          detail={serviceDetail}
          pending={pendingService !== null}
          onDetailChange={setServiceDetail}
          onSubmit={() => void requestService(panel, serviceDetail.trim() || null)}
        />}
        {panel === 'checkout' && orderResult !== null && <CheckoutPanel
          result={orderResult}
          tableOrder={tableOrders.find((order) => order.publicId === orderResult.order.publicId) ?? null}
          onRetryPayment={() => void payTableOrder(orderResult.order.publicId)}
          onClose={() => setPanel(null)}
        />}
      </GuestPanel>}

      {toast !== null && <div className={`guest-toast is-${toast.tone}`} role="status"><Check />{toast.message}</div>}
    </main>
  )
}

function GuestPerformanceCard({
  performance,
  loading,
  error,
  onRetry,
}: {
  performance: GuestDailyPerformanceView | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  if (performance === null && loading) {
    return <section className="guest-performance-card is-loading" aria-label="正在加载今晚演出">
      <LoaderCircle className="is-spinning" aria-hidden="true" />
      <span><strong>正在同步今晚演出</strong><small>菜单仍可正常浏览</small></span>
    </section>
  }
  if (performance === null && error !== null) {
    return <section className="guest-performance-card is-error" aria-label="演出信息暂时未更新">
      <Music2 aria-hidden="true" />
      <span><strong>演出信息暂未更新</strong><small>{error}</small></span>
      <button type="button" onClick={onRetry}>重试</button>
    </section>
  }
  if (performance === null || performance.schedules.length === 0) {
    return <section className="guest-performance-card is-empty" aria-label="今晚演出">
      <Music2 aria-hidden="true" />
      <span><strong>今晚暂无演出排班</strong><small>门店更新后会显示在这里，点单不受影响</small></span>
    </section>
  }

  const featured = performance.current ?? performance.next ?? performance.schedules.at(-1)!
  const stateLabel = performance.current !== null
    ? 'LIVE · 正在演出'
    : performance.next !== null
      ? 'UP NEXT · 即将开始'
      : 'TONIGHT · 今晚演出'
  return <section className={`guest-performance-card is-${performance.phase}`} aria-labelledby="guest-performance-title">
    {featured.performerProfile.imageUrl === undefined
      ? <span className="guest-performance-cover"><Music2 aria-hidden="true" /></span>
      : <img className="guest-performance-cover" src={featured.performerProfile.imageUrl} alt="" decoding="async" />}
    <span className="guest-performance-copy">
      <small>{stateLabel}</small>
      <strong id="guest-performance-title">{featured.performerStageName}</strong>
      <span><Clock3 aria-hidden="true" />{formatShanghaiClock(featured.startsAt)}–{formatShanghaiClock(featured.endsAt)}</span>
    </span>
    {performance.next !== null && performance.current !== null && <span className="guest-performance-next">
      <small>下一场</small><strong>{performance.next.performerStageName}</strong><span>{formatShanghaiClock(performance.next.startsAt)}</span>
    </span>}
  </section>
}

function formatShanghaiClock(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function findRecentDuplicateOrder(
  orders: readonly GuestTableOrder[],
  items: readonly { productId: string; quantity: number }[],
): { orderId: string; names: string[] } | null {
  const cutoff = Date.now() - guestOrderSafety.duplicateWindowSeconds * 1_000
  const requested = basketFingerprint(items)
  for (const order of orders) {
    if (Date.parse(order.createdAt) < cutoff) continue
    const activeItems = order.items.filter((item) => item.status !== 'cancelled')
    const ordered = basketFingerprint(activeItems)
    if (ordered !== requested) continue
    return { orderId: order.publicId, names: [...new Set(activeItems.map((item) => item.name))] }
  }
  return null
}

function basketFingerprint(items: readonly { productId: string; quantity: number }[]): string {
  return [...items]
    .sort((left, right) => left.productId.localeCompare(right.productId))
    .map((item) => `${item.productId}:${item.quantity}`)
    .join('|')
}

export function GuestGate({ reason, message, table, refreshing, onRetry }: {
  reason: GuestGateReason
  message: string
  table: GuestSessionView['table'] | null
  refreshing: boolean
  onRetry: () => void
}) {
  const content = guestGatePresentation(reason, table, message)
  const Icon = reason === 'connecting' ? LoaderCircle
    : reason === 'waiting' ? CheckCircle2
      : reason === 'scan_required' ? ScanLine
        : reason === 'temporary_failure' ? WifiOff
          : reason === 'session_ended' ? Store
            : AlertCircle

  return <main className="guest-gate">
    <header className="guest-gate-header">
      <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · LIVEHOUSE</small></div></div>
      <span className="guest-gate-service"><Store />桌边服务</span>
    </header>
    <section className={`is-${reason}`} role={content.alert ? 'alert' : 'status'} aria-live="polite">
      <div className="guest-gate-kicker"><span />{content.kicker}</div>
      <span className="guest-gate-icon"><Icon className={reason === 'connecting' ? 'is-spinning' : ''} /></span>
      <h1>{content.title}</h1>
      <p>{content.description}</p>
      {reason === 'waiting' && <div className="guest-gate-progress" aria-label="桌位连接进度">
        <span className="is-done"><Check />桌位已识别</span><i />
        <span className="is-current"><LoaderCircle className="is-spinning" />等待开台</span><i />
        <span><Store />进入菜单</span>
      </div>}
      {content.note !== null && <div className="guest-gate-note">{content.note}</div>}
      {content.action !== null && <button type="button" onClick={onRetry} disabled={refreshing}>
        <RefreshCw className={refreshing ? 'is-spinning' : ''} />{refreshing ? '正在更新' : content.action}
      </button>}
    </section>
    <footer><span />M-BOX 服务在线</footer>
  </main>
}

function classifyGateError(error: unknown): GuestGateReason {
  if (!(error instanceof GuestApiError)) return 'temporary_failure'
  if (error.code.includes('ENDED')) return 'session_ended'
  if (error.status === 401 || error.status === 404 || error.code.includes('QR_')) return 'scan_required'
  return 'temporary_failure'
}

function GuestPanel({ title, dismissible, onClose, children }: { title: string; dismissible: boolean; onClose: () => void; children: React.ReactNode }) {
  return <div className="guest-panel-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose() }}>
    <section className="guest-panel" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2>{dismissible && <button type="button" aria-label="关闭" onClick={onClose}><X /></button>}</header>
      {children}
    </section>
  </div>
}

function TableOrdersPanel({ orders, loading, onRefresh, onPay }: { orders: GuestTableOrder[]; loading: boolean; onRefresh: () => void; onPay: (orderPublicId: string) => void }) {
  return <div className="guest-table-orders">
    <div className="guest-table-orders-toolbar"><span>{orders.length === 0 ? '还没有已确认的订单' : `共 ${orders.length} 轮`}</span><button type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'is-spinning' : ''} />刷新</button></div>
    {orders.map((order) => <article key={order.publicId} data-testid={`guest-table-order-${order.publicId}`}>
      <header><strong>{`本桌第 ${order.round} 轮 · ${orderSourceCopy(order)}`}</strong><span>{orderStatusCopy(order)}</span></header>
      <div>{order.items.map((item) => <p key={item.productId}><span>{item.name} × {item.quantity}</span><small>{itemStatusCopy(item.status)}</small></p>)}</div>
      {order.payableAmountMinor > 0 && order.paymentAccess === 'available' && <button type="button" className="guest-primary guest-order-pay" onClick={() => onPay(order.publicId)}>
        微信支付 {formatMoney(order.payableAmountMinor, order.currency)}
      </button>}
      {order.paymentAccess !== 'available' && order.paymentAccess !== 'not_required' && <small className="guest-order-payment-state">{paymentAccessCopy(order.paymentAccess)}</small>}
    </article>)}
  </div>
}

function orderStatusCopy(order: GuestTableOrder): string {
  if (order.paymentAccess === 'staff_collecting') return '员工收款中'
  if (order.paymentAccess === 'payment_in_progress') return '付款进行中'
  if (order.paymentAccess === 'status_review') return '等待收银核对'
  if (order.paymentAccess === 'available' && order.payableAmountMinor > 0) return '等待付款'
  if (order.paymentStatus === 'unpaid' || order.paymentStatus === 'pending' || order.paymentStatus === 'partially_paid') return '等待付款'
  if (order.status === 'completed') return '已完成'
  return order.items.every((item) => item.status === 'delivered' || item.status === 'cancelled') ? '已送齐' : '准备中'
}

function orderSourceCopy(order: GuestTableOrder): string {
  if (order.channel === 'staff_assisted') return '服务员协助点单'
  if (order.channel === 'guest_qr') return order.isMine ? '我提交的' : '同桌客人提交'
  if (order.channel === 'cashier') return '收银台录入'
  if (order.channel === 'reservation') return '预约订单'
  return '门店订单'
}

function paymentAccessCopy(access: GuestTableOrder['paymentAccess']): string {
  if (access === 'staff_collecting') return '员工正在扫描付款码，请勿重复支付。'
  if (access === 'payment_in_progress') return '同桌已有付款正在进行，请勿重复发起。'
  return '付款状态需要收银核对，请勿重复支付。'
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

function CheckoutPanel({ result, tableOrder, onRetryPayment, onClose }: {
  result: GuestOrderResult
  tableOrder: GuestTableOrder | null
  onRetryPayment: () => void
  onClose: () => void
}) {
  const paymentCopy = paymentStatusCopy(result, tableOrder)
  return <div className="guest-checkout-result">
    <span className="guest-checkout-icon"><Check /></span><small>订单 {result.order.publicId}</small><h3>{paymentCopy.title}</h3><p>{paymentCopy.detail}</p>
    <small>付款状态每 2 秒自动核对，以支付通道和本桌账单为准</small>
    {result.order.attentionRequired && <div className="guest-attention">{result.order.kdsNotice ?? '备注已保存，付款成功后同步给出品和配送人员'}</div>}
    <div className="guest-checkout-amount"><span>本次应付</span><strong>{formatMoney(result.settlement.payableAmountMinor, result.settlement.currency)}</strong></div>
    {!result.payment.simulated && result.payment.providerAction.status === 'pending' && result.payment.providerAction.payload !== null && <button type="button" className="guest-primary" onClick={() => void presentOnlinePayment(result.payment.providerAction)}>
      {result.payment.providerAction.presentation === 'jsapi' ? '打开微信支付' : '去微信支付'}
    </button>}
    {!result.payment.simulated && result.payment.providerAction.status === 'failed' && <button type="button" className="guest-primary" onClick={onRetryPayment}>
      重新发起付款
    </button>}
    <button type="button" className="guest-secondary" onClick={onClose}>返回菜单</button>
  </div>
}

async function presentOnlinePayment(action: OnlinePaymentAction): Promise<void> {
  if (action.status !== 'pending') {
    throw new GuestApiError('当前付款状态需要先核对，请勿重复支付。', 'http', 409, 'PAYMENT_STATUS_REVIEW_REQUIRED')
  }
  if (action.presentation === 'qr') {
    const paymentUrl = typeof action.payload?.qrCodeUrl === 'string' ? action.payload.qrCodeUrl : ''
    if (!/^https:\/\//i.test(paymentUrl)) {
      throw new GuestApiError('付款入口暂时没有准备好，请稍后再试。', 'invalid_response', 409, 'PAYMENT_URL_UNAVAILABLE')
    }
    window.location.assign(paymentUrl)
    return
  }
  if (action.presentation !== 'jsapi' || action.payload === null) return
  const bridge = (window as typeof window & { WeixinJSBridge?: { invoke(name: string, params: Record<string, unknown>, callback: (result: { err_msg?: string }) => void): void } }).WeixinJSBridge
  if (bridge === undefined) throw new GuestApiError('请在微信内打开后付款，或选择扫码支付。', 'invalid_response', 409, 'WECHAT_BRIDGE_UNAVAILABLE')
  const params = action.payload
  await new Promise<void>((resolve, reject) => {
    bridge.invoke('getBrandWCPayRequest', params, (result) => {
      if (result.err_msg === 'get_brand_wcpay_request:ok') resolve()
      else if (result.err_msg === 'get_brand_wcpay_request:cancel') reject(new GuestApiError('付款已取消，订单仍为待付款。', 'http', 409, 'PAYMENT_CANCELLED'))
      else reject(new GuestApiError('微信支付没有完成，请勿重复下单。', 'http', 409, 'PAYMENT_NOT_COMPLETED'))
    })
  })
}

export function paymentStatusCopy(result: GuestOrderResult, tableOrder: GuestTableOrder | null): { title: string; detail: string } {
  if (tableOrder?.paymentStatus === 'paid') return { title: '支付已经完成', detail: '吧台与收银已经收到付款状态。' }
  if (tableOrder?.paymentAccess === 'status_review') return { title: '订单已建立，付款状态待核对', detail: '系统正在向支付机构核对结果，请勿重复付款。' }
  if (result.payment.status === 'paid') return { title: '支付已经完成', detail: '吧台与收银已经收到付款状态。' }
  if (result.payment.simulated) return { title: '测试订单已建立', detail: '当前是测试支付，仍待人工测试确认，没有产生真实收款。' }
  if (result.payment.providerAction.status === 'failed') return { title: '订单已建立，付款尚未发起', detail: '支付机构刚才没有受理，可在本桌订单中重新发起，不需要重复下单。' }
  if (result.payment.providerAction.status === 'unknown') return { title: '订单已建立，付款状态待核对', detail: '请先让收银核对支付结果，避免重复付款。' }
  if (result.payment.providerAction.payload === null) return { title: '订单已建立，正在准备付款', detail: '本桌订单已经同步，请稍后从“本桌历史订单”继续。' }
  if (result.payment.mode === 'wechat_jsapi') return { title: '订单已建立，等待微信支付', detail: '支付状态以微信支付通道返回结果为准，请勿重复下单。' }
  return { title: '订单已建立，等待扫码支付', detail: '支付二维码仍待支付通道返回，请勿重复下单。' }
}

function panelTitle(panel: Exclude<Panel, null>): string {
  if (panel === 'orders') return '本桌历史订单'
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
