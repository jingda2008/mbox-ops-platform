import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, QrCode, RefreshCcw, ScanLine, X } from 'lucide-react'
import { CustomerPaymentCodeScanner } from '../../components/CustomerPaymentCodeScanner'
import type { OnlinePaymentAction } from '../../shared/online-payment-contracts'
import type {
  AssistedOrderAccess,
  StaffActionsApiPort,
  StaffTablePaymentOrder,
} from './staff-actions-api'

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
  const [access, setAccess] = useState<AssistedOrderAccess | null>(null)
  const [orders, setOrders] = useState<StaffTablePaymentOrder[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [action, setAction] = useState<OnlinePaymentAction | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'succeeded' | 'failed' | 'closed'>('pending')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const announcedPaymentId = useRef<string | null>(null)

  const selected = orders.find((order) => order.id === selectedOrderId) ?? null

  const refresh = async (signal?: AbortSignal) => {
    if (api.loadTablePaymentOrders === undefined) {
      throw new Error('本桌收款入口暂时不可用，请到收银页面处理')
    }
    const [nextAccess, nextOrders] = await Promise.all([
      api.loadAssistedOrderAccess(signal),
      api.loadTablePaymentOrders(table.activeSession.id, signal),
    ])
    setAccess(nextAccess)
    setOrders(nextOrders)
    setSelectedOrderId((current) => (
      current !== null && nextOrders.some((order) => order.id === current)
        ? current
        : nextOrders[0]?.id ?? null
    ))
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '本桌未结订单暂时无法读取')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
    // The sheet is intentionally remounted for every table entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, table.activeSession.id])

  useEffect(() => {
    if (action === null || paymentStatus !== 'pending') return
    const controller = new AbortController()
    let active = true
    const synchronize = async () => {
      try {
        const status = await api.loadOnlinePaymentStatus(action.paymentId, controller.signal)
        if (!active || status === 'pending') return
        setPaymentStatus(status)
        if (status === 'succeeded' && announcedPaymentId.current !== action.paymentId) {
          announcedPaymentId.current = action.paymentId
          onUpdated(`${table.code} 已确认到账；如需继续核对，请在收银页查看本单与小票。`)
          await refresh(controller.signal)
        }
        if (status === 'failed' || status === 'closed') setError('支付渠道已确认本次未成功，可以重新发起收款。')
      } catch {
        // A temporary status-read failure must never turn an unknown payment into a failure.
      }
    }
    void synchronize()
    const interval = window.setInterval(() => { void synchronize() }, 2_000)
    return () => {
      active = false
      controller.abort()
      window.clearInterval(interval)
    }
  }, [action, api, onUpdated, paymentStatus, table.code])

  const createPayment = async (method: 'native_qr' | 'auth_code', customerAuthCode?: string) => {
    if (selected === null || busy) return false
    if (access?.canInitiatePayment !== true || access.onlinePaymentProvider === null || access.onlinePaymentProvider === undefined) {
      setError(paymentEntryMessage(access))
      return false
    }
    setBusy(true)
    setError(null)
    try {
      const nextAction = await api.createOnlinePayment({
        orderId: selected.id,
        provider: access.onlinePaymentProvider,
        method,
        ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
      })
      setAction(nextAction)
      setPaymentStatus(nextAction.status === 'failed' ? 'failed' : 'pending')
      setScannerOpen(false)
      onUpdated(method === 'native_qr'
        ? `${table.code} 已调出本单付款二维码；到账前请不要再次收款。`
        : `${table.code} 已受理顾客付款码；请等待支付结果。`)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法发起本次收款，请到收银页面核对')
      return false
    } finally {
      setBusy(false)
    }
  }

  const queryPayment = async () => {
    if (action === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await api.queryOnlinePayment(action.paymentId)
      setPaymentStatus(status)
      if (status === 'succeeded') {
        onUpdated(`${table.code} 已确认到账。`)
        await refresh()
      } else if (status === 'failed' || status === 'closed') {
        setError('支付渠道已确认本次未成功，可以重新发起收款。')
      } else {
        onUpdated(`${table.code} 支付渠道仍在处理中，请勿重复收款。`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法核对支付状态，请由收银处理')
    } finally {
      setBusy(false)
    }
  }

  const qrValue = action?.presentation === 'qr' && typeof action.payload?.qrCodeUrl === 'string'
    ? action.payload.qrCodeUrl
    : null

  return <div className="staff-order-overlay" role="dialog" aria-modal="true" aria-label={`${table.code}本桌收款`}>
    <section className="staff-order-sheet staff-table-payment-sheet">
      <header>
        <div><small>{table.code} · 仅本桌未结订单</small><h2><QrCode size={21} /> 本桌收款</h2></div>
        <button type="button" aria-label="关闭本桌收款" onClick={onClose}><X size={21} /></button>
      </header>
      <p className="staff-order-payment-note">普通未结订单可直接收款；退款后的订单须由收银先授权才会出现。每次只处理一笔；渠道处理中请查单，不要重复扣款。</p>
      {error !== null && <p className="staff-order-error" role="alert">{error}</p>}
      {loading ? <p className="staff-order-loading"><LoaderCircle className="is-spinning" /> 正在读取本桌未结订单</p> : orders.length === 0 ? <p className="staff-actions-empty">本桌没有需要再次收款的订单。</p> : <>
        <div className="staff-payment-order-list" aria-label="本桌未结订单">
          {orders.map((order) => <button type="button" key={order.id}
            className={order.id === selectedOrderId ? 'is-active' : ''}
            onClick={() => { setSelectedOrderId(order.id); setAction(null); setError(null) }}>
            <span><strong>{order.publicId}</strong><small>{order.hasOnlinePaymentInProgress ? '支付渠道处理中，点击可查单' : order.paymentStatus === 'partially_refunded' ? '退款后待补收' : '待收款'}</small></span>
            <b>{money(order.outstandingAmountMinor, order.currency)}</b>
          </button>)}
        </div>
        {selected !== null && <section className="staff-payment-choice" aria-label="再次发起本桌收款">
          <div className="staff-payment-summary"><small>{selected.publicId}</small><strong>{money(selected.outstandingAmountMinor, selected.currency)}</strong><span>{selected.hasOnlinePaymentInProgress ? '已有渠道动作时将安全复用或返回处理中，不会生成第二笔扣款。' : '选择顾客扫码，或扫描顾客付款码。'}</span></div>
          {paymentStatus === 'succeeded' ? <span className="staff-payment-result is-succeeded"><Check /><strong>支付成功，订单余额已刷新</strong></span> : paymentStatus === 'failed' || paymentStatus === 'closed' ? <>
            <span className="staff-payment-result"><X /><strong>本次付款未成功</strong></span>
            <PaymentButtons busy={busy} disabled={access?.canInitiatePayment !== true} onQr={() => void createPayment('native_qr')} onScan={() => setScannerOpen(true)} />
          </> : qrValue !== null ? <>
            <TablePaymentQr value={qrValue} />
            <h3>请顾客扫码付款</h3><p>到账前不要重复收款；支付结果会自动刷新。</p>
            {access?.canQueryOnlinePayment === true && <button type="button" className="staff-payment-query" disabled={busy} onClick={() => void queryPayment()}><RefreshCcw size={18} />查询渠道结果</button>}
          </> : action?.presentation === 'barcode' ? <>
            <span className="staff-payment-result"><LoaderCircle className="is-spinning" /><strong>付款码已提交，正在确认到账</strong></span>
            {access?.canQueryOnlinePayment === true && <button type="button" className="staff-payment-query" disabled={busy} onClick={() => void queryPayment()}><RefreshCcw size={18} />查询渠道结果</button>}
          </> : <PaymentButtons busy={busy} disabled={access?.canInitiatePayment !== true} onQr={() => void createPayment('native_qr')} onScan={() => setScannerOpen(true)} />}
          {paymentEntryMessage(access) !== null && <p className="staff-order-payment-note">{paymentEntryMessage(access)}</p>}
          {busy && <span className="staff-payment-busy"><LoaderCircle className="is-spinning" />正在安全发起，请勿重复操作</span>}
        </section>}
      </>}
      {scannerOpen && selected !== null && <CustomerPaymentCodeScanner tableCode={table.code}
        amountLabel={money(selected.outstandingAmountMinor, selected.currency)}
        onClose={() => setScannerOpen(false)} onConfirm={(code) => createPayment('auth_code', code)} />}
    </section>
  </div>
}

function PaymentButtons({ busy, disabled, onQr, onScan }: {
  busy: boolean; disabled: boolean; onQr(): void; onScan(): void
}) {
  return <div className="staff-payment-methods">
    <button type="button" disabled={busy || disabled} onClick={onQr}><QrCode /><strong>调出付款二维码</strong><small>顾客扫码付款</small></button>
    <button type="button" disabled={busy || disabled} onClick={onScan}><ScanLine /><strong>扫描顾客付款码</strong><small>摄像头或扫码枪</small></button>
  </div>
}

function TablePaymentQr({ value }: { value: string }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
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
