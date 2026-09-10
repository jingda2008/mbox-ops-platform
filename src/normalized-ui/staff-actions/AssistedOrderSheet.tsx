import { useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, Check, CreditCard, Gift, LoaderCircle, Minus, Plus, QrCode, ReceiptText, RefreshCcw, ScanLine, Search, ShoppingCart, X } from 'lucide-react'
import { MenuOrderingWorkspace, type MenuCartItem, type MenuSubmitOptions } from '../../components/MenuOrderingWorkspace'
import { CustomerPaymentCodeScanner } from '../../components/CustomerPaymentCodeScanner'
import type { MenuProduct, MenuRecommendationConfig, MenuRecommendationScene } from '../../shared/contracts'
import type { OnlinePaymentAction } from '../../shared/online-payment-contracts'
import { conservativeBundleCostAmount } from '../../shared/bundle-cost-range'
import type {
  AssistedOrderAccess,
  AssistedOrderCatalogProduct,
  AssistedOrderResult,
  StaffActionsApiPort,
} from './staff-actions-api'
import { assistedProductAvailability, isAssistedOrderCatalogProduct } from './assisted-order-product'
import {clearStaffOrderDraft,readStaffOrderDraft,saveStaffOrderDraft,staffOrderDraftKey} from '../../components/staff-order-draft'

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
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({})
  useEffect(() => { loadedGiftDraft.current=undefined; giftDraftHandedOff.current=false; setItemNotes({}); setQuantities({}); setNote(''); setGiftReason('') }, [table.activeSession.id,mode])
  const [giftReason, setGiftReason] = useState('')
  const loadedGiftDraft=useRef<string|undefined>(undefined)
  const giftDraftHandedOff=useRef(false)
  const giftDraftKey=staffOrderDraftKey(access?.employeeId,table.activeSession.id,'gift')
  useEffect(()=>{
    if(mode!=='gift'||!giftDraftKey||loadedGiftDraft.current!==giftDraftKey||giftDraftHandedOff.current)return
    saveStaffOrderDraft(giftDraftKey,{quantities,selections:{},notes:itemNotes,note,giftReason})
  },[mode,giftDraftKey,quantities,itemNotes,note,giftReason])
  const [settlementMode, setSettlementMode] = useState<'immediate_payment' | 'table_tab'>('table_tab')
  const [paymentOrder, setPaymentOrder] = useState<AssistedOrderResult | null>(null)
  const [paymentAction, setPaymentAction] = useState<OnlinePaymentAction | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'succeeded' | 'failed' | 'closed'>('pending')
  const [paymentWaitingLong, setPaymentWaitingLong] = useState(false)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [paymentQueryBusy, setPaymentQueryBusy] = useState(false)
  const paymentGeneration = useRef(0)
  const paymentWriting = useRef(false)
  const [paymentEpoch, setPaymentEpoch] = useState(0)
  const advancePayment = () => {
    const generation = ++paymentGeneration.current
    setPaymentEpoch(generation)
    setPaymentQueryBusy(false)
    return generation
  }
  useEffect(() => () => { paymentGeneration.current += 1 }, [])
  const [manualPaymentRecorded, setManualPaymentRecorded] = useState(false)
  const [showPaymentScanner, setShowPaymentScanner] = useState(false)
  const announcedPaymentId = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setPhase('loading');setAccess(null)
    Promise.all([
      api.loadAssistedOrderAccess(controller.signal),
      api.loadAssistedOrderCatalog(controller.signal),
    ]).then(([nextAccess, catalog]) => {
      if(controller.signal.aborted)return
      if(mode==='gift'){
        const key=staffOrderDraftKey(nextAccess.employeeId,table.activeSession.id,'gift')
        const draft=readStaffOrderDraft(key)
        loadedGiftDraft.current=key;giftDraftHandedOff.current=false
        setQuantities(draft.quantities);setItemNotes(draft.notes);setNote(draft.note);setGiftReason(draft.giftReason)
      }
      setAccess(nextAccess)
      setProducts(catalog.filter(isAssistedOrderCatalogProduct))
      setPhase('ready')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : '商品暂时无法读取，请稍后重试')
      setPhase('error')
    })
    return () => controller.abort()
  }, [api,mode,table.activeSession.id])

  useEffect(() => {
    if (paymentAction === null || paymentStatus !== 'pending') return
    const controller = new AbortController()
    let active = true
    const generation = paymentGeneration.current
    const synchronize = async () => {
      try {
        const status = await api.loadOnlinePaymentStatus(paymentAction.paymentId, controller.signal)
        if (!active || generation !== paymentGeneration.current || status === 'pending') return
        setPaymentStatus(status)
        if (status === 'succeeded' && announcedPaymentId.current !== paymentAction.paymentId) {
          announcedPaymentId.current = paymentAction.paymentId
          onSubmitted(`${table.code} 已确认到账，订单已提交出品；收银和出品打印将按门店配置进入队列`)
        }
        if (status === 'failed' || status === 'closed') {
          setError('支付机构已确认本次未成功，可以重新发起收款。')
        }
      } catch {
        if (!active || controller.signal.aborted) return
        // A transient read failure must not turn a confirmed payment into a failed payment.
      }
    }
    void synchronize()
    const interval = window.setInterval(() => { void synchronize() }, 10_000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [api, onSubmitted, paymentAction, paymentStatus, paymentEpoch, table.code])

  useEffect(() => {
    if (paymentAction === null || paymentStatus !== 'pending') {
      setPaymentWaitingLong(false)
      return
    }
    const timeout = window.setTimeout(() => setPaymentWaitingLong(true), 60_000)
    return () => window.clearTimeout(timeout)
  }, [paymentAction, paymentStatus])

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
    if (phase === 'submitting') return
    if ((quantities[productId] ?? 0) + delta <= 0) {
      setItemNotes(current => {
        const next = { ...current }
        delete next[productId]
        return next
      })
    }
    setQuantities((current) => {
      const next = Math.max(0, Math.min(99, (current[productId] ?? 0) + delta))
      return { ...current, [productId]: next }
    })
  }

  const submit = async () => {
    if (!canSubmit) return
    giftDraftHandedOff.current=true
    clearStaffOrderDraft(giftDraftKey)
    setPhase('submitting')
    setError(null)
    try {
      const token = await api.issueAssistedOrderContext({ tableSessionId: table.activeSession.id })
      const result = await api.submitAssistedOrder({
        tableSessionId: table.activeSession.id,
        assistedOrderContextToken: token,
        orderMode: mode,
        items: selected.map((item) => ({ productId: item.product.id, quantity: item.quantity,
          ...(itemNotes[item.product.id]?.trim() ? { note: itemNotes[item.product.id]!.trim() } : {}),
        })),
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

  const submitPaidOrder = async (items: MenuCartItem[], options: MenuSubmitOptions) => {
    if (phase !== 'ready' || access?.canCreateOrder !== true || items.length === 0) throw new Error('当前不可提交，请重新核对点单权限和菜品')
    if (settlementMode === 'immediate_payment' && !canSettleImmediately(access)) {
      setError('当前岗位没有可用的线上或现场收款权限，请先挂桌账或联系收银负责人。')
      throw new Error('当前岗位没有可用收款权限，请先挂桌账或联系收银负责人')
    }
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
    if (paymentOrder === null || paymentBusy || paymentWriting.current) return false
    if (access?.canInitiatePayment !== true) {
      setError(paymentInitiationMessage(access))
      return false
    }
    if (access?.onlinePaymentProvider === null || access?.onlinePaymentProvider === undefined) {
      setError('本店当前没有启用线上收款，请改为挂桌账或联系收银员。')
      return false
    }
    paymentWriting.current = true
    const generation = advancePayment()
    setPaymentBusy(true)
    setError(null)
    try {
      const action = await api.createOnlinePayment({
        orderId: paymentOrder.paymentNextStep.orderId,
        provider: access.onlinePaymentProvider,
        method,
        ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
      })
      if (generation !== paymentGeneration.current) return false
      setPaymentAction(action)
      setManualPaymentRecorded(false)
      setPaymentStatus(action.status === 'failed' ? 'failed' : 'pending')
      setPaymentWaitingLong(false)
      setShowPaymentScanner(false)
      onSubmitted(method === 'native_qr'
        ? `${table.code} 付款码已生成，请客人扫码；未确认时可保留此笔待核对并重新收款`
        : `${table.code} 付款已受理，到账结果以支付通知为准`)
      return true
    } catch (reason) {
      if (generation !== paymentGeneration.current) return false
      setError(reason instanceof Error ? reason.message : '付款没有发起成功，请到收银页面核对')
      return false
    } finally {
      paymentWriting.current = false
      setPaymentBusy(false)
    }
  }

  const queryPayment = async () => {
    if (paymentAction === null || paymentQueryBusy) return
    const generation = paymentGeneration.current
    setPaymentQueryBusy(true)
    setError(null)
    try {
      const status = await api.queryOnlinePayment(paymentAction.paymentId)
      if (generation !== paymentGeneration.current) return
      if (status === 'succeeded') {
        setPaymentStatus('succeeded')
        onSubmitted(`${table.code} 已确认到账，订单和收银状态已同步`)
        return
      }
      if (status === 'failed' || status === 'closed') {
        setPaymentStatus(status)
        setError('支付机构已确认本次未成功，可以重新发起收款。')
        return
      }
      onSubmitted(`${table.code} 到账尚未确认，可保留旧单待核对并继续收款`)
    } catch (reason) {
      if (generation !== paymentGeneration.current) return
      setError(reason instanceof Error ? reason.message : '暂时无法核对到账，请到收银页面查看')
    } finally {
      if (generation === paymentGeneration.current) setPaymentQueryBusy(false)
    }
  }

  const releasePayment = async () => {
    if (!paymentAction || paymentBusy || paymentWriting.current || paymentStatus === 'succeeded') return
    paymentWriting.current = true
    setPaymentBusy(true)
    const generation = advancePayment()
    setError(null)
    try {
      await api.releaseUnresolvedPaymentForRetry(paymentAction.paymentId, '员工保留原支付待核对，继续收款')
      if (generation !== paymentGeneration.current) return
      setPaymentAction(null)
      setPaymentStatus('pending')
      onSubmitted(`${table.code} 可以重新收款；原支付继续财务核对，多收会进入退款待办`)
    } catch (reason) {
      if (generation !== paymentGeneration.current) return
      setError(reason instanceof Error ? reason.message : '暂未释放，请重试；其他桌台不受影响')
    } finally { paymentWriting.current = false; setPaymentBusy(false) }
  }

  const recordManualPayment = async (input: Readonly<{
    provider: 'cash' | 'physical_pos' | 'external_manual'
    receiptReference: string
    terminalId?: string
    externalMethodCode?: 'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'
    collectionNote?: string
  }>) => {
    if (paymentOrder === null || paymentBusy || paymentWriting.current) return false
    paymentWriting.current = true
    const generation = advancePayment()
    setPaymentBusy(true)
    setError(null)
    try {
      await api.recordManualPayment({ orderId: paymentOrder.paymentNextStep.orderId, ...input })
      if (generation !== paymentGeneration.current) return false
      setManualPaymentRecorded(true)
      setPaymentStatus('succeeded')
      onSubmitted(input.provider === 'cash'
        ? `${table.code} 现金收款已登记并进入日结对账`
        : input.provider === 'physical_pos'
          ? `${table.code} 实体POS收款已登记并进入日结对账`
          : `${table.code} 其他线下收款已登记并进入日结对账`)
      return true
    } catch (reason) {
      if (generation !== paymentGeneration.current) return false
      setError(reason instanceof Error ? reason.message : '现场收款没有登记成功，请到收银页面核对')
      return false
    } finally {
      paymentWriting.current = false
      setPaymentBusy(false)
    }
  }

  if (mode === 'paid') {
    const menuProducts = products.map((product) => assistedProductToMenuProduct(product, products))
    const immediatePaymentMessage = paymentInitiationMessage(access)
    const canInitiatePayment = access?.canInitiatePayment === true
    const canImmediateSettle = canSettleImmediately(access)
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
            disabled={!canImmediateSettle}
            title={!canImmediateSettle ? '当前岗位没有可用收款权限' : undefined}
            className={settlementMode === 'immediate_payment' ? 'is-active' : ''}
            onClick={() => setSettlementMode('immediate_payment')}
          >立即结算</button>
        </div>
        <p className="staff-order-payment-note">挂账可稍后统一结算；立即结算可让客人扫码，或扫描客人的付款码。</p>
        {immediatePaymentMessage !== null && <p className="staff-order-payment-note">{immediatePaymentMessage}{canImmediateSettle ? '；仍可使用下单后显示的已授权现场收款方式。' : ''}</p>}
        {error !== null && <p className="staff-order-error" role="alert">{error}</p>}
        {paymentOrder !== null ? <StaffPaymentChoice
          action={paymentAction}
          amountMinor={paymentOrder.paymentNextStep.amountMinor}
          currency={paymentOrder.paymentNextStep.currency}
          busy={paymentBusy}
          status={paymentStatus}
          waitingLong={paymentWaitingLong}
          canInitiatePayment={canInitiatePayment}
          paymentInitiationMessage={immediatePaymentMessage}
          canQuery={access?.canQueryOnlinePayment === true}
          manualCollection={access?.manualCollection ?? { canRecordCash: false, canRecordPos: false, canRecordExternal: false }}
          manualPaymentRecorded={manualPaymentRecorded}
          tableCode={table.code}
          onCreateQr={() => void createPayment('native_qr')}
          onScan={() => setShowPaymentScanner(true)}
          onQuery={() => void queryPayment()}
          queryBusy={paymentQueryBusy}
          onRelease={() => void releasePayment()}
          onManual={recordManualPayment}
          onDone={onClose}
        /> : phase === 'loading' ? <p className="staff-order-loading"><LoaderCircle className="is-spinning" /> 正在读取可售商品</p> : (
          <MenuOrderingWorkspace
            key={`${access?.employeeId??''}:${table.activeSession.id}`}
            draftStorageKey={staffOrderDraftKey(access?.employeeId,table.activeSession.id,'paid')}
            products={menuProducts}
            tableLabel={table.code}
            submitLabel="核对无误，确认下单"
            submitHint="桌号已锁定。未提交草稿可在本机当前窗口恢复；已发起提交后请先核对订单，不会自动恢复为新单。"
            busy={phase === 'submitting'}
            compactCart
            deemphasizeCollapsedTotal
            guestSalesMode
            includeNonGuestProducts
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
          const requiresBundleChoice = (product.bundleChoiceGroups?.length ?? 0) > 0
          const configurationReady = product.inventoryConfigurationComplete && !requiresBundleChoice
          const inventoryAvailable = product.inventoryAvailable
          return <article className={`${quantity > 0 ? 'is-selected' : ''}${configurationReady && inventoryAvailable ? '' : ' is-unavailable'}`} key={product.id}>
            <div><strong>{product.name}</strong><small>{product.code} · {categoryLabel(product.categoryCode)}</small>{!configurationReady
              ? requiresBundleChoice
                ? <small>自选套餐请使用“协助点单”完成具体选择，赠送入口暂不支持</small>
                : <small>库存或配方配置未完成，暂不能下单</small>
              : !inventoryAvailable ? <small>当前可售库存不足，补货入库后自动恢复</small> : null}</div>
            <b>{money(Number(product.standardPrice?.amountMinor ?? 0), product.standardPrice?.currency ?? 'CNY')}</b>
            {quantity > 0 && <label className="menu-item-note">此商品备注
              <input aria-label={`${product.name}商品备注`} maxLength={300} value={itemNotes[product.id] ?? ''}
                disabled={phase === 'submitting'} placeholder="仅用于这个商品"
                onChange={(event) => setItemNotes((current) => ({ ...current, [product.id]: event.target.value }))} />
            </label>}
            <div className="staff-order-quantity">
              {quantity > 0 && <button type="button" aria-label={`减少${product.name}`} onClick={() => changeQuantity(product.id, -1)}><Minus size={17} /></button>}
              {quantity > 0 && <span>{quantity}</span>}
              <button type="button" aria-label={`添加${product.name}`} disabled={!configurationReady || !inventoryAvailable} onClick={() => changeQuantity(product.id, 1)}><Plus size={17} /></button>
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

function StaffPaymentChoice({ action, amountMinor, currency, busy, queryBusy, status, waitingLong, canInitiatePayment, paymentInitiationMessage, canQuery, manualCollection, manualPaymentRecorded, tableCode, onCreateQr, onScan, onQuery, onRelease, onManual, onDone }: {
  action: OnlinePaymentAction | null
  amountMinor: number
  currency: string
  busy: boolean
  queryBusy: boolean
  status: 'pending' | 'succeeded' | 'failed' | 'closed'
  waitingLong: boolean
  canInitiatePayment: boolean
  paymentInitiationMessage: string | null
  canQuery: boolean
  manualCollection: AssistedOrderAccess['manualCollection']
  manualPaymentRecorded: boolean
  tableCode: string
  onCreateQr(): void
  onScan(): void
  onQuery(): void
  onRelease(): void
  onManual(input: Readonly<{
    provider: 'cash' | 'physical_pos' | 'external_manual'
    receiptReference: string
    terminalId?: string
    externalMethodCode?: 'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'
    collectionNote?: string
  }>): Promise<boolean>
  onDone(): void
}) {
  const qrValue = action?.presentation === 'qr' && typeof action.payload?.qrCodeUrl === 'string'
    ? action.payload.qrCodeUrl
    : null
  return <section className="staff-payment-choice" aria-label={`${tableCode}收款`}>
    <div className="staff-payment-summary"><small>{tableCode} · 订单已同步本桌</small><strong>{money(amountMinor, currency)}</strong><span>只有确认足额到账才停止再次收款；未知结果不会锁住桌台。</span></div>
    {action !== null && status === 'pending' && <button type="button" className="staff-payment-query is-attention" disabled={busy} onClick={onRelease}>保留旧单待核对，继续收款</button>}
    {status === 'succeeded' ? <>
      <span className="staff-payment-result is-succeeded"><Check /><strong>{manualPaymentRecorded ? '现场收款已登记' : '支付成功'}，已同步出品</strong></span>
      <p>收款状态已更新；后厨、吧台和打印会按本单商品与门店配置继续处理。</p>
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />完成</button>
    </> : status === 'failed' || status === 'closed' ? <>
      <span className="staff-payment-result"><X /><strong>本次付款未成功</strong></span>
      <p>请重新生成付款码或改由收银处理；不要把上一笔付款当作已到账。</p>
      <div className="staff-payment-methods">
        <button type="button" disabled={busy || !canInitiatePayment} title={paymentInitiationMessage ?? undefined} onClick={onCreateQr}><QrCode /><strong>重新生成付款码</strong><small>客人扫码付款</small></button>
        <button type="button" disabled={busy || !canInitiatePayment} title={paymentInitiationMessage ?? undefined} onClick={onScan}><ScanLine /><strong>扫描客人付款码</strong><small>摄像头或扫码枪</small></button>
      </div>
      <ManualCollectionChoice access={manualCollection} amountMinor={amountMinor} currency={currency} busy={busy} onSubmit={onManual} />
    </> : action?.payload?.presentation === 'simulation' ? <>
      <span className="staff-payment-result"><Check /><strong>测试付款动作已建立</strong></span>
      <p>当前仅验证订单同步和操作流程，没有产生真实收款。</p>
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />完成演练</button>
    </> : qrValue !== null ? <>
      <StaffPaymentQr value={qrValue} />
      <h3>请客人扫码付款</h3>
      <p>{waitingLong
        ? '仍在等待支付机构回传；可保留本次待核对并重新收款。'
        : '支付成功后页面会自动更新；客人也可以打开桌码中的“本桌已点”，从自己的手机继续这笔付款。'}</p>
      {canQuery && <button type="button" className="staff-payment-query" disabled={queryBusy} onClick={onQuery}><RefreshCcw size={18} />{queryBusy ? '正在查询，可继续其他操作' : '查询结果'}</button>}
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />暂时收起</button>
    </> : action?.presentation === 'barcode' ? <>
      <span className="staff-payment-result"><LoaderCircle className="is-spinning" /><strong>付款已受理，正在确认到账</strong></span>
      <p>{waitingLong
        ? '仍在等待支付机构回传；可保留旧单待核对并重新收款。'
        : '支付成功后自动同步；若需另收一笔，请先保留旧单待核对。'}</p>
      {canQuery && <button type="button" className="staff-payment-query" disabled={queryBusy} onClick={onQuery}><RefreshCcw size={18} />{queryBusy ? '正在查询，可继续其他操作' : '查询结果'}</button>}
      <button type="button" className="staff-payment-done" onClick={onDone}><Check size={18} />完成</button>
    </> : <>
      <div className="staff-payment-methods">
        <button type="button" disabled={busy || !canInitiatePayment} title={paymentInitiationMessage ?? undefined} onClick={onCreateQr}><QrCode /><strong>客人扫二维码</strong><small>平板显示付款码</small></button>
        <button type="button" disabled={busy || !canInitiatePayment} title={paymentInitiationMessage ?? undefined} onClick={onScan}><ScanLine /><strong>扫客人付款码</strong><small>摄像头或扫码枪</small></button>
      </div>
      <ManualCollectionChoice access={manualCollection} amountMinor={amountMinor} currency={currency} busy={busy} onSubmit={onManual} />
      <p>这笔订单已经出现在桌码“本桌已点”中，客人可直接用自己的手机付款。</p>
    </>}
    {paymentInitiationMessage !== null && <p className="staff-order-payment-note">{paymentInitiationMessage}</p>}
    {busy && <span className="staff-payment-busy"><LoaderCircle className="is-spinning" />正在安全发起，请勿重复操作</span>}
  </section>
}

function ManualCollectionChoice({ access, amountMinor, currency, busy, onSubmit }: {
  access: AssistedOrderAccess['manualCollection']
  amountMinor: number
  currency: string
  busy: boolean
  onSubmit(input: Readonly<{
    provider: 'cash' | 'physical_pos' | 'external_manual'
    receiptReference: string
    terminalId?: string
    externalMethodCode?: 'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'
    collectionNote?: string
  }>): Promise<boolean>
}) {
  const [provider, setProvider] = useState<'cash' | 'physical_pos' | 'external_manual' | null>(null)
  const [receiptReference, setReceiptReference] = useState('')
  const [terminalId, setTerminalId] = useState('')
  const [externalMethodCode, setExternalMethodCode] = useState<'bank_transfer' | 'mobile_wallet' | 'stored_value_voucher' | 'corporate_account' | 'other'>('bank_transfer')
  const [collectionNote, setCollectionNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  if (!access.canRecordCash && !access.canRecordPos && !access.canRecordExternal) return null

  const ready = provider !== null && receiptReference.trim().length >= 3
    && (provider !== 'physical_pos' || terminalId.trim().length >= 2)
    && (provider !== 'external_manual' || collectionNote.trim().length >= 2)
  const resetConfirmation = () => setConfirmed(false)
  const submit = async () => {
    if (provider === null || !ready || busy) return
    if (!confirmed) { setConfirmed(true); return }
    const completed = await onSubmit({
      provider,
      receiptReference,
      ...(provider === 'physical_pos' ? { terminalId } : {}),
      ...(provider === 'external_manual' ? { externalMethodCode, collectionNote } : {}),
    })
    if (completed) setProvider(null)
  }

  return <div className="staff-order-payment-note" aria-label="现场收款登记">
    <strong>已实际收到现场款项？</strong>
    <p>只在款项已到账后登记；员工、时间、凭证和方式会进入日结对账。</p>
    {provider === null ? <div className="staff-payment-methods">
      {access.canRecordCash && <button type="button" disabled={busy} onClick={() => setProvider('cash')}><Banknote /><strong>现金已收</strong><small>登记现金凭证</small></button>}
      {access.canRecordPos && <button type="button" disabled={busy} onClick={() => setProvider('physical_pos')}><CreditCard /><strong>实体POS已收</strong><small>登记终端与小票</small></button>}
      {access.canRecordExternal && <button type="button" disabled={busy} onClick={() => setProvider('external_manual')}><ReceiptText /><strong>其他方式已收</strong><small>登记外部凭证</small></button>}
    </div> : <div className="staff-order-settlement">
      {provider === 'external_manual' && <label>实际方式<select value={externalMethodCode} onChange={(event) => { setExternalMethodCode(event.target.value as typeof externalMethodCode); resetConfirmation() }}><option value="bank_transfer">银行转账</option><option value="mobile_wallet">其他扫码或数字钱包</option><option value="stored_value_voucher">储值卡或代金凭证</option><option value="corporate_account">公司账户结算</option><option value="other">其他经批准方式</option></select></label>}
      <label>{provider === 'cash' ? '现金凭证号' : provider === 'physical_pos' ? 'POS小票/交易号' : '外部交易号或凭证号'}<input value={receiptReference} maxLength={256} onChange={(event) => { setReceiptReference(event.target.value); resetConfirmation() }} /></label>
      {provider === 'physical_pos' && <label>POS终端编号<input value={terminalId} maxLength={128} onChange={(event) => { setTerminalId(event.target.value); resetConfirmation() }} /></label>}
      {provider === 'external_manual' && <label>收款说明<textarea value={collectionNote} maxLength={500} onChange={(event) => { setCollectionNote(event.target.value); resetConfirmation() }} /></label>}
      {confirmed && <p role="alert">请再次确认：已实际收到 {money(amountMinor, currency)}，凭证“{receiptReference.trim()}”真实可复核。确认后订单会结清并进入日结。</p>}
      <div className="staff-payment-methods">
        <button type="button" disabled={busy} onClick={() => { setProvider(null); setConfirmed(false) }}><X /><strong>返回</strong></button>
        <button type="button" disabled={busy || !ready} onClick={() => void submit()}><Check /><strong>{confirmed ? '确认已到账并登记' : '核对并继续'}</strong></button>
      </div>
    </div>}
  </div>
}

function canSettleImmediately(access: AssistedOrderAccess | null): boolean {
  return access !== null && (access.canInitiatePayment
    || access.manualCollection.canRecordCash
    || access.manualCollection.canRecordPos
    || access.manualCollection.canRecordExternal)
}

function paymentInitiationMessage(access: AssistedOrderAccess | null): string | null {
  if (access === null) return '正在确认本岗位和门店的收款条件。'
  if (access.canInitiatePayment) return null
  if (access.paymentInitiationBlockReason === 'permission_required') return '当前岗位未获“发起员工协助收款”授权；请由店长在权限管理中授权后重新登录。'
  if (access.paymentInitiationBlockReason === 'provider_not_configured') return '门店尚未配置可用的线上收款渠道，不能生成付款码或扫描客人付款码。'
  if (access.paymentInitiationBlockReason === 'online_payment_unavailable') return '门店线上收款当前未开启；请由有权限的负责人核对收款开关和渠道状态。'
  return '当前无法发起线上收款，请稍后刷新或联系收银负责人。'
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

function assistedProductToMenuProduct(
  product: AssistedOrderCatalogProduct,
  catalog: readonly AssistedOrderCatalogProduct[],
): MenuProduct {
  const snapshot = product.productSnapshot
  const recommendation = record(snapshot.recommendation)
  const amountMinor = Number(product.standardPrice?.amountMinor ?? 0)
  const costAmount = product.productKind === 'bundle'
    ? conservativeBundleCostAmount({
        bundleComponents: product.bundleComponents,
        bundleChoiceGroups: product.bundleChoiceGroups,
      }, catalog, amountMinor)
    : product.costAmountMinor ?? amountMinor
  // Recommendations use the worst valid bundle choice. Missing cost authority
  // is treated conservatively as zero contribution, never as zero cost.
  const availability = assistedProductAvailability(product)
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
    bundleChoiceGroups:(product.bundleChoiceGroups??[]).map((group)=>({
      id:group.id,code:group.code,name:group.name,selectionCount:group.selectionCount,
      options:group.options.map((option)=>({ productId:option.productId,name:option.name,
        quantity:option.quantity,available:option.available,
        unavailableReason:option.available?null:option.unavailableReason??'当前不可选' })),
    })),
    substitutionProductIds: [],
    recommendation: menuRecommendation(recommendation, product),
    categoryId: product.categoryCode,
    categoryName: product.categoryName || text(snapshot.categoryName) || categoryLabel(product.categoryCode),
    categoryParentId: product.categoryParentCode,
    categoryParentName: product.categoryParentName,
    description: text(snapshot.description) || undefined,
    imageUrl: text(snapshot.imageUrl) || undefined,
    tags: stringArray(snapshot.tags),
    sortOrder: product.menuSortOrder,
    soldOut: availability.soldOut,
    soldOutReason: assistedAvailabilityReason(product),
    availableFrom: product.availableFrom,
    availableUntil: product.availableUntil,
    guestVisible: product.guestVisible,
    requiresFulfillment: snapshot.requiresFulfillment !== false,
    maxOrderQuantity: product.maxOrderQuantity,
    listPriceAmount: amountMinor,
    costAmount,
    stationId: product.fulfillmentStation,
    enabled: availability.enabled,
    configVersion: integer(snapshot.configVersion, 1),
  }
}

function assistedAvailabilityReason(product: AssistedOrderCatalogProduct): string | undefined {
  if (!product.inventoryConfigurationComplete) return '库存或配方配置未完成'
  if (!product.inventoryAvailable) return '当前可售库存不足'
  if (!product.isAvailable) return '当前暂不可点'
  return undefined
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
