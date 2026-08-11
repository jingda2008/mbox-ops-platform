import {
  AlertCircle,
  Bell,
  Check,
  ChevronRight,
  LoaderCircle,
  MessageCircleWarning,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shuffle,
  Sparkles,
  ShoppingBag,
  Store,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GuestApiClient, GuestApiError, type GuestOrderResult, type GuestSessionView } from './guest-api'
import {
  addCartProduct,
  cartItemCount,
  cartLines,
  cartOrderItems,
  cartTotalMinor,
  categoryLabel,
  changeCartQuantity,
  formatMoney,
  menuRequestDelayMs,
  parseGuestAccess,
  parseGuestTableCode,
  safeIdempotencyKey,
  tokenFreeLocation,
  type GuestCart,
  type GuestMenuProduct,
  type GuestMood,
} from './guest-model'
import { rankRecommendations, type RecommendationIntent } from './recommendation-ranking'
import './guest-app.css'

type GuestApiPort = Pick<GuestApiClient, 'scanTable' | 'loadSession' | 'searchMenu' | 'submitOrder' | 'requestService' | 'recordMood'>
type ServiceType = 'call_staff' | 'complaint' | 'custom'
type Panel = 'cart' | 'complaint' | 'custom' | 'checkout' | 'quick' | 'shake' | null

export interface GuestAppProps {
  apiFactory?: (deviceKey: string) => GuestApiPort
}

interface ToastState {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
}

const moods: ReadonlyArray<{ code: GuestMood; emoji: string; label: string }> = [
  { code: 'happy', emoji: '☺', label: '开心' },
  { code: 'excited', emoji: '✦', label: '兴奋' },
  { code: 'listening', emoji: '♫', label: '听歌' },
  { code: 'social', emoji: '✧', label: '想互动' },
  { code: 'celebrating', emoji: '★', label: '庆祝' },
  { code: 'quiet', emoji: '☾', label: '安静' },
]

