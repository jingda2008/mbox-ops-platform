import { useEffect, useMemo, useState } from 'react'
import { Check, Gift, LoaderCircle, Minus, Plus, QrCode, RefreshCcw, ScanLine, Search, ShoppingCart, X } from 'lucide-react'
import { MenuOrderingWorkspace, type MenuSubmitOptions } from '../../components/MenuOrderingWorkspace'
import { CustomerPaymentCodeScanner } from '../../components/CustomerPaymentCodeScanner'
import type { MenuProduct, MenuRecommendationConfig, MenuRecommendationScene } from '../../shared/contracts'
import type { OnlinePaymentAction } from '../../shared/online-payment-contracts'
import type {
  AssistedOrderAccess,
  AssistedOrderCatalogProduct,
  AssistedOrderResult,
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
  const [paymentOrder, setPaymentOrder] = useState<AssistedOrderResult | null>(null)
  const [paymentAction, setPaymentAction] = useState<OnlinePaymentAction | null>(null)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [showPaymentScanner, setShowPaymentScanner] = useState(false)

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
      if (result.paymentNextStep.status === 'required') {
        setPaymentOrder(result)
        setPhase('ready')
        onSubmitted(`${table.code} 订单已同步到本桌，请选择收款方式`)
        return
      }
      onSubmitted(`${table.code} 订单已挂桌并发送出品`)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '订单没有提交成功，请重试')
      setPhase('ready')
      throw reason
    }
  }

  const createPayment = async (method: 'native_qr' | 'auth_code', customerAuthCode?: string) => {
    if (paymentOrder === null || paymentBusy) return false
    if (access?.onlinePaymentProvider === null || access?.onlinePaymentProvider === undefined) {
      setError('本店当前没有启用线上收款，请改为挂桌账或联系收银员。')
      return false
    }
    setPaymentBusy(true)
    setError(null)
    try {
      const action = await api.createOnlinePayment({
        orderId: paymentOrder.paymentNextStep.orderId,
        provider: access.onlinePaymentProvider,
        method,
        ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
      })
      setPaymentAction(action)
      setShowPaymentScanner(false)
      onSubmitted(method === 'native_qr'
        ? `${table.code} 付款码已生成；客人手机也可从本桌订单发起同一笔付款`
        : `${table.code} 付款已受理，到账结果以支付通知为准`)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '付款没有发起成功，请到收银页面核对')
      return false
    } finally {
      setPaymentBusy(false)
    }
  }

  const queryPayment = async () => {
    if (paymentAction === null || paymentBusy) return
    setPaymentBusy(true)
    setError(null)
    try {
      const status = await api.queryOnlinePayment(paymentAction.paymentId)
      if (status === 'succeeded') {
        onSubmitted(`${table.code} 已确认到账，订单和收银状态已同步`)
        onClose()
        return
      }
      if (status === 'failed' || status === 'closed') {
        setPaymentAction(null)
        setError('支付机构已确认本次未成功，可以重新发起收款。')
        return
      }
      onSubmitted(`${table.code} 支付机构仍在处理，请勿重复收款`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法核对到账，请到收银页面查看')
    } finally {
      setPaymentBusy(false)
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
            disabled={access !== null && !access.canInitiatePayment}
            title={access !== null && !access.canInitiatePayment ? '当前岗位没有发起收款权限' : undefined}
            className={settlementMode === 'immediate_payment' ? 'is-active' : ''}
            onClick={() => setSettlementMode('immediate_payment')}
          >立即结算</button>
        </div>
        <p className="staff-order-payment-note">挂账可稍后统一结算；立即结算可让客人扫码，或扫描客人的付款码。</p>
        {error !== null && <p className="staff-order-error" role="alert">{error}</p>}
        {paymentOrder !== null ? <StaffPaymentChoice
          action={paymentAction}
          amountMinor={paymentOrder.paymentNextStep.amountMinor}
          currency={paymentOrder.paymentNextStep.currency}
          busy={paymentBusy}
          tableCode={table.code}
          onCreateQr={() => void createPayment('native_qr')}
          onScan={() => setShowPaymentScanner(true)}
          onQuery={() => void queryPayment()}
          onDone={onClose}
        /> : phase === 'loading' ? <p className="staff-order-loading"><LoaderCircle className="is-spinning" /> 正在读取可售商品</p> : (
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
        {showPaymentScanner && paymentOrder !== null && <CustomerPaymentCodeScanner
          tableCode={table.code}
          amountLabel={money(paymentOrder.paymentNextStep.amountMinor, paymentOrder.paymentNextStep.currency)}
          onClose={() => setShowPaymentScanner(false)}
          onConfirm={(customerAuthCode) => createPayment('auth_code', customerAuthCode)}
        />}
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
        <label>
          <span className="staff-order-label">赠送原因 <b>*</b></span>
          <input aria-label="赠送原因" value={giftReason} maxLength={200} placeholder="例如：生日关怀、服务补偿" onChange={(event) => setGiftReason(event.target.value)} />
        </label>
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

function StaffPaymentChoice({ action, amountMinor, currency, busy, tableCode, onCreateQr, onScan, onQuery, onDone }: {
  action: OnlinePaymentAction | null
  amountMinor: number
  currency: string
  busy: boolean
  tableCode: string
  onCreateQr(): void
  onScan(): void
  onQuery(): void
  onDone(): void
}) {
  const qrValue = action?.presentation === 'qr' && typeof action.payload?.qrCodeUrl === 'string'
    ? action.payload.qrCodeUrl
    : null
  return <section className="staff-payment-choice" aria-label={`${tableCode}收款`}>
    <div className="staff-payment-summary"><small>{tableCode} · 订单已同步本桌</small><strong>{money(amountMinor, currency)}</strong><span>只发起一笔付款，到账结果以支付通知为准。</span></div>
    {action?.payload?.presentation === 'simulation' ? <>
      <span className="staff-payment-result"><Check /><strong>测试付款动作已建立</strong></span>
      <p>当前仅验证订单同步和操作流程，没有产生真实收款。</p>
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />完成演练</button>
    </> : qrValue !== null ? <>
      <StaffPaymentQr value={qrValue} />
      <h3>请客人扫码付款</h3>
      <p>客人也可以打开桌码中的“本桌已点”，从自己的手机继续这笔付款。</p>
      <button type="button" className="staff-payment-query" disabled={busy} onClick={onQuery}><RefreshCcw size={18} />核对是否到账</button>
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />暂时收起</button>
    </> : action?.presentation === 'barcode' ? <>
      <span className="staff-payment-result"><LoaderCircle className="is-spinning" /><strong>付款已受理，正在确认到账</strong></span>
      <p>不要重复扫描；收银与订单状态会在支付通知到达后同步更新。</p>
      <button type="button" className="staff-payment-query" disabled={busy} onClick={onQuery}><RefreshCcw size={18} />核对是否到账</button>
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />完成</button>
    </> : <>
      <div className="staff-payment-methods">
        <button type="button" disabled={busy} onClick={onCreateQr}><QrCode /><strong>客人扫二维码</strong><small>平板显示付款码</small></button>
        <button type="button" disabled={busy} onClick={onScan}><ScanLine /><strong>扫客人付款码</strong><small>摄像头或扫码枪</small></button>
      </div>
      <p>这笔订单已经出现在桌码“本桌已点”中，客人可直接用自己的手机付款。</p>
    </>}
    {busy && <span className="staff-payment-busy"><LoaderCircle className="is-spinning" />正在安全发起，请勿重复操作</span>}
  </section>
}

function StaffPaymentQr({ value }: { value: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(value, {
      width: 260, margin: 1, errorCorrectionLevel: 'M',
    })).then((next) => { if (active) setImage(next) })
    return () => { active = false }
  }, [value])
  return image === null
    ? <LoaderCircle className="is-spinning" />
    : <img className="staff-payment-qr" src={image} alt="客人扫码付款二维码" />
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
  const costAmount = product.costAmountMinor ?? 0
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
    recommendation: menuRecommendation(recommendation, product),
    categoryId: product.categoryCode,
    categoryName: text(snapshot.categoryName) || categoryLabel(product.categoryCode),
    description: text(snapshot.description) || undefined,
    imageUrl: text(snapshot.imageUrl) || undefined,
    tags: stringArray(snapshot.tags),
    sortOrder: product.menuSortOrder,
    soldOut: !product.isAvailable,
    availableFrom: product.availableFrom,
    availableUntil: product.availableUntil,
    guestVisible: product.guestVisible,
    requiresFulfillment: snapshot.requiresFulfillment !== false,
    maxOrderQuantity: product.maxOrderQuantity,
    listPriceAmount: amountMinor,
    costAmount,
    stationId: product.fulfillmentStation,
    enabled: product.isAvailable && amountMinor > 0,
    configVersion: integer(snapshot.configVersion, 1),
  }
}

function menuRecommendation(
  value: Record<string, unknown>,
  product: AssistedOrderCatalogProduct,
): MenuRecommendationConfig {
  return {
    enabled: product.recommendationEnabled,
    priority: product.recommendationPriority,
    badge: text(value.badge),
    headline: text(value.headline),
    reason: text(value.reason),
    minimumPartySize: product.recommendationMinGuests,
    maximumPartySize: product.recommendationMaxGuests,
    sceneTags: product.recommendationSceneTags as MenuRecommendationConfig['sceneTags'],
    intentTags: product.recommendationIntentTags as MenuRecommendationConfig['intentTags'],
    tasteTags: product.recommendationTasteTags as MenuRecommendationConfig['tasteTags'],
    dwellTags: product.recommendationDwellTags as MenuRecommendationConfig['dwellTags'],
    singleWaveEligible: product.recommendationSingleWaveEligible,
    expectedPrepMinutes: product.recommendationExpectedPrepMinutes,
    holdMinutes: product.recommendationHoldMinutes,
    upgradeProductId: product.recommendationUpgradeProductId,
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function beverageFamily(value: unknown): MenuProduct['beverageFamily'] {
  return typeof value === 'string' && ['none', 'cocktail', 'beer', 'wine', 'sparkling', 'spirits', 'non_alcoholic', 'mixed'].includes(value)
    ? value as MenuProduct['beverageFamily']
    : 'none'
}

function recommendationScene(snapshot: Record<string, unknown>): MenuRecommendationScene | undefined {
  const value = snapshot.recommendationScene ?? snapshot.scene ?? snapshot.occasion
  return typeof value === 'string' && ['unsure', 'date', 'brothers', 'besties', 'friends', 'business', 'celebration'].includes(value)
    ? value as MenuRecommendationScene
    : undefined
}
