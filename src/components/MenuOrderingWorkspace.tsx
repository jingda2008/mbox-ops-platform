import { AlertTriangle, Check, Clock3, Minus, Plus, ShoppingCart, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError } from '../api'
import type { OrderSafetyConfig } from '../shared/commercial-ops-contracts'
import type { MenuProduct } from '../shared/contracts'
import { productAvailability } from '../shared/product-availability'
import './MenuOrderingWorkspace.css'

export interface MenuCartItem {
  productId: string
  quantity: number
}

export interface MenuInteraction {
  type: 'category_viewed' | 'product_added' | 'product_removed' | 'cart_cleared'
  productId?: string
  categoryId?: string
  quantity?: number
}

interface MenuOrderingWorkspaceProps {
  products: MenuProduct[]
  tableLabel: string
  tableControl?: ReactNode
  submitLabel: string
  submitHint: string
  busy?: boolean
  timeZone?: string
  orderSafety?: OrderSafetyConfig
  compactCart?: boolean
  onSubmit: (items: MenuCartItem[], options: { confirmedDuplicateOrderId?: string }) => Promise<void>
  onInteraction?: (interaction: MenuInteraction) => void
}

export function MenuOrderingWorkspace({
  products,
  tableLabel,
  tableControl,
  submitLabel,
  submitHint,
  busy = false,
  timeZone = 'Asia/Shanghai',
  onSubmit,
  onInteraction,
  orderSafety,
  compactCart = false,
}: MenuOrderingWorkspaceProps) {
  const [cart, setCart] = useState<Record<string, number>>({})
  const [categoryId, setCategoryId] = useState('all')
  const [clock, setClock] = useState(() => Date.now())
  const [confirmation, setConfirmation] = useState<'submit' | 'duplicate' | 'continue' | null>(null)
  const [confirmationError, setConfirmationError] = useState('')
  const [confirmedDuplicateOrderId, setConfirmedDuplicateOrderId] = useState('')
  const [pendingProductId, setPendingProductId] = useState('')
  const [lastSubmittedAt, setLastSubmittedAt] = useState(0)
  const [cartOpen, setCartOpen] = useState(false)
  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])
  const orderedProducts = useMemo(
    () => products.filter((item) => item.enabled).sort((left, right) => (left.sortOrder ?? 999) - (right.sortOrder ?? 999)),
    [products],
  )
  const categories = useMemo(() => [
    { id: 'all', name: '全部' },
    ...Array.from(new Map(orderedProducts.map((product) => [
      product.categoryId ?? 'featured',
      product.categoryName ?? '推荐',
    ])).entries()).map(([id, name]) => ({ id, name })),
  ], [orderedProducts])
  const visibleProducts = categoryId === 'all'
    ? orderedProducts
    : orderedProducts.filter((product) => (product.categoryId ?? 'featured') === categoryId)
  const availability = useMemo(() => new Map(orderedProducts.map((product) => [
    product.id,
    productAvailability(product, new Date(clock), timeZone),
  ])), [clock, orderedProducts, timeZone])
  const cartProducts = orderedProducts.filter((product) => (
    (cart[product.id] ?? 0) > 0 && availability.get(product.id)?.orderable
  ))
  const itemCount = cartProducts.reduce((sum, product) => sum + (cart[product.id] ?? 0), 0)
  const total = cartProducts.reduce((sum, product) => sum + product.listPriceAmount * (cart[product.id] ?? 0), 0)

  useEffect(() => {
    if (itemCount === 0) setCartOpen(false)
  }, [itemCount])

  useEffect(() => {
    setCart((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([productId]) => {
        const product = products.find((item) => item.id === productId)
        return product && productAvailability(product, new Date(clock), timeZone).orderable
      }))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [clock, products, timeZone])

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
    const nextQuantity = Math.max(0, Math.min(50, (cart[productId] ?? 0) + delta))
    setCart((current) => {
      if (nextQuantity === 0) {
        const next = { ...current }
        delete next[productId]
        return next
      }
      return { ...current, [productId]: nextQuantity }
    })
    onInteraction?.({
      type: delta > 0 ? 'product_added' : 'product_removed',
      productId,
      quantity: nextQuantity,
    })
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
    if (cartProducts.length === 0 || busy) return
    if (orderSafety?.requireSubmitConfirmation !== false) {
      setConfirmationError('')
      setConfirmation('submit')
      return
    }
    await executeSubmit()
  }

  async function executeSubmit(duplicateOrderId?: string) {
    if (cartProducts.length === 0 || busy) return
    try {
      await onSubmit(
        cartProducts.map((product) => ({ productId: product.id, quantity: cart[product.id]! })),
        { confirmedDuplicateOrderId: duplicateOrderId },
      )
      setCart({})
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

  const cartLines = cartProducts.length === 0 ? (
    <div className="menu-cart-empty"><ShoppingCart size={28} /><span>点击商品图片旁的加号</span></div>
  ) : cartProducts.map((product) => (
    <div className="menu-cart-line" key={product.id}>
      <div><strong>{product.name}</strong><span>¥{(product.listPriceAmount / 100).toFixed(0)} × {cart[product.id]}</span></div>
      <div className="menu-stepper">
        <button title={`移除${product.name}`} onClick={() => removeProduct(product.id)}><Trash2 size={15} /></button>
        <strong>{cart[product.id]}</strong>
        <button title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={15} /></button>
      </div>
    </div>
  ))

  return (
    <section className={`menu-ordering-workspace${compactCart ? ' has-compact-cart' : ''}`}>
      <header className="menu-workspace-header">
        <div>
          <span>当前桌台</span>
          <strong>{tableLabel}</strong>
        </div>
        {tableControl}
      </header>

      <div className="menu-workspace-body">
        <div className="menu-catalog">
          <nav className="menu-categories" aria-label="菜单分类">
            {categories.map((category) => (
              <button key={category.id} className={categoryId === category.id ? 'is-active' : ''} onClick={() => { setCategoryId(category.id); onInteraction?.({ type: 'category_viewed', categoryId: category.id }) }}>
                {category.name}
              </button>
            ))}
          </nav>
          <div className="menu-product-grid">
            {visibleProducts.map((product) => {
              const quantity = cart[product.id] ?? 0
              const status = availability.get(product.id)!
              return (
                <article className={`menu-product${status.orderable ? '' : ' is-unavailable'}`} key={product.id}>
                  <div className="menu-product-image">
                    {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" decoding="async" /> : <div>{product.name.slice(0, 1)}</div>}
                    {status.orderable
                      ? (product.tags ?? []).slice(0, 1).map((tag) => <span key={tag}>{tag}</span>)
                      : <span className={`menu-product-status is-${status.state}`}>{status.label}</span>}
                  </div>
                  <div className="menu-product-info">
                    <div><strong>{product.name}</strong><span>{product.specification}</span></div>
                    <p>{status.orderable ? product.description || '门店现制现送' : status.label}</p>
                    <footer>
                      <b>¥{(product.listPriceAmount / 100).toFixed(0)}</b>
                      {!status.orderable ? (
                        <button className="menu-unavailable-button" title={status.label} disabled><Clock3 size={18} /></button>
                      ) : quantity === 0 ? (
                        <button className="menu-add-button" title={`加入${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={20} /></button>
                      ) : (
                        <div className="menu-stepper">
                          <button title={`减少${product.name}`} onClick={() => changeQuantity(product.id, -1)}><Minus size={17} /></button>
                          <strong>{quantity}</strong>
                          <button title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={17} /></button>
                        </div>
                      )}
                    </footer>
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        {compactCart ? <>
          {cartOpen && <button className="menu-cart-drawer-backdrop" type="button" aria-label="关闭购物车" onClick={() => setCartOpen(false)} />}
          {cartOpen && (
            <aside className="menu-cart-drawer" role="dialog" aria-modal="true" aria-label="购物车明细">
              <div className="menu-cart-heading"><ShoppingCart size={20} /><strong>已选商品</strong><span>{itemCount} 件</span><button className="icon-button" title="关闭购物车" onClick={() => setCartOpen(false)}><X size={18} /></button></div>
              <div className="menu-cart-lines">{cartLines}</div>
              <footer className="menu-cart-drawer-footer">
                <div><span>合计</span><strong>¥{(total / 100).toFixed(2)}</strong></div>
                <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy} onClick={() => void submit()}>
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
              aria-label={`查看购物车，${itemCount}件商品，合计${(total / 100).toFixed(2)}元`}
              onClick={() => setCartOpen((open) => !open)}
            >
              <span><ShoppingCart size={20} /><b>{itemCount}</b><small>件</small><em>购物车</em></span>
              <strong>¥{(total / 100).toFixed(2)}</strong>
            </button>
            <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy} onClick={() => void submit()}>
              <Check size={19} />{busy ? '正在提交' : submitLabel}
            </button>
          </aside>
        </> : (
          <aside className="menu-cart-panel">
            <div className="menu-cart-heading"><ShoppingCart size={20} /><strong>已选商品</strong><span>{itemCount} 件</span></div>
            <div className="menu-cart-lines">{cartLines}</div>
            <div className="menu-cart-total"><span><ShoppingCart size={16} /><b>{itemCount}</b>件 · 合计</span><strong>¥{(total / 100).toFixed(2)}</strong></div>
            <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy} onClick={() => void submit()}>
              <Check size={19} />{busy ? '正在提交' : submitLabel}
            </button>
            <p className="menu-submit-hint">{submitHint}</p>
          </aside>
        )}
      </div>

      {confirmation && <div className="menu-confirm-backdrop" role="presentation" onClick={() => setConfirmation(null)}>
        <section className="menu-confirm-dialog" role="dialog" aria-modal="true" aria-label={confirmation === 'continue' ? '确认继续加单' : '确认上单'} onClick={(event) => event.stopPropagation()}>
          <header>
            <span className={confirmation === 'duplicate' ? 'is-warning' : ''}>{confirmation === 'duplicate' ? <AlertTriangle size={22} /> : <ShoppingCart size={22} />}</span>
            <div><small>{confirmation === 'continue' ? 'CONTINUE ORDER' : 'ORDER CHECK'}</small><h2>{confirmation === 'duplicate' ? '刚刚下过一笔相同订单' : confirmation === 'continue' ? '还要继续加单吗？' : '请确认这次上单'}</h2></div>
            <button className="icon-button" title="关闭" onClick={() => setConfirmation(null)}><X size={19} /></button>
          </header>
          {confirmation === 'continue' ? <p>您刚完成一次下单。确认是新一轮加单后再继续，避免手滑重复上单。</p> : <>
            <div className="menu-confirm-lines">{cartProducts.map((product) => <div key={product.id}><span>{product.name} × {cart[product.id]}</span><strong>¥{((product.listPriceAmount * cart[product.id]!) / 100).toFixed(2)}</strong></div>)}</div>
            <div className="menu-confirm-total"><span>共 {itemCount} 件</span><strong>¥{(total / 100).toFixed(2)}</strong></div>
            <p>{confirmation === 'duplicate' ? '请先查看订单记录。只有确定需要再上一份相同商品时，才继续加单。' : '确认后订单会送到吧台或厨房，请勿连续点击或重复提交。'}</p>
          </>}
          {confirmationError && <div className="menu-confirm-error" role="alert">{confirmationError}</div>}
          <footer>
            <button className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>再看看</button>
            <button className="primary-button" disabled={busy || (confirmation === 'duplicate' && !confirmedDuplicateOrderId)} onClick={() => {
              if (confirmation === 'continue') confirmContinuation()
              else void executeSubmit(confirmation === 'duplicate' ? confirmedDuplicateOrderId : undefined)
            }}><Check size={17} />{busy ? '正在提交' : confirmation === 'duplicate' ? '确认继续加单' : confirmation === 'continue' ? '继续选商品' : '确认上单'}</button>
          </footer>
        </section>
      </div>}
    </section>
  )
}