export function GuestApp({ apiFactory }: GuestAppProps) {
  const [phase, setPhase] = useState<'booting' | 'waiting' | 'ready' | 'blocked'>('booting')
  const [gateMessage, setGateMessage] = useState('正在连接您的桌位…')
  const [table, setTable] = useState<GuestSessionView['table'] | null>(null)
  const [products, setProducts] = useState<GuestMenuProduct[]>([])
  const [menuLoading, setMenuLoading] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
  const [cart, setCart] = useState<GuestCart>({})
  const [panel, setPanel] = useState<Panel>(null)
  const [orderNote, setOrderNote] = useState('')
  const [serviceDetail, setServiceDetail] = useState('')
  const [pendingService, setPendingService] = useState<ServiceType | null>(null)
  const [selectedMood, setSelectedMood] = useState<GuestMood | null>(null)
  const [recommendationIntent, setRecommendationIntent] = useState<RecommendationIntent | null>(null)
  const [shakeProductId, setShakeProductId] = useState<string | null>(null)
  const [shakeCount, setShakeCount] = useState(0)
  const [pendingMood, setPendingMood] = useState<GuestMood | null>(null)
  const [submittingOrder, setSubmittingOrder] = useState(false)
  const [orderResult, setOrderResult] = useState<GuestOrderResult | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const apiRef = useRef<GuestApiPort | null>(null)
  const tableCodeRef = useRef<string | null>(null)
  const qrCredentialRef = useRef<string | null>(null)
  const menuRequest = useRef(0)
  const initialMenuRequested = useRef(false)
  const orderAttemptKey = useRef<string | null>(null)
  const orderSubmittingRef = useRef(false)
  const serviceSubmittingRef = useRef(false)
  const toastSequence = useRef(0)

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

  const loadMenu = useCallback(async (query: string) => {
    const api = apiRef.current
    if (api === null) return
    const requestId = ++menuRequest.current
    setMenuLoading(true)
    setMenuError(null)
    try {
      const next = await api.searchMenu(query)
      if (requestId !== menuRequest.current) return
      setProducts(next)
      setActiveCategory('all')
    } catch (error) {
      if (requestId !== menuRequest.current || blockForSession(error)) return
      setMenuError(errorMessage(error, '菜单暂时没有加载出来，请再试一次。'))
    } finally {
      if (requestId === menuRequest.current) setMenuLoading(false)
    }
  }, [blockForSession])

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
    initialMenuRequested.current = false
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
    const delay = menuRequestDelayMs(initialMenuRequested.current)
    initialMenuRequested.current = true
    if (delay === 0) {
      void loadMenu(search)
      return
    }
    const timer = window.setTimeout(() => void loadMenu(search), delay)
    return () => window.clearTimeout(timer)
  }, [loadMenu, phase, search])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 3_200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const categories = useMemo(() => Array.from(new Set(products.map((item) => item.categoryCode))), [products])
  const visibleProducts = activeCategory === 'all'
    ? products
    : products.filter((item) => item.categoryCode === activeCategory)
  const itemCount = cartItemCount(cart)
  const totalMinor = cartTotalMinor(cart)
  const recommendations = useMemo(
    () => rankRecommendations(products, recommendationIntent).slice(0, 3),
    [products, recommendationIntent],
  )
  const shakeProduct = products.find((product) => product.productId === shakeProductId) ?? null

  const shakeRecommendation = useCallback(() => {
    const candidates = rankRecommendations(products, 'explore')
    if (candidates.length === 0) return notify('今晚的推荐还在准备中，请直接看看菜单。', 'info')
    if (shakeCount >= 3) return notify('今晚的三次灵感已经送到，挑一款喜欢的就好。', 'info')
    const random = new Uint32Array(1)
    crypto.getRandomValues(random)
    const chosen = candidates[Number(random[0]) % Math.min(candidates.length, 8)]!
    setShakeProductId(chosen.productId)
    setShakeCount((count) => count + 1)
    setPanel('shake')
    haptic(18)
  }, [notify, products, shakeCount])

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

  const submitOrder = useCallback(async () => {
    const api = apiRef.current
    if (api === null || itemCount === 0 || submittingOrder || orderSubmittingRef.current) return
    orderSubmittingRef.current = true
    const attemptKey = orderAttemptKey.current ?? safeIdempotencyKey('guest-order')
    orderAttemptKey.current = attemptKey
    setSubmittingOrder(true)
    haptic(8)
    try {
      const result = await api.submitOrder(
        { items: cartOrderItems(cart), note: orderNote.trim() || null },
        { idempotencyKey: attemptKey },
      )
      setOrderResult(result)
      setCart({})
      setOrderNote('')
      setPanel('checkout')
      orderAttemptKey.current = null
      notify('订单已经送达吧台与收银。', 'success')
    } catch (error) {
      if (error instanceof GuestApiError && error.kind === 'http' && error.status !== 429 && error.status !== null) {
        orderAttemptKey.current = null
      }
      if (!blockForSession(error)) notify(errorMessage(error, '订单没有提交成功，购物车已为您保留。'), 'error')
    } finally {
      orderSubmittingRef.current = false
      setSubmittingOrder(false)
    }
  }, [blockForSession, cart, itemCount, notify, orderNote, submittingOrder])

  if (phase !== 'ready') {
    return <GuestGate phase={phase} message={gateMessage} table={table} onRetry={() => void connectTable()} />
  }

  return (
    <main className="guest-app" data-testid="normalized-guest-app">
      <header className="guest-header">
        <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>LIVEHOUSE · LUJIAZUI</small></div></div>
        <div className="guest-table"><small>当前桌台</small><strong>{table?.displayName ?? table?.code}</strong></div>
      </header>

      <section className="guest-welcome" aria-labelledby="guest-menu-title">
        <p>今晚，喝点喜欢的</p>
        <h1 id="guest-menu-title">点单与桌边服务</h1>
      </section>

      <section className="guest-mood" aria-labelledby="guest-mood-title">
        <div><small>YOUR MOOD</small><h2 id="guest-mood-title">今晚是什么状态？</h2></div>
        <div className={selectedMood === null ? 'guest-mood-options' : 'guest-mood-options has-selection'}>
          {moods.map((mood) => (
            <button
              type="button"
              key={mood.code}
              className={selectedMood === mood.code ? 'is-selected' : ''}
              aria-pressed={selectedMood === mood.code}
              aria-label={`心情：${mood.label}`}
              onClick={() => void selectMood(mood.code)}
            >
              <span aria-hidden="true">{mood.emoji}</span><small>{mood.label}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="guest-service-strip" aria-label="桌边服务">
        <button type="button" disabled={pendingService !== null} onClick={() => void requestService('call_staff', null)}>
          {pendingService === 'call_staff' ? <LoaderCircle className="is-spinning" /> : <Bell />}
          <span>呼叫服务员</span>
        </button>
        <button type="button" disabled={pendingService !== null} onClick={() => { setServiceDetail(''); setPanel('complaint') }}>
          <MessageCircleWarning /><span>投诉 / 不满意</span>
        </button>
        <button type="button" disabled={pendingService !== null} onClick={() => { setServiceDetail(''); setPanel('custom') }}>
          <Send /><span>个性需求</span>
        </button>
      </section>

      <section className="guest-choice-strip" aria-label="选酒灵感">
        <button type="button" onClick={() => setPanel('quick')}><Sparkles /><span><strong>帮我快速选</strong><small>几个简单选择</small></span></button>
        <button type="button" onClick={shakeRecommendation}><Shuffle /><span><strong>摇一摇喝什么</strong><small>{shakeCount}/3 次灵感</small></span></button>
      </section>

      <section className="guest-menu-tools" aria-label="查找菜单">
        <label className="guest-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索酒水、小食或口味"
            aria-label="搜索所有商品"
          />
          {search !== '' && <button type="button" aria-label="清空搜索" onClick={() => setSearch('')}><X /></button>}
        </label>
        <div className="guest-categories" role="group" aria-label="商品分类">
          <button type="button" className={activeCategory === 'all' ? 'is-active' : ''} onClick={() => setActiveCategory('all')}>全部</button>
          {categories.map((category) => (
            <button type="button" key={category} className={activeCategory === category ? 'is-active' : ''} onClick={() => setActiveCategory(category)}>
              {categoryLabel(category)}
            </button>
          ))}
        </div>
      </section>

      {search === '' && activeCategory === 'all' && recommendations.length > 0 && (
        <RecommendationSection
          products={recommendations}
          intent={recommendationIntent}
          cart={cart}
          onAdd={(product) => {
            orderAttemptKey.current = null
            setCart((current) => addCartProduct(current, product))
            haptic(5)
          }}
        />
      )}

      <section className="guest-product-section" aria-live="polite" aria-busy={menuLoading}>
        {menuError !== null && (
          <div className="guest-inline-error"><AlertCircle /><span>{menuError}</span><button type="button" onClick={() => void loadMenu(search)}>重试</button></div>
        )}
        {menuLoading && products.length === 0 ? <MenuSkeleton /> : (
          <div className="guest-products">
            {visibleProducts.map((product) => {
              const quantity = cart[product.productId]?.quantity ?? 0
              return (
                <article className="guest-product" key={product.productId}>
                  <ProductVisual product={product} />
                  <div className="guest-product-copy">
                    <small>{categoryLabel(product.categoryCode)}{product.specification ? ` · ${product.specification}` : ''}</small>
                    <h3>{product.name}</h3>
                    {product.description && <p>{product.description}</p>}
                    <div className="guest-product-bottom">
                      <strong>{formatMoney(product.amountMinor, product.currency)}</strong>
                      {quantity === 0 ? (
                        <button type="button" className="guest-add" aria-label={`加入${product.name}`} onClick={() => { orderAttemptKey.current = null; setCart((current) => addCartProduct(current, product)); haptic(5) }}>
                          <Plus />
                        </button>
                      ) : (
                        <QuantityControl
                          name={product.name}
                          quantity={quantity}
                          onMinus={() => { orderAttemptKey.current = null; setCart((current) => changeCartQuantity(current, product.productId, -1)) }}
                          onPlus={() => { orderAttemptKey.current = null; setCart((current) => changeCartQuantity(current, product.productId, 1)) }}
                        />
                      )}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
        {!menuLoading && menuError === null && visibleProducts.length === 0 && (
          <div className="guest-empty"><Search /><strong>没有找到相关商品</strong><span>换个商品名、分类或规格试试</span></div>
        )}
      </section>

      <div className={itemCount > 0 ? 'guest-cart-bar is-visible' : 'guest-cart-bar'} aria-hidden={itemCount === 0}>
        <button type="button" className="guest-cart-summary" disabled={itemCount === 0} onClick={() => setPanel('cart')}>
          <ShoppingBag /><span className="guest-cart-count">{itemCount}</span>
          <span><strong>{itemCount} 件已选</strong><small>{formatMoney(totalMinor)}</small></span>
        </button>
        <button type="button" className="guest-checkout-button" disabled={itemCount === 0} onClick={() => setPanel('cart')}>
          核对订单<ChevronRight />
        </button>
      </div>

      {panel !== null && (
        <GuestPanel title={panelTitle(panel)} onClose={() => panel !== 'checkout' && setPanel(null)} dismissible={panel !== 'checkout'}>
          {panel === 'cart' && (
            <CartPanel
              cart={cart}
              note={orderNote}
              submitting={submittingOrder}
              onNoteChange={(value) => { orderAttemptKey.current = null; setOrderNote(value) }}
              onChangeQuantity={(productId, delta) => { orderAttemptKey.current = null; setCart((current) => changeCartQuantity(current, productId, delta)) }}
              onSubmit={() => void submitOrder()}
            />
          )}
          {(panel === 'complaint' || panel === 'custom') && (
            <ServicePanel
              kind={panel}
              detail={serviceDetail}
              pending={pendingService !== null}
              onDetailChange={setServiceDetail}
              onSubmit={() => void requestService(panel, serviceDetail.trim() || null)}
            />
          )}
          {panel === 'quick' && (
            <QuickChoicePanel onChoose={(intent) => {
              setRecommendationIntent(intent)
              setPanel(null)
              notify('已经按今晚的状态换了一组推荐。', 'success')
              globalThis.setTimeout(() => document.querySelector('.guest-recommendations')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
            }} />
          )}
          {panel === 'shake' && shakeProduct !== null && (
            <ShakeChoicePanel product={shakeProduct} onAdd={() => {
              orderAttemptKey.current = null
              setCart((current) => addCartProduct(current, shakeProduct))
              setPanel(null)
              notify(`${shakeProduct.name} 已加入购物车。`, 'success')
              haptic(5)
            }} />
          )}
          {panel === 'checkout' && orderResult !== null && (
            <CheckoutPanel result={orderResult} onClose={() => setPanel(null)} />
          )}
        </GuestPanel>
      )}

      {toast !== null && <div className={`guest-toast is-${toast.tone}`} role="status"><Check />{toast.message}</div>}
    </main>
  )
}

function GuestGate({
  phase,
  message,
  table,
  onRetry,
}: {
  phase: 'booting' | 'waiting' | 'blocked'
  message: string
  table: GuestSessionView['table'] | null
  onRetry: () => void
}) {
  return (
    <main className="guest-gate">
      <div className="guest-brand"><span>M</span><div><strong>M-BOX</strong><small>LIVEHOUSE · LUJIAZUI</small></div></div>
      <section>
        <span className="guest-gate-icon">{phase === 'booting' ? <LoaderCircle className="is-spinning" /> : phase === 'waiting' ? <Store /> : <AlertCircle />}</span>
        <small>{table?.displayName ?? '桌边服务'}</small>
        <h1>{phase === 'booting' ? '正在为您准备' : phase === 'waiting' ? '座位正在准备' : '需要重新连接'}</h1>
        <p>{message}</p>
        {phase !== 'booting' && <button type="button" onClick={onRetry}><RefreshCw />{phase === 'waiting' ? '我已入座，继续' : '重新连接'}</button>}
      </section>
    </main>
  )
}

function ProductVisual({ product }: { product: GuestMenuProduct }) {
  return product.imageUrl ? (
    <div className="guest-product-image"><img src={product.imageUrl} alt={product.name} loading="lazy" /></div>
  ) : (
    <div className="guest-product-image is-fallback" aria-hidden="true"><span>M</span></div>
  )
}

function QuantityControl({ name, quantity, onMinus, onPlus }: { name: string; quantity: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="guest-quantity" aria-label={`${name}数量`}>
      <button type="button" aria-label={`减少${name}`} onClick={onMinus}><Minus /></button>
      <output aria-label="数量">{quantity}</output>
      <button type="button" aria-label={`增加${name}`} onClick={onPlus}><Plus /></button>
    </div>
  )
}

function GuestPanel({ title, dismissible, onClose, children }: { title: string; dismissible: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="guest-panel-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose() }}>
      <section className="guest-panel" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2>{dismissible && <button type="button" aria-label="关闭" onClick={onClose}><X /></button>}</header>
        {children}
      </section>
    </div>
  )
}

function CartPanel({
  cart,
  note,
  submitting,
  onNoteChange,
  onChangeQuantity,
  onSubmit,
}: {
  cart: GuestCart
  note: string
  submitting: boolean
  onNoteChange: (value: string) => void
  onChangeQuantity: (productId: string, delta: number) => void
  onSubmit: () => void
}) {
  const lines = cartLines(cart)
  const count = cartItemCount(cart)
  return (
    <div className="guest-cart-panel">
      <div className="guest-cart-lines">
        {lines.map((line) => (
          <div className="guest-cart-line" key={line.product.productId}>
            <div><strong>{line.product.name}</strong><small>{formatMoney(line.product.amountMinor, line.product.currency)} / 份</small></div>
            <QuantityControl
              name={line.product.name}
              quantity={line.quantity}
              onMinus={() => onChangeQuantity(line.product.productId, -1)}
              onPlus={() => onChangeQuantity(line.product.productId, 1)}
            />
          </div>
        ))}
      </div>
      <label className="guest-note"><span>订单备注 <small>出品和配送人员会重点看到</small></span><textarea maxLength={500} value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="例如：少冰、生日桌、一起上" /></label>
      <div className="guest-cart-total"><span>{count} 件商品</span><strong>{formatMoney(cartTotalMinor(cart))}</strong></div>
      <button type="button" className="guest-primary" disabled={count === 0 || submitting} onClick={onSubmit}>
        {submitting ? <><LoaderCircle className="is-spinning" />正在提交，请勿重复点击</> : <>确认订单并继续支付<ChevronRight /></>}
      </button>
    </div>
  )
}

function ServicePanel({
  kind,
  detail,
  pending,
  onDetailChange,
  onSubmit,
}: {
  kind: 'complaint' | 'custom'
  detail: string
  pending: boolean
  onDetailChange: (value: string) => void
  onSubmit: () => void
}) {
  const custom = kind === 'custom'
  return (
    <div className="guest-service-panel">
      <p>{custom ? '告诉我们您现在需要什么，伙伴会尽快到桌确认。' : '这里会直接提醒值班经理，我们会当场了解并处理。'}</p>
      <label><span>{custom ? '补充说明' : '哪里没有照顾好您'}</span><textarea autoFocus maxLength={500} value={detail} onChange={(event) => onDetailChange(event.target.value)} placeholder={custom ? '例如：需要两杯温水' : '简单说说情况，方便我们马上处理'} /></label>
      <button type="button" className="guest-primary" disabled={pending || (custom && detail.trim().length < 2)} onClick={onSubmit}>
        {pending ? <><LoaderCircle className="is-spinning" />正在送达</> : <><Send />提交给现场伙伴</>}
      </button>
    </div>
  )
}

function RecommendationSection({
  products,
  intent,
  cart,
  onAdd,
}: {
  products: readonly GuestMenuProduct[]
  intent: RecommendationIntent | null
  cart: GuestCart
  onAdd: (product: GuestMenuProduct) => void
}) {
  return <section className="guest-recommendations" aria-labelledby="guest-recommendation-title">
    <header><div><small>FOR YOUR TABLE</small><h2 id="guest-recommendation-title">{intent === null ? '今晚适合你们的' : '按今晚状态选出的'}</h2></div><span>3 款好比较</span></header>
    <div className="guest-recommendation-list">
      {products.map((product, index) => <article key={product.productId} className={index === 1 ? 'is-centered-choice' : ''}>
        <ProductVisual product={product} />
        <div className="guest-recommendation-copy">
          <small>{product.recommendation.badge ?? (index === 0 ? '轻松开始' : index === 1 ? '今晚正好' : '更尽兴')}</small>
          <h3>{product.name}</h3>
          {product.bundleComponents.length > 0 && <p>{product.bundleComponents.map((item) => `${item.name}×${item.quantity}`).join(' · ')}</p>}
          {product.recommendation.valueCopy !== null && <p className="guest-value-copy">{product.recommendation.valueCopy}</p>}
          <div><strong>{formatMoney(product.amountMinor, product.currency)}</strong><button type="button" aria-label={`加入${product.name}`} onClick={() => onAdd(product)}><Plus /></button></div>
          {cart[product.productId] !== undefined && <span className="guest-added-mark"><Check /> 已选 {cart[product.productId]!.quantity}</span>}
        </div>
      </article>)}
    </div>
  </section>
}

function QuickChoicePanel({ onChoose }: { onChoose: (intent: RecommendationIntent) => void }) {
  const choices: Array<{ intent: RecommendationIntent; title: string; copy: string }> = [
    { intent: 'easy', title: '轻松一点', copy: '好喝、不费心，先把今晚打开' },
    { intent: 'party', title: '今晚要嗨', copy: '更适合分享和热闹气氛' },
    { intent: 'ritual', title: '来点仪式感', copy: '更体面，也更适合庆祝' },
    { intent: 'explore', title: '想试点新的', copy: '从招牌和特色里挑惊喜' },
  ]
  return <div className="guest-quick-panel"><p>不用报预算，选一个今晚更像的状态。</p><div>{choices.map((choice) => <button type="button" key={choice.intent} onClick={() => onChoose(choice.intent)}><strong>{choice.title}</strong><small>{choice.copy}</small><ChevronRight /></button>)}</div></div>
}

function ShakeChoicePanel({ product, onAdd }: { product: GuestMenuProduct; onAdd: () => void }) {
  return <div className="guest-shake-panel"><ProductVisual product={product} /><small>今晚这杯和你有点缘分</small><h3>{product.name}</h3>{product.description !== null && <p>{product.description}</p>}<strong>{formatMoney(product.amountMinor, product.currency)}</strong><button type="button" className="guest-primary" onClick={onAdd}><Plus /> 就试这个</button></div>
}

function CheckoutPanel({ result, onClose }: { result: GuestOrderResult; onClose: () => void }) {
  const paymentCopy = paymentStatusCopy(result)
  return (
    <div className="guest-checkout-result">
      <span className="guest-checkout-icon"><Check /></span>
      <small>订单 {result.order.publicId}</small>
      <h3>{paymentCopy.title}</h3>
      <p>{paymentCopy.detail}</p>
      {result.order.attentionRequired && <div className="guest-attention">备注已重点标记给出品和配送人员</div>}
      <div className="guest-checkout-amount"><span>本次应付</span><strong>{formatMoney(result.settlement.payableAmountMinor, result.settlement.currency)}</strong></div>
      <button type="button" className="guest-primary" onClick={onClose}>返回菜单</button>
    </div>
  )
}

function paymentStatusCopy(result: GuestOrderResult): { title: string; detail: string } {
  if (result.payment.status === 'paid') return { title: '支付已经完成', detail: '吧台与收银已经收到付款状态。' }
  if (result.payment.simulated) {
    return { title: '测试订单已建立', detail: '当前是测试支付，仍待人工测试确认，没有产生真实收款。' }
  }
  if (result.payment.mode === 'wechat_jsapi') {
    return { title: '订单已建立，等待微信支付', detail: '支付状态以微信支付通道返回结果为准，请勿重复下单。' }
  }
  return { title: '订单已建立，等待扫码支付', detail: '支付二维码仍待支付通道返回，请勿重复下单。' }
}

function MenuSkeleton() {
  return <div className="guest-products is-loading" aria-label="菜单加载中">{[1, 2, 3, 4].map((item) => <span key={item} />)}</div>
}

function panelTitle(panel: Exclude<Panel, null>): string {
  if (panel === 'cart') return '核对本次订单'
  if (panel === 'complaint') return '我们想马上处理好'
  if (panel === 'custom') return '告诉我们您的需要'
  if (panel === 'quick') return '今晚想怎么喝？'
  if (panel === 'shake') return '摇到一份今晚灵感'
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
