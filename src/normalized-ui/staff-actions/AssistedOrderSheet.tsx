import { useEffect, useMemo, useState } from 'react'
import { Check, Gift, LoaderCircle, Minus, Plus, Search, ShoppingCart, X } from 'lucide-react'
import { MenuOrderingWorkspace, type MenuSubmitOptions } from '../../components/MenuOrderingWorkspace'
import type { MenuProduct, MenuRecommendationConfig, MenuRecommendationScene } from '../../shared/contracts'
import type {
  AssistedOrderAccess,
  AssistedOrderCatalogProduct,
  StaffActionsApiPort,
} from './staff-actions-api'

export interface AssistedOrderSheetProps {
  api: StaffActionsApiPort
  mode: 'paid' | 'gift'
  table: Readonly<{
    code: string
    activeSession: { id: string; guestCount: number; guestProfileSnapshot?: Record<string, unknown> }
  }>
  onClose(): void
  onSubmitted(message: string): void
}

const IMMEDIATE_PAYMENT_AVAILABLE = false

export function AssistedOrderSheet({ api, mode, table, onClose, onSubmitted }: AssistedOrderSheetProps) {
  const [access, setAccess] = useState<AssistedOrderAccess | null>(null)
  const [products, setProducts] = useState<AssistedOrderCatalogProduct[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'submitting' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [note, setNote] = useState('')
  const [giftReason, setGiftReason] = useState('')
  const [settlementMode, setSettlementMode] = useState<'immediate_payment' | 'table_tab'>('table_tab')

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      api.loadAssistedOrderAccess(controller.signal),
      api.loadAssistedOrderCatalog(controller.signal),
    ]).then(([nextAccess, catalog]) => {
      setAccess(nextAccess)
      setProducts(catalog.filter((product) => {
        const amountMinor = Number(product.standardPrice?.amountMinor)
        return product.isAvailable && Number.isSafeInteger(amountMinor) && amountMinor > 0
      }))
      setPhase('ready')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : '商品暂时无法读取，请稍后重试')
      setPhase('error')
    })
    return () => controller.abort()
  }, [api])

  const categories = useMemo(() => Array.from(new Set(products.map((product) => product.categoryCode))), [products])
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('zh-CN')
    return products.filter((product) => (
      (category === 'all' || product.categoryCode === category)
      && (term.length === 0 || `${product.name} ${product.code}`.toLocaleLowerCase('zh-CN').includes(term))
    ))
  }, [category, products, search])
  const selected = products
    .filter((product) => (quantities[product.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: quantities[product.id] ?? 0 }))
  const totalAmountMinor = selected.reduce((total, item) => (
    total + Number(item.product.standardPrice?.amountMinor ?? 0) * item.quantity
  ), 0)
  const giftLimit = access?.gift?.maximumAmountMinor ?? 0
  const giftAllowed = access?.gift?.enabled === true && totalAmountMinor <= giftLimit
  const canSubmit = phase === 'ready' && access?.canCreateOrder === true && selected.length > 0
    && (mode === 'paid' || (giftAllowed && giftReason.trim().length >= 2))

  const changeQuantity = (productId: string, delta: number) => {
    setQuantities((current) => {
      const next = Math.max(0, Math.min(99, (current[productId] ?? 0) + delta))
      return { ...current, [productId]: next }
    })
  }

  const submit = async () => {
    if (!canSubmit) return
    setPhase('submitting')
    setError(null)
    try {
      const token = await api.issueAssistedOrderContext({ tableSessionId: table.activeSession.id })
      const result = await api.submitAssistedOrder({
        tableSessionId: table.activeSession.id,
        assistedOrderContextToken: token,
        orderMode: mode,
        items: selected.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
        ...(note.trim().length > 0 ? { fulfillmentNote: note.trim() } : {}),
        ...(mode === 'gift' ? { giftReason: giftReason.trim() } : {}),
        settlementMode: mode === 'gift' ? 'table_tab' : settlementMode,
      })
      onSubmitted(mode === 'gift'
        ? `${table.code} 商品已赠送并发送出品，原因已留痕`
        : result.paymentNextStep.status === 'required'
          ? `${table.code} 订单已建立，请由客人扫码或收银完成付款`
          : `${table.code} 订单已挂桌并发送出品`)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '订单没有提交成功，请重试')
      setPhase('ready')
    }
  }

  const submitPaidOrder = async (items: Array<{ productId: string; quantity: number }>, options: MenuSubmitOptions) => {
    if (phase !== 'ready' || access?.canCreateOrder !== true || items.length === 0) return
    setPhase('submitting')
    setError(null)
    try {
      const token = await api.issueAssistedOrderContext({ tableSessionId: table.activeSession.id })
      const result = await api.submitAssistedOrder({
        tableSessionId: table.activeSession.id,
        assistedOrderContextToken: token,
        orderMode: 'paid',
        items,
        ...(options.fulfillmentNote.trim().length > 0 ? { fulfillmentNote: options.fulfillmentNote.trim() } : {}),
        settlementMode,
      })
      onSubmitted(result.paymentNextStep.status === 'required'
        ? `${table.code} 订单已建立，请由客人扫码或收银完成付款`
        : `${table.code} 订单已挂桌并发送出品`)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '订单没有提交成功，请重试')
      setPhase('ready')
      throw reason
    }
  }

  if (mode === 'paid') {
    const menuProducts = products.map(assistedProductToMenuProduct)
    return <div className="staff-order-overlay" role="dialog" aria-modal="true" aria-label={`${table.code}协助点单`}>
      <section className="staff-order-sheet is-shared-menu">
        <header>
          <div><small>{table.code} · 桌号已锁定</small><h2><ShoppingCart size={21} /> 协助点单</h2></div>
          <button type="button" aria-label="关闭点单" onClick={onClose}><X size={21} /></button>
        </header>
        <div className="staff-order-settlement" aria-label="结算方式">
          <button type="button" className={settlementMode === 'table_tab' ? 'is-active' : ''} onClick={() => setSettlementMode('table_tab')}>挂桌账</button>
          <button
            type="button"
            disabled={!IMMEDIATE_PAYMENT_AVAILABLE}
            title="支付通道联调完成后开放"
            className={settlementMode === 'immediate_payment' ? 'is-active' : ''}
            onClick={() => setSettlementMode('immediate_payment')}
          >立即结算（联调后开放）</button>
        </div>
        {!IMMEDIATE_PAYMENT_AVAILABLE && <p className="staff-order-payment-note">当前先挂桌记账；关台前系统会检查未结订单，防止漏收。</p>}
        {error !== null && <p className="staff-order-error" role="alert">{error}</p>}
        {phase === 'loading' ? <p className="staff-order-loading"><LoaderCircle className="is-spinning" /> 正在读取可售商品</p> : (
          <MenuOrderingWorkspace
            products={menuProducts}
            tableLabel={table.code}
            submitLabel="核对无误，确认下单"
            submitHint="桌号已锁定；提交后按选择进入挂账或付款流程。"
            busy={phase === 'submitting'}
            compactCart
            deemphasizeCollapsedTotal
            guestSalesMode
            partySize={table.activeSession.guestCount}
            recommendationScene={recommendationScene(table.activeSession.guestProfileSnapshot ?? {})}
            onSubmit={submitPaidOrder}
          />
        )}
      </section>
    </div>
  }

  return <div className="staff-order-overlay" role="dialog" aria-modal="true" aria-label={`${table.code}${mode === 'gift' ? '赠送商品' : '协助点单'}`}>
    <section className="staff-order-sheet">
      <header>
        <div>
          <small>{table.code} · 桌号已锁定</small>
          <h2>{mode === 'gift' ? <><Gift size={21} /> 商品赠送</> : <><ShoppingCart size={21} /> 协助点单</>}</h2>
        </div>
        <button type="button" aria-label="关闭点单" onClick={onClose}><X size={21} /></button>
      </header>

      {mode === 'gift' && <div className="staff-gift-boundary">
        <strong>现场商品赠送</strong>
        <span>按本人岗位额度执行，赠送原因全程留痕。</span>
        {access?.gift !== null && access?.gift !== undefined
          && <small>本单最多可赠送 {money(giftLimit, access.gift.currency)}</small>}
        {access !== null && access.gift === null && <small>当前岗位未配置赠送额度</small>}
      </div>}

      <div className="staff-order-search">
        <Search size={18} />
        <input aria-label="搜索点单商品" value={search} placeholder="搜索酒水、小食或商品名" onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="staff-order-categories" aria-label="商品分类">
        <button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>全部</button>
        {categories.map((code) => <button type="button" className={category === code ? 'is-active' : ''} key={code} onClick={() => setCategory(code)}>{categoryLabel(code)}</button>)}
      </div>

      <div className="staff-order-products">
        {phase === 'loading' && <p><LoaderCircle className="is-spinning" /> 正在读取可售商品</p>}
        {phase === 'error' && <p className="staff-order-error">{error}</p>}
        {phase !== 'loading' && filtered.length === 0 && <p>没有找到可售商品</p>}
        {filtered.map((product) => {
          const quantity = quantities[product.id] ?? 0
          return <article className={quantity > 0 ? 'is-selected' : ''} key={product.id}>
            <div><strong>{product.name}</strong><small>{product.code} · {categoryLabel(product.categoryCode)}</small></div>
            <b>{money(Number(product.standardPrice?.amountMinor ?? 0), product.standardPrice?.currency ?? 'CNY')}</b>
            <div className="staff-order-quantity">
              {quantity > 0 && <button type="button" aria-label={`减少${product.name}`} onClick={() => changeQuantity(product.id, -1)}><Minus size={17} /></button>}
              {quantity > 0 && <span>{quantity}</span>}
              <button type="button" aria-label={`添加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={17} /></button>
            </div>
          </article>
        })}
      </div>

      <footer>
        {mode === 'gift' ? <label>
          <span className="staff-order-label">赠送原因 <b>*</b></span>
          <input aria-label="赠送原因" value={giftReason} maxLength={200} placeholder="例如：生日关怀、服务补偿" onChange={(event) => setGiftReason(event.target.value)} />
        </label> : <div className="staff-order-settlement" aria-label="结算方式">
          <button type="button" className={settlementMode === 'table_tab' ? 'is-active' : ''} onClick={() => setSettlementMode('table_tab')}>挂桌账</button>
          <button
            type="button"
            disabled={!IMMEDIATE_PAYMENT_AVAILABLE}
            title="支付通道联调完成后开放"
            className={settlementMode === 'immediate_payment' ? 'is-active' : ''}
            onClick={() => setSettlementMode('immediate_payment')}
          >立即结算（联调后开放）</button>
        </div>}
        <label>出品备注<input aria-label="出品备注" value={note} maxLength={500} placeholder="例如：少冰、一起上" onChange={(event) => setNote(event.target.value)} /></label>
        {error !== null && phase !== 'error' && <p className="staff-order-error" role="alert">{error}</p>}
        {mode === 'gift' && totalAmountMinor > giftLimit && <p className="staff-order-error">已超过本人本单赠送额度，请减少商品或联系上级。</p>}
        <div className="staff-order-submit-row">
          <span><small>{selected.reduce((sum, item) => sum + item.quantity, 0)}件</small><strong>{mode === 'gift' ? `赠送价值 ${money(totalAmountMinor)}` : money(totalAmountMinor)}</strong></span>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {phase === 'submitting' ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}
            {phase === 'submitting' ? '正在确认…' : mode === 'gift' ? '确认赠送并出品' : '核对无误，确认下单'}
          </button>
        </div>
      </footer>
    </section>
  </div>
}

function money(amountMinor: number, currency = 'CNY'): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

function categoryLabel(code: string): string {
  return ({ alcohol: '酒水', beverage: '饮品', food: '小食', combo: '组合', other: '其他' } as Record<string, string>)[code]
    ?? code
}

function assistedProductToMenuProduct(product: AssistedOrderCatalogProduct): MenuProduct {
  const snapshot = product.productSnapshot
  const recommendation = record(snapshot.recommendation)
  const amountMinor = Number(product.standardPrice?.amountMinor ?? 0)
  const costAmount = integer(snapshot.costAmount, 0)
  return {
    id: product.id,
    sku: product.code,
    name: product.name,
    specification: text(snapshot.specification),
    productKind: product.productKind,
    beverageFamily: beverageFamily(snapshot.beverageFamily),
    bundleComponents: product.bundleComponents.map((component) => ({
      productId: component.productId,
      quantity: component.quantity,
      note: component.note ?? undefined,
    })),
    substitutionProductIds: [],
    recommendation: menuRecommendation(recommendation),
    categoryId: product.categoryCode,
    categoryName: text(snapshot.categoryName) || categoryLabel(product.categoryCode),
    description: text(snapshot.description) || undefined,
    imageUrl: text(snapshot.imageUrl) || undefined,
    tags: stringArray(snapshot.tags),
    sortOrder: integer(snapshot.sortOrder, 999),
    soldOut: !product.isAvailable,
    availableFrom: nullableText(snapshot.availableFrom),
    availableUntil: nullableText(snapshot.availableUntil),
    guestVisible: snapshot.guestVisible !== false,
    requiresFulfillment: snapshot.requiresFulfillment !== false,
    maxOrderQuantity: integer(snapshot.maxOrderQuantity, 50),
    listPriceAmount: amountMinor,
    costAmount,
    stationId: product.fulfillmentStation,
    enabled: product.isAvailable && amountMinor > 0,
    configVersion: integer(snapshot.configVersion, 1),
  }
}

function menuRecommendation(value: Record<string, unknown>): MenuRecommendationConfig {
  return {
    enabled: value.enabled === true,
    priority: integer(value.priority, 100),
    badge: text(value.badge),
    headline: text(value.headline),
    reason: text(value.reason),
    minimumPartySize: integer(value.minimumPartySize, 1),
    maximumPartySize: integer(value.maximumPartySize, 100),
    sceneTags: stringArray(value.sceneTags).filter((item): item is MenuRecommendationConfig['sceneTags'][number] => ['date', 'brothers', 'besties', 'friends', 'business', 'celebration', 'unsure'].includes(item)),
    intentTags: stringArray(value.intentTags).filter((item): item is MenuRecommendationConfig['intentTags'][number] => ['relaxed', 'energetic', 'ritual', 'unsure'].includes(item)),
    tasteTags: stringArray(value.tasteTags).filter((item): item is MenuRecommendationConfig['tasteTags'][number] => ['refreshing', 'layered', 'strong', 'any'].includes(item)),
    dwellTags: stringArray(value.dwellTags).filter((item): item is MenuRecommendationConfig['dwellTags'][number] => ['one_set', 'stay_longer', 'no_rush'].includes(item)),
    singleWaveEligible: value.singleWaveEligible !== false,
    expectedPrepMinutes: integer(value.expectedPrepMinutes, 8),
    holdMinutes: integer(value.holdMinutes, 10),
    upgradeProductId: typeof value.upgradeProductId === 'string' ? value.upgradeProductId : null,
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function beverageFamily(value: unknown): MenuProduct['beverageFamily'] {
  return typeof value === 'string' && ['none', 'cocktail', 'beer', 'wine', 'sparkling', 'spirits', 'non_alcoholic'].includes(value)
    ? value as MenuProduct['beverageFamily']
    : 'none'
}

function recommendationScene(snapshot: Record<string, unknown>): MenuRecommendationScene | undefined {
  const value = snapshot.recommendationScene ?? snapshot.scene ?? snapshot.occasion
  return typeof value === 'string' && ['unsure', 'date', 'brothers', 'besties', 'friends', 'business', 'celebration'].includes(value)
    ? value as MenuRecommendationScene
    : undefined
}
