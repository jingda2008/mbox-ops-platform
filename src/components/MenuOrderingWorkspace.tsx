import { Check, Clock3, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MenuProduct } from '../shared/contracts'
import { productAvailability } from '../shared/product-availability'
import './MenuOrderingWorkspace.css'

export interface MenuCartItem {
  productId: string
  quantity: number
}

interface MenuOrderingWorkspaceProps {
  products: MenuProduct[]
  tableLabel: string
  tableControl?: ReactNode
  submitLabel: string
  submitHint: string
  busy?: boolean
  timeZone?: string
  onSubmit: (items: MenuCartItem[]) => Promise<void>
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
}: MenuOrderingWorkspaceProps) {
  const [cart, setCart] = useState<Record<string, number>>({})
  const [categoryId, setCategoryId] = useState('all')
  const [clock, setClock] = useState(() => Date.now())
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
    setCart((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([productId]) => {
        const product = products.find((item) => item.id === productId)
        return product && productAvailability(product, new Date(clock), timeZone).orderable
      }))
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [clock, products, timeZone])

  function changeQuantity(productId: string, delta: number) {
    setCart((current) => {
      const nextQuantity = Math.max(0, Math.min(50, (current[productId] ?? 0) + delta))
      if (nextQuantity === 0) {
        const next = { ...current }
        delete next[productId]
        return next
      }
      return { ...current, [productId]: nextQuantity }
    })
  }

  async function submit() {
    if (cartProducts.length === 0 || busy) return
    await onSubmit(cartProducts.map((product) => ({ productId: product.id, quantity: cart[product.id]! })))
    setCart({})
  }

  return (
    <section className="menu-ordering-workspace">
      <header className="menu-workspace-header">
        <div>
          <span>当前桌台</span>
          <strong>{tableLabel}</strong>
        </div>
        {tableControl}
        <div className="menu-cart-count"><ShoppingCart size={18} /><strong>{itemCount}</strong><span>件</span></div>
      </header>

      <div className="menu-workspace-body">
        <div className="menu-catalog">
          <nav className="menu-categories" aria-label="菜单分类">
            {categories.map((category) => (
              <button key={category.id} className={categoryId === category.id ? 'is-active' : ''} onClick={() => setCategoryId(category.id)}>
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
                    {product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : <div>{product.name.slice(0, 1)}</div>}
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

        <aside className="menu-cart-panel">
          <div className="menu-cart-heading"><ShoppingCart size={20} /><strong>已选商品</strong><span>{itemCount} 件</span></div>
          <div className="menu-cart-lines">
            {cartProducts.length === 0 ? (
              <div className="menu-cart-empty"><ShoppingCart size={28} /><span>点击商品图片旁的加号</span></div>
            ) : cartProducts.map((product) => (
              <div className="menu-cart-line" key={product.id}>
                <div><strong>{product.name}</strong><span>¥{(product.listPriceAmount / 100).toFixed(0)} × {cart[product.id]}</span></div>
                <div className="menu-stepper">
                  <button title={`移除${product.name}`} onClick={() => setCart((current) => ({ ...current, [product.id]: 0 }))}><Trash2 size={15} /></button>
                  <strong>{cart[product.id]}</strong>
                  <button title={`增加${product.name}`} onClick={() => changeQuantity(product.id, 1)}><Plus size={15} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="menu-cart-total"><span>已选 {itemCount} 件 · 合计</span><strong>¥{(total / 100).toFixed(2)}</strong></div>
          <button className="menu-submit-button" disabled={cartProducts.length === 0 || busy} onClick={() => void submit()}>
            <Check size={19} />{busy ? '正在提交' : submitLabel}
          </button>
          <p className="menu-submit-hint">{submitHint}</p>
        </aside>
      </div>
    </section>
  )
}
