import { useEffect, useMemo, useState } from 'react'
import { Check, Gift, LoaderCircle, Minus, Plus, Search, ShoppingCart, X } from 'lucide-react'
import type {
  AssistedOrderAccess,
  AssistedOrderCatalogProduct,
  StaffActionsApiPort,
} from './staff-actions-api'

export interface AssistedOrderSheetProps {
  api: StaffActionsApiPort
  mode: 'paid' | 'gift'
  table: Readonly<{ code: string; activeSession: { id: string } }>
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
          <button type="button" className={settlementMode === 'immediate_payment' ? 'is-active' : ''} onClick={() => setSettlementMode('immediate_payment')}>立即结算</button>
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
