import { CheckCircle2, ChevronRight, Clock3, CreditCard, ListChecks, MessageCircleMore, Send, ShieldCheck, ShoppingBag } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { checkoutGuestOrder, createGuestOrder, createGuestTask, getGuestSession, submitGuestTaskFeedback } from '../api'
import type { GuestSessionResponse, GuestTaskView, WechatJsapiParameters } from '../shared/guest-contracts'
import { guestFeedbackIdempotencyKey } from './guest-portal-utils'
import { ServiceIcon } from './ServiceIcon'
import { MenuOrderingWorkspace, type MenuCartItem } from './MenuOrderingWorkspace'

const guestStatus: Record<GuestTaskView['status'], string> = {
  pending: '等待接单',
  accepted: '服务人员已接单',
  arrived: '服务人员已到桌',
  completed: '请确认是否解决',
  confirmed: '已解决',
  reopened: '已升级继续处理',
  escalated: '已升级处理',
  cancelled: '已取消',
}

export function GuestPortal() {
  const params = new URLSearchParams(window.location.search)
  const tableCode = params.get('table') ?? 'L01'
  const initialToken = params.get('token') ?? ''
  const requestedPaymentOrderId = params.get('payOrder') ?? ''
  const [data, setData] = useState<GuestSessionResponse | null>(null)
  const [note, setNote] = useState('')
  const [reply, setReply] = useState('')
  const [pendingType, setPendingType] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'menu' | 'service' | 'orders'>(requestedPaymentOrderId ? 'orders' : 'menu')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [payingOrderId, setPayingOrderId] = useState('')

  const refresh = useCallback(async () => {
    try {
      setData(await getGuestSession(initialToken, tableCode))
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '服务暂时不可用')
    }
  }, [initialToken, tableCode])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const tableTasks = useMemo(() => data?.tasks.slice(0, 5) ?? [], [data?.tasks])
  const customRequestType = data?.serviceTypes.find((serviceType) => serviceType.code === 'CUSTOM_REQUEST')
  const quickServiceTypes = data?.serviceTypes.filter((serviceType) => serviceType.code !== 'CUSTOM_REQUEST') ?? []

  async function requestService(serviceTypeId: string, requestNote = '') {
    setPendingType(serviceTypeId)
    setError('')
    try {
      const task = await createGuestTask({
        tableToken: data?.tableToken ?? initialToken,
        serviceTypeId,
        note: requestNote,
        idempotencyKey: `guest-${tableCode}-${serviceTypeId}-${crypto.randomUUID()}`,
      })
      setReply(task.customerReply)
      setNote('')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '请求未提交')
    } finally {
      setPendingType(null)
    }
  }

  async function submitCustomRequest() {
    if (!customRequestType) {
      setError('个性化需求服务暂未启用，请直接呼叫服务员')
      return
    }
    if (!note.trim()) {
      setError('请先填写您的个性化需求')
      return
    }
    await requestService(customRequestType.id, note.trim())
  }

  async function giveFeedback(task: GuestTaskView, action: 'confirm' | 'unresolved') {
    try {
      await submitGuestTaskFeedback(task.id, {
        tableToken: data?.tableToken ?? initialToken,
        action,
        note: action === 'unresolved' ? '客户反馈仍未解决' : '',
        idempotencyKey: guestFeedbackIdempotencyKey(action),
      })
      setReply(action === 'confirm' ? '感谢确认，本次服务已完成。' : '已为您升级处理，值班领班会继续跟进。')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '反馈未提交')
    }
  }

  async function payOrder(orderId: string, idempotencyKey = `guest-pay-${crypto.randomUUID()}`) {
    if (!data || payingOrderId) return
    setPayingOrderId(orderId)
    setError('')
    try {
      const result = await checkoutGuestOrder({
        tableToken: data.tableToken,
        orderId,
        idempotencyKey,
      })
      if (result.providerRequired) {
        const outcome = await invokeWechatJsapi(result.wechatJsapiParameters)
        setReply(outcome === 'succeeded'
          ? '微信支付已提交，正在等待到账确认。'
          : outcome === 'cancelled'
            ? '支付尚未完成，可以重新点击微信支付。'
            : '订单已保留，微信商户支付参数尚未返回，请稍后继续支付或联系服务员。')
      } else {
        const fulfillmentMessage = result.order.createdBy.startsWith('guest-')
          ? '订单已发送至出品岗位。'
          : '服务员、收银与出品岗位已同步。'
        setReply(`支付成功 ¥${(result.paymentIntent.amount / 100).toFixed(2)}，${fulfillmentMessage}`)
      }
      setActiveTab('orders')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '支付未完成')
      throw requestError
    } finally {
      setPayingOrderId('')
    }
  }

  async function placeAndPay(items: MenuCartItem[]) {
    if (!data) return
    setCheckoutBusy(true)
    setError('')
    const idempotencyKey = `guest-cart-${crypto.randomUUID()}`
    try {
      const order = await createGuestOrder({ tableToken: data.tableToken, items, idempotencyKey })
      try {
        await payOrder(order.id, `${idempotencyKey}-pay`)
      } catch {
        setActiveTab('orders')
        await refresh()
      }
    } finally {
      setCheckoutBusy(false)
    }
  }

  return (
    <main className="guest-shell">
      <header className="guest-header">
        <div className="guest-brand"><span>M</span><strong>M-Box</strong></div>
        <span className="secure-label"><ShieldCheck size={16} />桌台会话</span>
      </header>

      <section className="guest-table-band">
        <span>当前桌台</span>
        <div>
          <h1>{data?.table.displayName ?? tableCode}</h1>
          <p>服务专员 · {data?.primaryServiceName ?? '正在安排'}</p>
        </div>
      </section>

      {reply && (
        <div className="guest-reply" role="status">
          <CheckCircle2 size={24} />
          <span>{reply}</span>
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}

      <nav className="guest-tabs" aria-label="桌台功能">
        <button className={activeTab === 'menu' ? 'is-active' : ''} onClick={() => setActiveTab('menu')}><ShoppingBag size={18} />点单</button>
        <button className={activeTab === 'service' ? 'is-active' : ''} onClick={() => setActiveTab('service')}><MessageCircleMore size={18} />服务</button>
        <button className={activeTab === 'orders' ? 'is-active' : ''} onClick={() => setActiveTab('orders')}><ListChecks size={18} />订单</button>
      </nav>

      {activeTab === 'menu' && <MenuOrderingWorkspace
        products={data?.products ?? []}
        tableLabel={data?.table.displayName ?? tableCode}
        submitLabel="确认订单并微信支付"
        submitHint="验证环境会模拟微信付款；付款成功后服务员、收银和出品岗位会同时收到状态。"
        busy={checkoutBusy}
        timeZone={data?.store.timezone}
        onSubmit={placeAndPay}
      />}

      {activeTab === 'service' && <><section className="guest-services">
        <div className="guest-section-title">
          <span>呼叫服务</span>
          <MessageCircleMore size={20} aria-hidden="true" />
        </div>
        <div className="service-grid">
          {quickServiceTypes.map((serviceType) => (
            <button
              key={serviceType.id}
              className={serviceType.id === 'complaint' ? 'service-button service-button--complaint' : 'service-button'}
              disabled={pendingType !== null}
              onClick={() => void requestService(serviceType.id)}
            >
              <ServiceIcon icon={serviceType.icon} size={23} />
              <span>{pendingType === serviceType.id ? '正在提交' : serviceType.name}</span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="guest-note">
          <span>个性化需求</span>
          <div className="guest-note-row">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && note.trim() && pendingType === null) void submitCustomRequest()
              }}
              maxLength={300}
              placeholder="例如：需要两杯温水"
            />
            <button disabled={!note.trim() || pendingType !== null || !customRequestType} onClick={() => void submitCustomRequest()}><Send size={17} />{pendingType === customRequestType?.id ? '提交中' : '提交'}</button>
          </div>
        </div>
      </section>

      <section className="guest-progress">
        <div className="guest-section-title"><span>服务进度</span><Clock3 size={20} /></div>
        {tableTasks.length === 0 ? (
          <div className="guest-empty">暂无进行中的服务</div>
        ) : (
          <div className="guest-task-list">
            {tableTasks.map((task) => {
              const serviceType = data?.serviceTypes.find((item) => item.id === task.serviceTypeId)
              return (
                <article className="guest-task" key={task.id}>
                  <div>
                    <strong>{task.serviceTypeName || serviceType?.name || '服务进度'}</strong>
                    <span>{guestStatus[task.status]} · {task.ownerName ?? '领班调度池'}</span>
                  </div>
                  {task.status === 'completed' && (
                    <div className="guest-feedback">
                      <button onClick={() => void giveFeedback(task, 'confirm')}>已解决</button>
                      <button className="text-danger" onClick={() => void giveFeedback(task, 'unresolved')}>仍未解决</button>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section></>}

      {activeTab === 'orders' && <section className="guest-orders">
        <div className="guest-section-title"><span>订单与出品进度</span><ListChecks size={20} /></div>
        {requestedPaymentOrderId && <div className="guest-payment-sync"><CreditCard size={18} /><span>服务员协助点单已同步，请核对商品和金额后支付。</span></div>}
        {(data?.account.orders.length ?? 0) === 0 ? <div className="guest-empty">本桌当前还没有订单</div> : (
          <div className="guest-order-list">{data?.account.orders.toReversed().map((order) => {
            const payment = data.account.payments.find((item) => item.orderIds.includes(order.id))
            const paid = payment?.status === 'succeeded'
            return <article className={`guest-order ${order.id === requestedPaymentOrderId ? 'is-payment-target' : ''}`} key={order.id}>
              <header><div><strong>¥{(order.payableAmount / 100).toFixed(2)}</strong><span>{new Date(order.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div><b className={payment?.status === 'succeeded' ? 'is-paid' : ''}>{payment?.status === 'succeeded' ? '已支付' : order.status === 'draft' ? '待支付' : '已下单'}</b></header>
              <div>{order.items.map((item) => <div className="guest-order-line" key={item.id}><span>{item.name} × {item.quantity}</span><strong>{fulfillmentLabel(item.fulfillmentStatus)}</strong></div>)}</div>
              {!paid && order.payableAmount > 0 && <button className="guest-pay-button" disabled={Boolean(payingOrderId)} onClick={() => void payOrder(order.id)}><CreditCard size={18} />{payingOrderId === order.id ? '正在拉起微信支付' : `微信支付 ¥${(order.payableAmount / 100).toFixed(2)}`}</button>}
              {!paid && order.payableAmount <= 0 && <div className="guest-no-payment"><CheckCircle2 size={16} />无需在线支付，请由服务员核对赠送或折扣</div>}
            </article>
          })}</div>
        )}
      </section>}
    </main>
  )
}

async function invokeWechatJsapi(parameters: WechatJsapiParameters | null) {
  if (!parameters) return 'unavailable' as const
  const bridge = await waitForWechatBridge()
  if (!bridge) return 'unavailable' as const
  return new Promise<'succeeded' | 'cancelled'>((resolve) => {
    bridge.invoke('getBrandWCPayRequest', parameters, (result) => {
      resolve(result.err_msg === 'get_brand_wcpay_request:ok' ? 'succeeded' : 'cancelled')
    })
  })
}

interface WechatBridge {
  invoke: (method: string, parameters: WechatJsapiParameters, callback: (result: { err_msg: string }) => void) => void
}

function waitForWechatBridge() {
  const current = (window as typeof window & { WeixinJSBridge?: WechatBridge }).WeixinJSBridge
  if (current) return Promise.resolve(current)
  return new Promise<WechatBridge | null>((resolve) => {
    const onReady = () => {
      window.clearTimeout(timer)
      resolve((window as typeof window & { WeixinJSBridge?: WechatBridge }).WeixinJSBridge ?? null)
    }
    const timer = window.setTimeout(() => {
      document.removeEventListener('WeixinJSBridgeReady', onReady)
      resolve(null)
    }, 1500)
    document.addEventListener('WeixinJSBridgeReady', onReady, { once: true })
  })
}

function fulfillmentLabel(status: GuestSessionResponse['account']['orders'][number]['items'][number]['fulfillmentStatus']) {
  const labels = { draft: '待支付', queued: '待制作', preparing: '制作中', completed: '待取送', picked_up: '配送中', delivered: '已送达' }
  return labels[status]
}
