import { AlertTriangle, Check, CheckCircle2, ChevronRight, Clock3, Gift, MessageSquareWarning, Minus, Plus, Search, ShoppingCart, Sparkles, ThumbsUp, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../api'
import type { OrderSafetyConfig } from '../shared/commercial-ops-contracts'
import type { MenuProduct, MenuRecommendationScene } from '../shared/contracts'
import type { GuestBehaviorEventType } from '../shared/guest-insight-contracts'
import {
  bundleComparisonAmount,
  pickShakeRecommendation,
  rankMenuRecommendations,
  selectMenuComparisonOptions,
  recommendationConfig,
  selectMenuRecommendationSlots,
  type MenuRecommendationContext,
} from '../shared/menu-recommendation'
import { guestDrinkMatchesFamily } from '../shared/menu-product-classification'
import { productAvailability } from '../shared/product-availability'
import { GuestRecommendationTools, type GuestRecommendationContext } from './GuestRecommendationTools'
import './MenuOrderingWorkspace.css'
import { filterMenuProducts } from './menu-search'
import { clearPersistedCart, persistCart, readPersistedCart } from './menu-cart-storage'

export interface MenuCartItem {
  productId: string
  quantity: number
}

export interface MenuInteraction {
  type: GuestBehaviorEventType
  productId?: string
  categoryId?: string
  quantity?: number
  metadata?: Record<string, string | number | boolean | null>
}

export interface MenuSubmitOptions {
  confirmedDuplicateOrderId?: string
  fulfillmentNote: string
}

function formatMenuAmount(amount: number) {
  return (amount / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function menuProductContents(product: MenuProduct, products: MenuProduct[]) {
  if (product.productKind !== 'bundle') return product.specification
  const byId = new Map(products.map((item) => [item.id, item]))
  const parts = (product.bundleComponents ?? [])
    .map((component) => {
      const componentProduct = byId.get(component.productId)
      return componentProduct ? `${componentProduct.name} × ${component.quantity}` : ''
    })
    .filter(Boolean)
  return parts.length > 2
    ? `${parts.slice(0, 2).join(' · ')} · 另${parts.length - 2}项`
    : parts.join(' · ')
}

function customerFacingProductTag(product: MenuProduct) {
  if (product.productKind === 'bundle') {
    const bundleLabels: Record<string, string> = {
      cocktail: '鸡尾酒组合',
      beer: '啤酒组合',
      wine: '葡萄酒组合',
      sparkling: '起泡酒组合',
      spirits: '洋酒组合',
      non_alcoholic: '无酒精组合',
    }
    return bundleLabels[product.beverageFamily ?? ''] ?? '组合甄选'
  }
  return (product.tags ?? []).find((tag) => !/^V\d+\s*组合$/i.test(tag.trim()))
}

const guestMenuViews = [
  { id: 'recommend', name: '今夜推荐' },
  { id: 'bundles', name: '组合甄选' },
  { id: 'drinks', name: '酒水' },
  { id: 'food', name: '小食' },
  { id: 'search', name: '搜索' },
] as const

const beverageFamilies = [
  { id: 'all', name: '全部酒水' },
  { id: 'cocktail', name: '鸡尾酒' },
  { id: 'beer', name: '啤酒' },
  { id: 'wine', name: '葡萄酒' },
  { id: 'sparkling', name: '起泡酒' },
  { id: 'spirits', name: '洋酒' },
  { id: 'non_alcoholic', name: '无酒精' },
] as const

const comparisonFamilyLabels: Record<string, string> = {
  cocktail: '现调微醺',
  beer: '冰镇分享',
  wine: '葡萄酒之夜',
  sparkling: '一点仪式感',
  spirits: '整瓶主场',
  non_alcoholic: '轻松无酒精',
}

const recommendationSceneLabels: Partial<Record<MenuRecommendationScene, string>> = {
  date: '约会',
  brothers: '兄弟',
  besties: '闺蜜',
  friends: '朋友',
  business: '商务',
  celebration: '庆祝',
}

interface MenuOrderingWorkspaceProps {
  products: MenuProduct[]
  tableLabel: string
  tableControl?: ReactNode
  submitLabel: string
  submitHint: string
  busy?: boolean
  timeZone?: string
  clockOffsetMs?: number
  orderSafety?: OrderSafetyConfig
  compactCart?: boolean
  deemphasizeCollapsedTotal?: boolean
  submitDisabled?: boolean
  complimentaryMode?: boolean
  guestSalesMode?: boolean
  partySize?: number
  recommendationScene?: MenuRecommendationScene
  cartStorageKey?: string
  onSubmit: (items: MenuCartItem[], options: MenuSubmitOptions) => Promise<void>
  onInteraction?: (interaction: MenuInteraction) => void
  onCartCountChange?: (itemCount: number) => void
}

export function MenuOrderingWorkspace({
  products,
  tableLabel,
  tableControl,
  submitLabel,
  submitHint,
  busy = false,
  timeZone = 'Asia/Shanghai',
  clockOffsetMs = 0,
  onSubmit,
  onInteraction,
  orderSafety,
  compactCart = false,
  deemphasizeCollapsedTotal = false,
  submitDisabled = false,
  complimentaryMode = false,
  guestSalesMode = false,
  partySize = 1,
  recommendationScene,
  cartStorageKey,
  onCartCountChange,
}: MenuOrderingWorkspaceProps) {
  const [cart, setCart] = useState<Record<string, number>>(() => readPersistedCart(cartStorageKey))
  const [categoryId, setCategoryId] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [clock, setClock] = useState(() => Date.now() + clockOffsetMs)
  const [confirmation, setConfirmation] = useState<'submit' | 'duplicate' | 'continue' | null>(null)
  const [confirmationError, setConfirmationError] = useState('')
  const [confirmedDuplicateOrderId, setConfirmedDuplicateOrderId] = useState('')
  const [pendingProductId, setPendingProductId] = useState('')
  const [lastSubmittedAt, setLastSubmittedAt] = useState(0)
  const [cartOpen, setCartOpen] = useState(false)
  const [fulfillmentNote, setFulfillmentNote] = useState('')
  const [guestMenuView, setGuestMenuView] = useState<'recommend' | 'bundles' | 'drinks' | 'food' | 'search'>('recommend')
  const [beverageFamily, setBeverageFamily] = useState('all')
  const [recommendationContext, setRecommendationContext] = useState<GuestRecommendationContext>({})
  const [recommendationFeedback, setRecommendationFeedback] = useState('')
  const [recommendationUpdateVersion, setRecommendationUpdateVersion] = useState(0)
  const [shakeProductId, setShakeProductId] = useState('')
  const [shakeProductIds, setShakeProductIds] = useState<string[]>([])
  const [detailProductId, setDetailProductId] = useState('')
  const [upgradePromptProductId, setUpgradePromptProductId] = useState('')
  const [upgradeSourceProductId, setUpgradeSourceProductId] = useState('')
  const lastRecommendationImpressionRef = useRef('')
  const handledRecommendationUpdateRef = useRef(0)
  const previousRecommendationIdsRef = useRef('')
  const cartAbandonmentRef = useRef('')
  const suggestedUpgradeSourceIdsRef = useRef(new Set<string>())
  useEffect(() => persistCart(cartStorageKey, cart), [cart, cartStorageKey])
  useEffect(() => {
    const updateClock = () => setClock(Date.now() + clockOffsetMs)
    updateClock()
    const interval = window.setInterval(updateClock, 30_000)
    return () => window.clearInterval(interval)
  }, [clockOffsetMs])
  const orderedProducts = useMemo(
    () => products.filter((item) => item.enabled).sort((left, right) => (left.sortOrder ?? 999) - (right.sortOrder ?? 999)),
    [products],
  )
  const staffCategories = useMemo(() => [
    { id: 'all', name: '全部' },
    ...Array.from(new Map(orderedProducts.map((product) => [
      product.categoryId ?? 'featured',
      product.categoryName ?? '推荐',
    ])).entries()).map(([id, name]) => ({ id, name })),
  ], [orderedProducts])
  const availability = useMemo(() => new Map(orderedProducts.map((product) => [
    product.id,
    productAvailability(product, new Date(clock), timeZone),
  ])), [clock, orderedProducts, timeZone])
  const rankedRecommendations = useMemo(() => rankMenuRecommendations(
    orderedProducts,
    {
      partySize,
      scene: recommendationScene,
      ...recommendationContext,
    } as MenuRecommendationContext,
    (product) => (
      product.guestVisible !== false
      &&
      availability.get(product.id)?.orderable === true
      && (product.productKind !== 'bundle' || (product.bundleComponents ?? []).every((component) => (
        availability.get(component.productId)?.orderable === true
      )))
    ),
  ), [availability, orderedProducts, partySize, recommendationContext, recommendationScene])
  const recommendationSlots = useMemo(
    () => selectMenuRecommendationSlots(rankedRecommendations),
    [rankedRecommendations],
  )
  const comparisonOptions = useMemo(
    () => selectMenuComparisonOptions(rankedRecommendations, recommendationSlots),
    [rankedRecommendations, recommendationSlots],
  )
  const guestVisibleProducts = useMemo(() => {
    if (searchQuery.trim()) {
      return filterMenuProducts(
        orderedProducts.filter((product) => product.guestVisible !== false),
        'all',
        searchQuery,
      )
    }
    if (guestMenuView === 'recommend') {
      return []
    }
    if (guestMenuView === 'bundles') return orderedProducts.filter((product) => (
      product.guestVisible !== false && product.productKind === 'bundle'
    ))
    if (guestMenuView === 'drinks') return orderedProducts.filter((product) => (
      product.guestVisible !== false
      &&
      product.productKind !== 'bundle'
      && guestDrinkMatchesFamily(product, beverageFamily)
    ))
    if (guestMenuView === 'food') return orderedProducts.filter((product) => (
      product.guestVisible !== false
      && (product.categoryId === 'food' || product.categoryId === 'foods')
    ))
    return filterMenuProducts(
      orderedProducts.filter((product) => product.guestVisible !== false),
      'all',
      searchQuery,
    )
  }, [
    beverageFamily,
    guestMenuView,
    orderedProducts,
    searchQuery,
  ])
  const visibleProducts = guestSalesMode
    ? guestVisibleProducts
    : filterMenuProducts(orderedProducts, categoryId, searchQuery)
  const guestSearchableProductCount = guestSalesMode
    ? orderedProducts.filter((product) => product.guestVisible !== false).length
    : visibleProducts.length
  const cartProducts = orderedProducts.filter((product) => (
    (cart[product.id] ?? 0) > 0 && availability.get(product.id)?.orderable
  ))
  const itemCount = cartProducts.reduce((sum, product) => sum + (cart[product.id] ?? 0), 0)
  const total = cartProducts.reduce((sum, product) => sum + product.listPriceAmount * (cart[product.id] ?? 0), 0)

  useEffect(() => {
    if (!recommendationFeedback) return
    const timer = window.setTimeout(() => setRecommendationFeedback(''), 4_200)
    return () => window.clearTimeout(timer)
  }, [recommendationFeedback])

  useEffect(() => {
    if (
      recommendationUpdateVersion === 0
      || handledRecommendationUpdateRef.current === recommendationUpdateVersion
      || comparisonOptions.length === 0
    ) return
    handledRecommendationUpdateRef.current = recommendationUpdateVersion
    const comparisonProductIds = comparisonOptions.map((option) => option.product.id)
    const comparisonSignature = comparisonProductIds.join(',')
    const primary = comparisonOptions.find((option) => option.role === 'primary') ?? comparisonOptions[0]!
    const changed = comparisonSignature !== previousRecommendationIdsRef.current
    setRecommendationFeedback(changed
      ? `已按你的选择重新排好，先看看「${primary.product.name}」`
      : `已按你的选择核对过，这三款仍然最适合今晚`)
    onInteraction?.({
      type: 'recommendation_result_updated',
      productId: primary.product.id,
      metadata: {
        source: 'rules',
        primaryProductId: primary.product.id,
        comparisonProductIds: comparisonSignature,
        changed,
      },
    })
  }, [comparisonOptions, onInteraction, recommendationUpdateVersion])

  useEffect(() => {
    if (itemCount === 0) setCartOpen(false)
  }, [itemCount])

  useEffect(() => {
    onCartCountChange?.(itemCount)
  }, [itemCount, onCartCountChange])

  useEffect(() => {
    if (!guestSalesMode) return
    const recordCartAbandonment = () => {
      if (itemCount === 0) return
      const signature = `${itemCount}:${cartProducts.length}:${total}:${guestMenuView}`
      if (cartAbandonmentRef.current === signature) return
      cartAbandonmentRef.current = signature
      onInteraction?.({
        type: 'cart_abandoned',
        metadata: {
          itemCount,
          distinctProductCount: cartProducts.length,
          totalAmount: total,
          lastView: guestMenuView,
        },
      })
    }
    window.addEventListener('pagehide', recordCartAbandonment)
    return () => window.removeEventListener('pagehide', recordCartAbandonment)
  }, [cartProducts.length, guestMenuView, guestSalesMode, itemCount, onInteraction, total])

  useEffect(() => {
    const productId = recommendationSlots.primary?.product.id
    if (!guestSalesMode || guestMenuView !== 'recommend' || !productId) return
    const impressionKey = [
      productId,
      partySize,
      recommendationScene ?? '',
      recommendationContext.intent ?? '',
      recommendationContext.taste ?? '',
      recommendationContext.dwell ?? '',
    ].join(':')
    if (lastRecommendationImpressionRef.current === impressionKey) return
    lastRecommendationImpressionRef.current = impressionKey
    onInteraction?.({
      type: 'recommendation_viewed',
      productId,
      metadata: {
        partySize,
        scene: recommendationScene ?? null,
        intent: recommendationContext.intent ?? null,
        taste: recommendationContext.taste ?? null,
        dwell: recommendationContext.dwell ?? null,
      },
    })
  }, [
    guestMenuView,
    guestSalesMode,
    onInteraction,
    partySize,
    recommendationScene,
    recommendationContext.dwell,
    recommendationContext.intent,
    recommendationContext.taste,
    recommendationSlots.primary?.product.id,
  ])

  useEffect(() => {
    setCart((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([productId]) => {
        const product = products.find((item) => item.id === productId)
        return product && productAvailability(product, new Date(clock), timeZone).orderable
      }))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [clock, products, timeZone])

  function emitInteraction(
    type: GuestBehaviorEventType,
    fields: Omit<MenuInteraction, 'type'> = {},
  ) {
    onInteraction?.({ type, ...fields })
  }

  function changeGuestMenuView(view: typeof guestMenuViews[number]['id']) {
    setGuestMenuView(view)
    if (view !== 'search') setSearchQuery('')
    emitInteraction('category_viewed', { categoryId: view })
  }

  function updateRecommendationContext(context: GuestRecommendationContext) {
    previousRecommendationIdsRef.current = comparisonOptions.map((option) => option.product.id).join(',')
    setRecommendationFeedback('收到，正在按你的选择重新安排')
    setRecommendationContext(context)
    setRecommendationUpdateVersion((current) => current + 1)
    setGuestMenuView('recommend')
    setShakeProductId('')
    setShakeProductIds([])
    emitInteraction('recommendation_reranked', {
      categoryId: 'recommend',
      metadata: {
        partySize,
        intent: context.intent ?? null,
        taste: context.taste ?? null,
        dwell: context.dwell ?? null,
      },
    })
  }

  function requestShakeRecommendation() {
    const selected = pickShakeRecommendation(rankedRecommendations, new Set(shakeProductIds))
    if (!selected) return
    setShakeProductId(selected.product.id)
    setShakeProductIds((current) => [...current, selected.product.id].slice(-3))
    emitInteraction('shake_requested', {
      productId: selected.product.id,
      metadata: { attempt: shakeProductIds.length + 1, score: selected.score },
    })
  }

  function openProductDetail(product: MenuProduct) {
    setDetailProductId(product.id)
    emitInteraction('product_detail_viewed', { productId: product.id })
  }

  function chooseRecommendedProduct(product: MenuProduct) {
    changeQuantity(product.id, 1)
    emitInteraction('recommendation_accepted', { productId: product.id })
  }

  function changeQuantity(productId: string, delta: number) {
    const continuationSeconds = orderSafety?.requireContinuationConfirmationSeconds ?? 120
    if (
      delta > 0
      && itemCount === 0
      && lastSubmittedAt > 0
      && Date.now() - lastSubmittedAt < continuationSeconds * 1000
    ) {
      setPendingProductId(productId)
      setConfirmationError('')
      setConfirmation('continue')
      return
    }
    applyQuantityChange(productId, delta)
  }

  function applyQuantityChange(productId: string, delta: number) {
    if (guestSalesMode) menuHaptic(delta > 0 ? 5 : 3)
    setProductQuantity(productId, (cart[productId] ?? 0) + delta, delta > 0 ? 'product_added' : 'product_removed')
  }

  function setProductQuantity(productId: string, requestedQuantity: number, interactionType: 'product_added' | 'product_removed' = 'product_added') {
    const product = products.find((item) => item.id === productId)
    const nextQuantity = Math.max(0, Math.min(product?.maxOrderQuantity ?? 50, Math.round(requestedQuantity)))
    setCart((current) => {
      if (nextQuantity === 0) {
        const next = { ...current }
        delete next[productId]
        return next
      }
      return { ...current, [productId]: nextQuantity }
    })
    onInteraction?.({
      type: interactionType,
      productId,
      quantity: nextQuantity,
    })
    if (
      guestSalesMode
      && interactionType === 'product_added'
      && nextQuantity === 1
      && product?.recommendation?.upgradeProductId
      && cart[product.recommendation.upgradeProductId] === undefined
      && availability.get(product.recommendation.upgradeProductId)?.orderable === true
      && !suggestedUpgradeSourceIdsRef.current.has(product.id)
    ) {
      suggestedUpgradeSourceIdsRef.current.add(product.id)
      setUpgradePromptProductId(product.recommendation.upgradeProductId)
      setUpgradeSourceProductId(product.id)
    }
  }

  function removeProduct(productId: string) {
    setCart((current) => {
      const next = { ...current }
      delete next[productId]
      return next
    })
    onInteraction?.({ type: 'product_removed', productId, quantity: 0 })
  }

  async function submit() {
    if (cartProducts.length === 0 || busy || submitDisabled) return
    if (orderSafety?.requireSubmitConfirmation !== false) {
      setConfirmationError('')
      setConfirmation('submit')
      return
    }
    await executeSubmit()
  }

  async function executeSubmit(duplicateOrderId?: string) {
    if (cartProducts.length === 0 || busy || submitDisabled) return
    try {
      await onSubmit(
        cartProducts.map((product) => ({ productId: product.id, quantity: cart[product.id]! })),
        { confirmedDuplicateOrderId: duplicateOrderId, fulfillmentNote: fulfillmentNote.trim() },
      )
      setCart({})
      clearPersistedCart(cartStorageKey)
      setFulfillmentNote('')
      setCartOpen(false)
      setLastSubmittedAt(Date.now())
      setConfirmation(null)
      setConfirmationError('')
      setConfirmedDuplicateOrderId('')
      onInteraction?.({ type: 'cart_cleared' })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED') {
        const conflictingOrderId = error.details?.conflictingOrderId
        setConfirmedDuplicateOrderId(typeof conflictingOrderId === 'string' ? conflictingOrderId : '')
        setConfirmationError(error.message)
        setConfirmation('duplicate')
        return
      }
      setConfirmationError(error instanceof Error ? error.message : '订单没有提交，请核对后再试一次')
      setConfirmation('submit')
    }
  }

  function confirmContinuation() {
    if (pendingProductId) applyQuantityChange(pendingProductId, 1)
    setPendingProductId('')
    setConfirmation(null)
    setConfirmationError('')
  }

  function trackRecommendationTool(event: string, metadata: Record<string, string | number | boolean | null> = {}) {
    if (event === 'recommendation_quick_opened') emitInteraction('quick_select_started', { metadata })
    if (event === 'recommendation_quick_answered') emitInteraction('quick_select_answered', { metadata })
    if (event === 'recommendation_quick_completed') emitInteraction('quick_select_completed', { metadata })
    if (event === 'recommendation_quick_closed' && metadata.reason === 'dismissed') {
      emitInteraction('quick_select_exited', { metadata })
    }
    if (event === 'recommendation_shake_revealed') {
      emitInteraction('shake_result_viewed', {
        productId: typeof metadata.productId === 'string' ? metadata.productId : undefined,
        metadata,
      })
    }
  }

  const cartLines = cartProducts.length === 0 ? (
    <div className="menu-cart-empty"><ShoppingCart size={28} /><span>点击商品图片旁的加号</span></div>
  ) : cartProducts.map((product) => (
    <div className="menu-cart-line" key={product.id}>
      <div><strong>{product.name}</strong><span>¥{(product.listPriceAmount / 100).toFixed(0)} × {cart[product.id]}</span></div>
      <div className={`menu-stepper${(product.maxOrderQuantity ?? 50) > 50 ? ' has-direct-input' : ''}`}>
        <button type="button" title={`移除${product.name}`} onClick={() => removeProduct(product.id)}><Trash2 size={15} /></button>
        {(product.maxOrderQuantity ?? 50) > 50
          ? <input aria-label={`${product.name}数量`} type="number" inputMode="numeric" min={1} max={product.maxOrderQuantity} value={cart[product.id]} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setProductQuantity(product.id, Number(event.target.value))} />
          : <strong>{cart[product.id]}</strong>}
        <button type="button" title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={15} /></button>
      </div>
    </div>
  ))
  const fulfillmentNoteField = (
    <label className="menu-order-note">
      <span><MessageSquareWarning size={16} />订单备注 <small>选填 · 相关岗位会重点看到</small></span>
      <textarea
        value={fulfillmentNote}
        maxLength={300}
        rows={2}
        placeholder="如：少冰、不要香菜、酒水和小食一起上"
        onChange={(event) => setFulfillmentNote(event.target.value)}
      />
      <b>{fulfillmentNote.length}/300</b>
    </label>
  )
  const detailProduct = orderedProducts.find((product) => product.id === detailProductId) ?? null
  const detailComponents = detailProduct?.bundleComponents?.map((component) => ({
    ...component,
    product: orderedProducts.find((product) => product.id === component.productId),
  })).filter((component) => component.product) ?? []
  const detailComparisonAmount = detailProduct ? bundleComparisonAmount(detailProduct, orderedProducts) : null
  const detailSavingsAmount = detailProduct && detailComparisonAmount !== null
    ? detailComparisonAmount - detailProduct.listPriceAmount
    : 0
  const detailQuantity = detailProduct ? cart[detailProduct.id] ?? 0 : 0
  const upgradeProduct = orderedProducts.find((product) => product.id === upgradePromptProductId) ?? null
  const upgradeSourceProduct = orderedProducts.find((product) => product.id === upgradeSourceProductId) ?? null

  return (
    <section className={`menu-ordering-workspace${compactCart ? ' has-compact-cart' : ''}${deemphasizeCollapsedTotal ? ' has-gentle-cart-summary' : ''}${guestSalesMode ? ' is-guest-sales' : ''}`}>
      <header className="menu-workspace-header">
        <div>
          <span>当前桌台</span>
          <strong>{tableLabel}</strong>
        </div>
        {tableControl}
      </header>

      {guestSalesMode && <GuestRecommendationTools
        context={recommendationContext}
        onContextChange={updateRecommendationContext}
        shakeProduct={orderedProducts.find((product) => product.id === shakeProductId) ?? null}
        shakeCount={shakeProductIds.length}
        shakeLimit={3}
        onShake={requestShakeRecommendation}
        onOpenProduct={openProductDetail}
        onChooseProduct={chooseRecommendedProduct}
        onInteraction={trackRecommendationTool}
      />}

      <div className="menu-workspace-body">
        <div className="menu-catalog">
          <nav className="menu-categories" aria-label="菜单分类">
            {(guestSalesMode ? guestMenuViews : staffCategories).map((category) => (
              <button
                key={category.id}
                data-testid={guestSalesMode ? `guest-menu-view-${category.id}` : undefined}
                className={[
                  (guestSalesMode ? guestMenuView === category.id : categoryId === category.id) ? 'is-active' : '',
                  guestSalesMode && category.id === 'search' ? 'is-search-shortcut' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => {
                if (guestSalesMode) changeGuestMenuView(category.id as typeof guestMenuViews[number]['id'])
                else {
                  setCategoryId(category.id)
                  emitInteraction('category_viewed', { categoryId: category.id })
                }
              }}
              >
                {category.name}
              </button>
            ))}
          </nav>
          {guestSalesMode && guestMenuView === 'drinks' && <nav className="menu-subcategories" aria-label="酒水分类">
            {beverageFamilies.map((family) => <button
              key={family.id}
              className={beverageFamily === family.id ? 'is-active' : ''}
              onClick={() => {
                setBeverageFamily(family.id)
                emitInteraction('category_viewed', { categoryId: `drinks:${family.id}` })
              }}
            >{family.name}</button>)}
          </nav>}
          {guestSalesMode && guestMenuView === 'recommend' && !searchQuery.trim() && <header className="menu-recommendation-heading">
            <div><small>FOR TONIGHT</small><strong>今夜特别推荐</strong></div>
            <span>已按 {Math.max(1, partySize)} 位{recommendationScene && recommendationScene !== 'unsure' ? ` · ${recommendationSceneLabels[recommendationScene] ?? '同行'}` : ''}筛选 · 直接比较</span>
          </header>}
          {guestSalesMode && guestMenuView === 'recommend' && !searchQuery.trim() && recommendationFeedback && <div className="menu-recommendation-feedback" role="status" aria-live="polite" data-testid="recommendation-updated-feedback">
            <CheckCircle2 size={15} aria-hidden="true" />
            <span>{recommendationFeedback}</span>
          </div>}
          {guestSalesMode && guestMenuView === 'recommend' && !searchQuery.trim() && comparisonOptions.length > 0 && <section className="menu-recommendation-compare" aria-label="今夜推荐方案对比">
            <header>
              <strong>{comparisonOptions.length >= 3 ? '三款都适合今晚' : '今晚适合您的选择'}</strong>
              <span>左右滑动比较酒型、价格和内容</span>
            </header>
            <div className="menu-recommendation-options">
              {comparisonOptions.map((option) => {
                const product = option.product
                const quantity = cart[product.id] ?? 0
                const status = availability.get(product.id)!
                const comparisonAmount = bundleComparisonAmount(product, orderedProducts)
                const savingsAmount = comparisonAmount !== null ? comparisonAmount - product.listPriceAmount : 0
                const savingsRatio = comparisonAmount && comparisonAmount > 0 ? savingsAmount / comparisonAmount : 0
                const roleLabel = option.role === 'lighter' ? '轻松开始'
                  : option.role === 'primary' ? '今晚正好'
                    : option.role === 'complete' ? '更完整'
                      : recommendationConfig(product).badge || comparisonFamilyLabels[product.beverageFamily ?? ''] || '换种风格'
                const chooseLabel = option.role === 'lighter' ? '这份就好'
                  : option.role === 'primary' ? '就这样安排'
                    : option.role === 'complete' ? '今晚更尽兴'
                      : '选这款'
                return <article
                  className={`menu-recommendation-option is-${option.role}${status.orderable ? '' : ' is-unavailable'}`}
                  data-testid={`menu-product-${product.id}`}
                  key={product.id}
                >
                  <button type="button" className="menu-recommendation-option-media" onClick={() => openProductDetail(product)} aria-label={`查看${product.name}详情`}>
                    {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="eager" decoding="async" /> : <span>{product.name.slice(0, 1)}</span>}
                    <b className={option.role === 'primary' ? 'is-popular' : undefined}>
                      {option.role === 'primary' && <span className="menu-popular-mark"><ThumbsUp size={11} strokeWidth={2.2} aria-hidden="true" /></span>}
                      <span>{option.role === 'primary' ? '人气优选' : roleLabel}</span>
                    </b>
                  </button>
                  {status.orderable && quantity === 0 && <button
                    type="button"
                    className="menu-recommendation-quick-add"
                    aria-label={`快速加入${product.name}`}
                    onClick={() => changeQuantity(product.id, 1)}
                  ><Plus size={19} strokeWidth={2.5} /></button>}
                  <div className="menu-recommendation-option-copy">
                    <button type="button" className="menu-recommendation-option-title" aria-label={`查看${product.name}详情`} onClick={() => openProductDetail(product)}>
                      <strong>{product.name}</strong>
                      <span>{recommendationConfig(product).headline || option.reason}</span>
                    </button>
                    <p>{menuProductContents(product, orderedProducts)}</p>
                    <div className="menu-recommendation-option-value">
                      <strong>¥{formatMenuAmount(product.listPriceAmount)}</strong>
                      {savingsRatio >= .1
                        ? <span>单点 ¥{formatMenuAmount(comparisonAmount!)}<b>少付 ¥{formatMenuAmount(savingsAmount)}</b></span>
                        : <span><b>组合已配齐</b></span>}
                    </div>
                    {!status.orderable ? <button className="menu-recommendation-choose" disabled><Clock3 size={16} />{status.label}</button>
                      : quantity === 0 ? <button className="menu-recommendation-choose" onClick={() => changeQuantity(product.id, 1)}><Plus size={16} />{chooseLabel}</button>
                        : <div className="menu-recommendation-selected">
                          <button title={`减少${product.name}`} onClick={() => changeQuantity(product.id, -1)}><Minus size={16} /></button>
                          <span>已选 {quantity}</span>
                          <button title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={16} /></button>
                        </div>}
                  </div>
                </article>
              })}
            </div>
          </section>}
          {guestSalesMode && guestMenuView === 'recommend' && !searchQuery.trim() && <section className="menu-recommendation-browse" aria-label="继续浏览菜单">
            <div><strong>继续逛逛</strong><span>单点酒水和小食也可以慢慢选</span></div>
            <button type="button" onClick={() => changeGuestMenuView('drinks')}>看酒水<ChevronRight size={15} /></button>
            <button type="button" onClick={() => changeGuestMenuView('food')}>看小食<ChevronRight size={15} /></button>
          </section>}
          <div className="menu-search-toolbar">
            <label className="menu-search-control">
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="搜索菜单商品"
                autoComplete="off"
                enterKeyHint="search"
                inputMode="search"
                placeholder="搜索酒水、小食、组合或规格"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setSearchQuery('')
                    event.currentTarget.blur()
                  }
                }}
              />
              {searchQuery && (
                <button type="button" title="清除搜索" aria-label="清除搜索" onClick={() => setSearchQuery('')}>
                  <X size={16} />
                </button>
              )}
            </label>
            <span className="menu-search-count" aria-live="polite">
              {searchQuery
                ? `找到 ${visibleProducts.length} 项`
                : guestSalesMode ? `可搜 ${guestSearchableProductCount} 项` : `共 ${visibleProducts.length} 项`}
            </span>
          </div>
          {(!guestSalesMode || guestMenuView !== 'recommend' || searchQuery.trim() || visibleProducts.length > 0) && <div className={`menu-product-grid${visibleProducts.length === 1 ? ' has-single-product' : ''}`}>
            {visibleProducts.length === 0 && (
              <div className="menu-product-empty">
                {guestSalesMode && guestMenuView === 'recommend' ? <Sparkles size={26} aria-hidden="true" /> : <Search size={26} aria-hidden="true" />}
                <strong>{guestSalesMode && guestMenuView === 'recommend' ? '今夜推荐正在更新' : '没有找到相关商品'}</strong>
                <span>{guestSalesMode && guestMenuView === 'recommend' ? '可以直接看看酒水和小食，喜欢的照常点' : '换个商品名、分类或规格试试'}</span>
                {searchQuery && <button type="button" onClick={() => setSearchQuery('')}>清除搜索</button>}
              </div>
            )}
            {visibleProducts.map((product) => {
              const quantity = cart[product.id] ?? 0
              const status = availability.get(product.id)!
              const recommendationRole: string = ''
              const comparisonAmount = bundleComparisonAmount(product, orderedProducts)
              const savingsAmount = comparisonAmount !== null ? comparisonAmount - product.listPriceAmount : 0
              const recommendation = recommendationConfig(product)
              const rankedRecommendation = rankedRecommendations.find((item) => item.product.id === product.id)
              return (
                <article
                  className={`menu-product${status.orderable ? '' : ' is-unavailable'}${recommendationRole ? ` is-recommendation-${recommendationRole}` : ''}`}
                  data-testid={`menu-product-${product.id}`}
                  key={product.id}
                >
                  <button type="button" className="menu-product-image" onClick={() => openProductDetail(product)} aria-label={`查看${product.name}详情`}>
                    {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" decoding="async" /> : <div>{product.name.slice(0, 1)}</div>}
                    {status.orderable
                      ? <span>{recommendationRole === 'primary' ? recommendation.badge || '今晚正好' : recommendationRole === 'lighter' ? '轻松一点' : recommendationRole === 'complete' ? '更完整' : customerFacingProductTag(product) ?? (product.productKind === 'bundle' ? '组合甄选' : '')}</span>
                      : <span className={`menu-product-status is-${status.state}`}>{status.label}</span>}
                  </button>
                  <div className="menu-product-info">
                    <button type="button" className="menu-product-title" aria-label={`查看${product.name}详情`} onClick={() => openProductDetail(product)}><strong>{product.name}</strong><span>{product.specification}</span></button>
                    <p>{status.orderable
                      ? (recommendationRole ? recommendation.headline || recommendation.reason || rankedRecommendation?.reason : product.description) || '门店现制现送'
                      : status.label}</p>
                    {product.productKind === 'bundle' && savingsAmount > 0 && <small className="menu-product-value">单点合计 ¥{formatMenuAmount(comparisonAmount!)} · 少付 ¥{formatMenuAmount(savingsAmount)}</small>}
                    <footer>
                      <b>¥{(product.listPriceAmount / 100).toFixed(0)}</b>
                      {!status.orderable ? (
                        <button className="menu-unavailable-button" title={status.label} aria-label={`${product.name}暂不可点，${status.label}`} disabled><Clock3 size={18} /></button>
                      ) : quantity === 0 ? (
                        <button type="button" className="menu-add-button" title={`加入${product.name}`} aria-label={`加入${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={20} strokeWidth={2.5} /></button>
                      ) : (
                        <div className={`menu-stepper${(product.maxOrderQuantity ?? 50) > 50 ? ' has-direct-input' : ''}`}>
                          <button type="button" title={`减少${product.name}`} onClick={() => changeQuantity(product.id, -1)}><Minus size={17} /></button>
                          {(product.maxOrderQuantity ?? 50) > 50
                            ? <input aria-label={`${product.name}数量`} type="number" inputMode="numeric" min={1} max={product.maxOrderQuantity} value={quantity} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setProductQuantity(product.id, Number(event.target.value))} />
                            : <strong>{quantity}</strong>}
                          <button type="button" title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={17} /></button>
                        </div>
                      )}
                    </footer>
                  </div>
                </article>
              )
            })}
          </div>}
        </div>

        {compactCart ? <>
          {cartOpen && <button className="menu-cart-drawer-backdrop" type="button" aria-label="关闭购物车" onClick={() => setCartOpen(false)} />}
          {cartOpen && (
            <aside className="menu-cart-drawer" role="dialog" aria-modal="true" aria-label="购物车明细">
              <div className="menu-cart-heading"><ShoppingCart size={20} /><strong>已选商品</strong><span>{itemCount} 件</span><button className="icon-button" title="关闭购物车" onClick={() => setCartOpen(false)}><X size={18} /></button></div>
              <div className="menu-cart-lines">{cartLines}</div>
              {fulfillmentNoteField}
              <footer className="menu-cart-drawer-footer">
                <div><span>{deemphasizeCollapsedTotal ? '核对后收款' : '合计'}</span><strong>¥{formatMenuAmount(total)}</strong></div>
                <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy || submitDisabled} onClick={() => void submit()}>
                  <Check size={18} />{busy ? '正在提交' : submitLabel}
                </button>
              </footer>
            </aside>
          )}
          <aside className={`menu-cart-dock${itemCount === 0 ? ' is-empty' : ''}`} aria-label="订单结算">
            <button
              className="menu-cart-summary"
              type="button"
              disabled={itemCount === 0}
              aria-expanded={cartOpen}
              aria-label={`查看购物车，已选${itemCount}件，合计${formatMenuAmount(total)}元`}
              onClick={() => setCartOpen((open) => !open)}
            >
              <span className="menu-cart-summary-icon"><ShoppingCart size={20} /><b>{itemCount}</b></span>
              <span className="menu-cart-summary-copy">
                <strong>{itemCount > 0 ? `已选 ${itemCount} 件` : '还未选择商品'}</strong>
                <small>{itemCount > 0 ? (deemphasizeCollapsedTotal ? '需要时打开核对' : `查看明细 · 合计 ¥${formatMenuAmount(total)}`) : '点击商品加入订单'}</small>
              </span>
            </button>
            <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy || submitDisabled} onClick={() => setCartOpen(true)}>
              {submitDisabled ? submitLabel : '查看已选'}<ChevronRight size={18} />
            </button>
          </aside>
        </> : (
          <aside className="menu-cart-panel">
            <div className="menu-cart-heading"><ShoppingCart size={20} /><strong>已选商品</strong><span>{itemCount} 件</span></div>
            <div className="menu-cart-lines">{cartLines}</div>
            {fulfillmentNoteField}
            <div className="menu-cart-total"><span><ShoppingCart size={16} /><b>{itemCount}</b>件 · 合计</span><strong>¥{(total / 100).toFixed(2)}</strong></div>
            <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy || submitDisabled} onClick={() => void submit()}>
              <Check size={19} />{busy ? '正在提交' : submitLabel}
            </button>
            <p className="menu-submit-hint">{submitHint}</p>
          </aside>
        )}
      </div>

      {detailProduct && <>
        <button className="menu-detail-backdrop" type="button" aria-label="关闭商品详情" onClick={() => setDetailProductId('')} />
        <aside className="menu-detail-drawer" role="dialog" aria-modal="true" aria-label={`${detailProduct.name}商品详情`}>
          <header>
            <div><small>{detailProduct.productKind === 'bundle' ? 'CURATED FOR TONIGHT' : detailProduct.categoryName ?? 'M-BOX MENU'}</small><h2>{detailProduct.name}</h2><span>{detailProduct.specification}</span></div>
            <button className="icon-button" title="关闭商品详情" onClick={() => setDetailProductId('')}><X size={18} /></button>
          </header>
          <div className="menu-detail-media">{detailProduct.imageUrl
            ? <img src={detailProduct.imageUrl} alt={detailProduct.name} />
            : <span>{Array.from(detailProduct.name)[0]}</span>}</div>
          <div className="menu-detail-content">
            <p>{detailProduct.description || '门店现制现送，确认后为您安排。'}</p>
            {detailComponents.length > 0 && <section className="menu-detail-components">
              <header><strong>这份组合包含</strong><span>{detailComponents.length}款酒水与小食</span></header>
              <div>{detailComponents.map((component) => {
                const product = component.product!
                return <article key={component.productId}>
                  <div className="menu-detail-component-media">{product.imageUrl
                    ? <img src={product.imageUrl} alt="" loading="lazy" decoding="async" />
                    : <span aria-hidden="true">{Array.from(product.name)[0]}</span>}</div>
                  <div className="menu-detail-component-copy">
                    <strong>{product.name}</strong>
                    {product.specification && <small>{product.specification}</small>}
                    <p>{product.description || '按门店标准为您准备。'}</p>
                  </div>
                  <b>× {component.quantity}</b>
                </article>
              })}</div>
            </section>}
            {detailProduct.productKind === 'bundle' && detailSavingsAmount > 0 && <section className="menu-detail-value">
              <span>按当前单点合计 <s>¥{formatMenuAmount(detailComparisonAmount!)}</s></span>
              <strong>这份安排少付 ¥{formatMenuAmount(detailSavingsAmount)}</strong>
            </section>}
            <section className="menu-detail-service">
              <span>{recommendationConfig(detailProduct).singleWaveEligible ? '按一轮集中准备，尽量一次上齐' : '按现场最佳状态分批送达'}</span>
              {recommendationConfig(detailProduct).expectedPrepMinutes > 0 && <small>预计约 {recommendationConfig(detailProduct).expectedPrepMinutes} 分钟开始出品</small>}
            </section>
          </div>
          <footer>
            <div><small>今晚价格</small><strong>¥{formatMenuAmount(detailProduct.listPriceAmount)}</strong></div>
            {detailQuantity === 0 ? <button
              className="menu-submit-button"
              data-haptic="action"
              disabled={availability.get(detailProduct.id)?.orderable !== true}
              onClick={() => changeQuantity(detailProduct.id, 1)}
            ><Plus size={18} />加入购物车</button> : <div className="menu-detail-stepper" aria-label={`${detailProduct.name}已选${detailQuantity}件`}>
              <button type="button" aria-label={`减少${detailProduct.name}`} onClick={() => changeQuantity(detailProduct.id, -1)}><Minus size={18} /></button>
              <span><small>已加入购物车</small><strong>{detailQuantity} 件</strong></span>
              <button type="button" aria-label={`增加${detailProduct.name}`} onClick={() => changeQuantity(detailProduct.id, 1)}><Plus size={18} /></button>
            </div>}
          </footer>
        </aside>
      </>}

      {guestSalesMode && upgradeProduct && upgradeSourceProduct && upgradeProduct.listPriceAmount > upgradeSourceProduct.listPriceAmount && <div className="menu-upgrade-backdrop" role="presentation" onClick={() => {
        setUpgradePromptProductId('')
        setUpgradeSourceProductId('')
      }}>
        <section className="menu-upgrade-dialog" role="dialog" aria-modal="true" aria-label="升级今晚选择" onClick={(event) => event.stopPropagation()}>
          <small>再完整一点</small>
          <h2>加 ¥{formatMenuAmount(upgradeProduct.listPriceAmount - upgradeSourceProduct.listPriceAmount)}，换成{upgradeProduct.name}</h2>
          <p>{recommendationConfig(upgradeProduct).reason || upgradeProduct.description || '更适合今晚完整地喝一轮。'}</p>
          <footer>
            <button className="secondary-button" onClick={() => {
              setUpgradePromptProductId('')
              setUpgradeSourceProductId('')
            }}>保持现在这样</button>
            <button className="primary-button" onClick={() => {
              removeProduct(upgradeSourceProduct.id)
              setProductQuantity(upgradeProduct.id, 1)
              emitInteraction('upgrade_accepted', {
                productId: upgradeProduct.id,
                metadata: { fromProductId: upgradeSourceProduct.id },
              })
              setUpgradePromptProductId('')
              setUpgradeSourceProductId('')
            }}>升级这一份</button>
          </footer>
        </section>
      </div>}

      {confirmation && <div className="menu-confirm-backdrop" role="presentation" onClick={() => setConfirmation(null)}>
        <section className="menu-confirm-dialog" role="dialog" aria-modal="true" aria-label={confirmation === 'continue' ? '确认继续加单' : complimentaryMode ? '确认赠送' : '确认上单'} onClick={(event) => event.stopPropagation()}>
          <header>
            <span className={confirmation === 'duplicate' ? 'is-warning' : ''}>{confirmation === 'duplicate' ? <AlertTriangle size={22} /> : complimentaryMode ? <Gift size={22} /> : <ShoppingCart size={22} />}</span>
            <div><small>{confirmation === 'continue' ? 'CONTINUE ORDER' : complimentaryMode ? 'GIFT CHECK' : 'ORDER CHECK'}</small><h2>{confirmation === 'duplicate' ? '刚刚下过一笔相同订单' : confirmation === 'continue' ? '还要继续加单吗？' : complimentaryMode ? '请确认这次赠送' : '请确认这次上单'}</h2></div>
            <button className="icon-button" title="关闭" onClick={() => setConfirmation(null)}><X size={19} /></button>
          </header>
          {confirmation === 'continue' ? <p>您刚完成一次下单。确认是新一轮加单后再继续，避免手滑重复上单。</p> : <>
            <div className="menu-confirm-lines">{cartProducts.map((product) => <div key={product.id}><span>{product.name} × {cart[product.id]}</span><strong>¥{((product.listPriceAmount * cart[product.id]!) / 100).toFixed(2)}</strong></div>)}</div>
            <div className="menu-confirm-total"><span>{complimentaryMode ? `赠送价值 · 共 ${itemCount} 件` : `共 ${itemCount} 件`}</span><strong>{complimentaryMode ? '客人零应付' : `¥${(total / 100).toFixed(2)}`}</strong></div>
            {fulfillmentNoteField}
            <p>{confirmation === 'duplicate' ? '请先查看订单记录。只有确定需要再上一份相同商品时，才继续加单。' : complimentaryMode ? '确认后按当前登录员工本人的赠送权限校验，零应付并直接送往吧台或厨房。' : '确认后订单会送到吧台或厨房，请勿连续点击或重复提交。'}</p>
          </>}
          {confirmationError && <div className="menu-confirm-error" role="alert">{confirmationError}</div>}
          <footer>
            <button className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>再看看</button>
            <button className="primary-button" data-haptic="action" disabled={busy || submitDisabled || (confirmation === 'duplicate' && !confirmedDuplicateOrderId)} onClick={() => {
              if (confirmation === 'continue') confirmContinuation()
              else void executeSubmit(confirmation === 'duplicate' ? confirmedDuplicateOrderId : undefined)
            }}><Check size={17} />{busy ? '正在提交' : confirmation === 'duplicate' ? '确认继续加单' : confirmation === 'continue' ? '继续选商品' : complimentaryMode ? '确认赠送' : '确认上单'}</button>
          </footer>
        </section>
      </div>}
    </section>
  )
}

function menuHaptic(duration: number): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  navigator.vibrate(duration)
}
