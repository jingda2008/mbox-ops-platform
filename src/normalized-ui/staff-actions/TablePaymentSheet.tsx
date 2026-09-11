import { useCallback, useEffect, useRef, useState } from 'react'
import { Banknote, Check, LoaderCircle, QrCode, RefreshCcw, ScanLine, X } from 'lucide-react'
import { CustomerPaymentCodeScanner } from '../../components/CustomerPaymentCodeScanner'
import type { OnlinePaymentAction } from '../../shared/online-payment-contracts'
import { useConfirmationDialog } from '../ConfirmationDialog'
import type {
  AssistedOrderAccess,
  StaffActionsApiPort,
  StaffTablePaymentOrder,
} from './staff-actions-api'
import { createCashReceiptReference, shortPaymentOrderLabel } from './table-payment-model'

export interface TablePaymentSheetProps {
  api: StaffActionsApiPort
  table: Readonly<{ code: string; activeSession: { id: string } }>
  onClose(): void
  onUpdated(message: string): void
}

/**
 * A waiter-only payment entry point for an already-created order.  It never
 * creates a new order and only receives order candidates from a server-side
 * current-table scope check.  This keeps the common “再出二维码/再扫付款码”
 * operation on the table page without turning the page into a cashier ledger.
 */
export function TablePaymentSheet({ api, table, onClose, onUpdated }: TablePaymentSheetProps) {
  const { confirmAction } = useConfirmationDialog()
  const [access, setAccess] = useState<AssistedOrderAccess | null>(null)
  const [orders, setOrders] = useState<StaffTablePaymentOrder[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [selectedIds,setSelectedIds]=useState<string[]>([])
  const [collectionAmount,setCollectionAmount]=useState('')
  const [action, setAction] = useState<OnlinePaymentAction | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'succeeded' | 'failed' | 'closed'>('pending')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const announcedPaymentId = useRef<string | null>(null)
  const generation = useRef(0)
  const [interactionEpoch, setInteractionEpoch] = useState(0)
  const advanceGeneration = () => { generation.current += 1; setInteractionEpoch(generation.current); return generation.current }
  const writing = useRef(false)
  const cashAttempt = useRef<{signature:string;receipt:string} | null>(null)
  const actionOrderId = useRef<string | null>(null)
  useEffect(() => () => { generation.current += 1 }, [])

  const selected = orders.find((order) => order.id === selectedOrderId) ?? null
  const selectedOrders=orders.filter(order=>selectedIds.includes(order.id))
  const selectedTotal=selectedOrders.reduce((sum,order)=>sum+order.outstandingAmountMinor,0)
  const enteredMinor=collectionAmount.trim()===''?selectedTotal:Math.round(Number(collectionAmount)*100)
  const amountValid=/^\d+(?:\.\d{1,2})?$/.test(collectionAmount)||collectionAmount.trim()===''
  const canCollect=amountValid&&Number.isSafeInteger(enteredMinor)&&enteredMinor>0&&enteredMinor<=selectedTotal
  const ownedAction = actionOrderId.current === selectedOrderId ? action : null
  const activePaymentId = ownedAction?.paymentId ?? selected?.unresolvedOnlinePaymentId ?? null

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestGeneration = generation.current
    if (api.loadTablePaymentOrders === undefined) {
      throw new Error('本桌收款入口暂时不可用，请到收银页面处理')
    }
    const [nextAccess, nextOrders] = await Promise.all([
      api.loadAssistedOrderAccess(signal),
      api.loadTablePaymentOrders(table.activeSession.id, signal),
    ])
    if (signal?.aborted || requestGeneration !== generation.current) return
    setAccess(nextAccess)
    setOrders(nextOrders)
    setSelectedIds(current=>current.length?current.filter(id=>nextOrders.some(order=>order.id===id)):nextOrders.map(order=>order.id))
    setCollectionAmount('')
    setSelectedOrderId((current) => (
      current !== null && nextOrders.some((order) => order.id === current)
        ? current
        : nextOrders[0]?.id ?? null
    ))
  }, [api, table.activeSession.id])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void refresh(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '本桌未结订单暂时无法读取')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [loadAttempt, refresh])

  useEffect(() => {
    if (activePaymentId === null || paymentStatus !== 'pending') return
    const controller = new AbortController()
    let active = true
    const requestGeneration = generation.current
    const synchronize = async () => {
      try {
        const status = await api.loadOnlinePaymentStatus(activePaymentId, controller.signal)
        if (!active || requestGeneration !== generation.current || status === 'pending') return
        setPaymentStatus(status)
        if (status === 'succeeded' && announcedPaymentId.current !== activePaymentId) {
          announcedPaymentId.current = activePaymentId
          onUpdated(`${table.code} 已确认到账；如需继续核对，请在收银页查看本单与小票。`)
          await refresh(controller.signal)
          if (!active || requestGeneration !== generation.current) return
          setAction(null)
          setPaymentStatus('pending')
        }
        if (status === 'failed' || status === 'closed') setError('支付渠道已确认本次未成功，可以重新发起收款。')
      } catch {
        // A temporary status-read failure must never turn an unknown payment into a failure.
      }
    }
    void synchronize()
    const interval = window.setInterval(() => { void synchronize() }, 10_000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [activePaymentId, api, onUpdated, paymentStatus, refresh, table.code, interactionEpoch])

  const createPayment = async (method: 'native_qr' | 'auth_code', customerAuthCode?: string) => {
    if (selected === null || !canCollect || writing.current) return false
    if (access?.canInitiatePayment !== true || access.onlinePaymentProvider === null || access.onlinePaymentProvider === undefined) {
      setError(paymentEntryMessage(access))
      return false
    }
    writing.current = true
    const requestGeneration = advanceGeneration()
    setQuerying(false)
    setBusy(true)
    setError(null)
    try {
      const nextAction = await api.createOnlinePayment({
        orderId: selectedOrders[0]!.id,
        orderIds:selectedOrders.map(order=>order.id),amountMinor:enteredMinor,
        provider: access.onlinePaymentProvider,
        method,
        ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
      })
      if (requestGeneration !== generation.current) return false
      actionOrderId.current = selected.id
      setAction(nextAction)
      setPaymentStatus(nextAction.status === 'failed' ? 'failed' : 'pending')
      setScannerOpen(false)
      onUpdated(method === 'native_qr'
        ? `${table.code} 已调出本单付款二维码；只有确认足额到账后才停止收款。`
        : `${table.code} 已受理顾客付款码；只有确认足额到账后才停止收款。`)
      return true
    } catch (reason) {
      if (requestGeneration !== generation.current) return false
      setError(reason instanceof Error ? reason.message : '无法发起本次收款，请到收银页面核对')
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const queryPayment = async () => {
    if (activePaymentId === null || querying) return
    const requestGeneration = generation.current
    setQuerying(true)
    setError(null)
    try {
      const status = await api.queryOnlinePayment(activePaymentId)
      if (requestGeneration !== generation.current) return
      setPaymentStatus(status)
      if (status === 'succeeded') {
        onUpdated(`${table.code} 已确认到账。`)
        await refresh()
        if (requestGeneration !== generation.current) return
        setAction(null)
        setPaymentStatus('pending')
      } else if (status === 'failed' || status === 'closed') {
        setError('支付渠道已确认本次未成功，可以重新发起收款。')
      } else {
        onUpdated(`${table.code} 支付渠道仍在处理中；可继续等待，也可明确保留旧单待核对并重新收款。`)
      }
    } catch (reason) {
      if (requestGeneration !== generation.current) return
      setError(reason instanceof Error ? reason.message : '暂时无法核对支付状态，请由收银处理')
    } finally {
      if (requestGeneration === generation.current) setQuerying(false)
    }
  }

  const recordCashPayment = async () => {
    if (selected === null || !canCollect || access?.manualCollection.canRecordCash !== true || writing.current) return
    const requestGeneration = generation.current
    const confirmed = await confirmAction({
      title: `确认 ${table.code} 已收到现金`,
      description: `请确认已经实际收到 ${money(enteredMinor, selected.currency)} 现金。确认后会立即计入收款、日结和小票，不可把“准备收钱”提前登记成到账。`,
      confirmLabel: '确认已收到现金',
      cancelLabel: '暂未收到',
    })
    if (!confirmed || requestGeneration !== generation.current || writing.current) return
    writing.current = true
    setBusy(true)
    setError(null)
    try {
      const signature=JSON.stringify([table.activeSession.id,selectedOrders.map(order=>order.id).sort(),enteredMinor])
      if(cashAttempt.current?.signature!==signature)cashAttempt.current={signature,receipt:createCashReceiptReference(table.code)}
      await api.recordManualPayment({
        orderId: selectedOrders[0]!.id,
        orderIds:selectedOrders.map(order=>order.id),amountMinor:enteredMinor,
        provider: 'cash',
        receiptReference: cashAttempt.current.receipt,
        idempotencyKey: `staff-cash-${cashAttempt.current.receipt}`,
      })
      if (requestGeneration !== generation.current) return
      cashAttempt.current=null
      onUpdated(`${table.code} 现金收款已登记并进入日结对账。`)
      onClose()
    } catch (reason) {
      if (requestGeneration !== generation.current) return
      setError(reason instanceof Error ? reason.message : '现金收款未完成，请核对后重试')
    } finally {
      writing.current = false
      setBusy(false)
    }
  }


  const qrValue = ownedAction?.presentation === 'qr' && typeof ownedAction.payload?.qrCodeUrl === 'string'
    ? ownedAction.payload.qrCodeUrl
    : null

  return <div className="staff-order-overlay" role="dialog" aria-modal="true" aria-label={`${table.code}本桌收款`}>
    <section className="staff-order-sheet staff-table-payment-sheet">
      <header>
        <div><small>{table.code} · 仅本桌未结订单</small><h2><QrCode size={21} /> 本桌收款</h2></div>
        <button type="button" aria-label="关闭本桌收款" onClick={onClose}><X size={21} /></button>
      </header>
      <p className="staff-order-payment-note">默认合并本桌未结订单，可取消勾选或填写本次部分收款金额。原支付未知不阻塞再次收款；退款后的重新收款仍需收银授权。</p>
      {error !== null && <p className="staff-order-error" role="alert">{error}</p>}
      {!loading && error !== null && orders.length === 0 && <button type="button" className="staff-payment-reload" onClick={() => setLoadAttempt((current) => current + 1)}><RefreshCcw size={18} />重新读取本桌收款</button>}
      {loading ? <p className="staff-order-loading"><LoaderCircle className="is-spinning" /> 正在读取本桌未结订单</p> : orders.length === 0 ? error === null && <p className="staff-actions-empty">本桌没有需要再次收款的订单。</p> : <>
        <div className="staff-payment-order-list" aria-label="本桌未结订单">
          {orders.map((order) => <button type="button" key={order.id}
            disabled={busy}
            aria-pressed={selectedIds.includes(order.id)} className={selectedIds.includes(order.id) ? 'is-active' : ''}
            onClick={() => { if (writing.current) return; advanceGeneration(); setQuerying(false); setScannerOpen(false); setSelectedIds(current=>current.includes(order.id)?current.filter(id=>id!==order.id):[...current,order.id]); setSelectedOrderId(order.id); setCollectionAmount(''); setAction(null); setPaymentStatus('pending'); setError(null) }}>
            <span><strong title={order.publicId}>{selectedIds.includes(order.id)?'☑ ':'☐ '}{shortPaymentOrderLabel(order.publicId)}</strong><small>{order.hasOnlinePaymentInProgress ? '待收款 · 原支付未确认' : order.paymentStatus === 'partially_refunded' ? '退款后待补收' : '待收款'}</small></span>
            <b>{money(order.outstandingAmountMinor, order.currency)}</b>
          </button>)}
        </div>
        {selected !== null && <section className="staff-payment-choice" aria-label="再次发起本桌收款">
          <div className="staff-payment-summary"><small>已选 {selectedOrders.length} 单 · 待收 {money(selectedTotal,selected.currency)}</small><strong>{money(enteredMinor, selected.currency)}</strong><span>{selected.hasOnlinePaymentInProgress ? '原支付结果尚未确认，可直接选择收款方式。' : '选择顾客扫码、扫描付款码，或确认现金已收。'}</span></div>
          <label>本次收款金额（元）<input inputMode="decimal" value={collectionAmount} placeholder={(selectedTotal/100).toFixed(2)} disabled={busy} onChange={event=>{setCollectionAmount(event.target.value);setAction(null)}} /></label>
          {!canCollect&&<p role="alert">请选择订单，金额须大于0且不超过所选待收金额，最多两位小数。</p>}
          <details><summary>查看本次分摊顺序</summary><p>按下单时间从早到晚分摊，先付清较早订单，剩余用于下一单；原订单及退款归属分别保留。</p></details>
          {paymentStatus === 'succeeded' && <span className="staff-payment-result is-succeeded"><Check /><strong>支付成功，订单余额已刷新</strong></span>}
          {paymentStatus !== 'succeeded' && <PaymentButtons busy={busy||!canCollect} onlineDisabled={access?.canInitiatePayment !== true} canRecordCash={access?.manualCollection.canRecordCash === true} onQr={() => void createPayment('native_qr')} onScan={() => setScannerOpen(true)} onCash={() => void recordCashPayment()} />}
          {qrValue !== null && <TablePaymentQr key={activePaymentId} value={qrValue} />}
          {activePaymentId !== null && <details className="staff-payment-history"><summary>原支付记录</summary>
            <p>{paymentStatus === 'pending' ? '本次结果尚未确认，可继续收款；后台会继续核对实际到账。' : paymentStatus === 'succeeded' ? '本次已确认到账' : '渠道已确认本次未成功，可再次收款。'}</p>
            {access?.canQueryOnlinePayment === true && <button type="button" className="staff-payment-query" disabled={querying} onClick={() => void queryPayment()}><RefreshCcw size={18} />{querying ? '正在读取' : '查看原支付结果'}</button>}
          </details>}
          {paymentEntryMessage(access) !== null && <p className="staff-order-payment-note">{paymentEntryMessage(access)}</p>}
          {busy && <span className="staff-payment-busy"><LoaderCircle className="is-spinning" />正在安全发起，请勿重复操作</span>}
        </section>}
      </>}
      {scannerOpen && selected !== null && <CustomerPaymentCodeScanner tableCode={table.code}
        amountLabel={money(enteredMinor, selected.currency)}
        onClose={() => setScannerOpen(false)} onConfirm={(code) => createPayment('auth_code', code)} />}
    </section>
  </div>
}

function PaymentButtons({ busy, onlineDisabled, canRecordCash, onQr, onScan, onCash }: {
  busy: boolean
  onlineDisabled: boolean
  canRecordCash: boolean
  onQr(): void
  onScan(): void
  onCash(): void
}) {
  return <div className="staff-payment-methods">
    <button type="button" disabled={busy || onlineDisabled} onClick={onQr}><QrCode /><strong>调出付款二维码</strong><small>顾客扫码付款</small></button>
    <button type="button" disabled={busy || onlineDisabled} onClick={onScan}><ScanLine /><strong>扫描顾客付款码</strong><small>摄像头或扫码枪</small></button>
    {canRecordCash && <button type="button" disabled={busy} onClick={onCash}><Banknote /><strong>现金已收</strong><small>确认后直接登记</small></button>}
  </div>
}

function TablePaymentQr({ value }: { value: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setImage(null)
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(value, {
      width: 260, margin: 1, errorCorrectionLevel: 'M',
    })).then((next) => { if (active) setImage(next) })
    return () => { active = false }
  }, [value])
  return image === null ? <LoaderCircle className="is-spinning" /> : <img className="staff-payment-qr" src={image} alt="本桌顾客扫码付款二维码" />
}

function paymentEntryMessage(access: AssistedOrderAccess | null): string | null {
  if (access === null) return '正在确认本岗位和门店的收款条件。'
  if (access.canInitiatePayment) return null
  if (access.paymentInitiationBlockReason === 'permission_required') return '当前岗位未获本桌线上收款授权。'
  if (access.paymentInitiationBlockReason === 'provider_not_configured') return '门店尚未配置可用的线上收款渠道。'
  if (access.paymentInitiationBlockReason === 'online_payment_unavailable') return '门店线上收款当前未开启。'
  return '当前无法发起线上收款，请由收银处理。'
}

function money(amountMinor: number, currency = 'CNY'): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}
