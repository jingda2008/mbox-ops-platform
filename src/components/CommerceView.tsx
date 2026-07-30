import { Ban, CheckCheck, ChefHat, CircleAlert, CircleDollarSign, Clock3, Copy, Gift, LockKeyhole, LogOut, MessageSquareWarning, PackageCheck, PackageX, Play, QrCode, RotateCcw, ScanLine, ShoppingCart, Smartphone, UserRound, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { actOnKdsTask, createAssistedPaymentLink, createCartOrder, createComplimentaryOrder, decideKdsException, getCurrentActorId, managerCancelKdsTask, reportKdsException, verifyCurrentEmployeePin } from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import type { AssistedPaymentLink, KdsActionInput, KdsExceptionDecisionInput, KdsExceptionReportInput, ManagerKdsCancellationInput } from '../shared/commerce-api'
import type { KdsExceptionEvent, KdsTask } from '../shared/order-contracts'
import { formatChinaTime } from '../shared/china-time'
import {
  actionAllowedForAccess,
  canManagerCancelKds,
  canResolveKdsException,
  getFulfillmentAccess,
  kdsTaskOperationallyActive,
  openKdsException,
  stationLabel,
} from './commerce-workspace'
import { MenuOrderingWorkspace, type MenuCartItem, type MenuSubmitOptions } from './MenuOrderingWorkspace'
import { CustomerPaymentCodeScanner } from './CustomerPaymentCodeScanner'
import type { OperationsConsoleNavigationRequest } from './OperationsConsole'
import * as paymentApi from '../payment-api'
import { runOptimisticAction } from '../optimistic-action'
import { projectKdsTask } from '../optimistic-projections'
import './CommerceView.css'

interface CommerceViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onOptimisticUpdate: (update: (current: BootstrapResponse) => BootstrapResponse) => void
  onNotice: (message: string) => void
  focusRequest?: OperationsConsoleNavigationRequest | null
}

const kdsLabels: Record<KdsTask['status'], string> = {
  queued: '待制作', preparing: '制作中', completed: '待取走', picked_up: '配送中', delivered: '已送达',
}

interface PaymentSheet extends AssistedPaymentLink {
  paymentUrl: string
  qrDataUrl: string
  tableSessionId: string
  paymentItems: Array<{ orderId: string; orderItemId: string; quantity: number }>
  fulfillmentNote: string
}

type KdsFocusFilter = 'all' | 'overdue' | 'production' | 'pickup' | 'delivery'

export function CommerceView({ data, onRefresh, onOptimisticUpdate, onNotice, focusRequest = null }: CommerceViewProps) {
  const currentActorId = getCurrentActorId()
  const access = getFulfillmentAccess(data, currentActorId)
  const currentEmployee = access.employee
  const canResolveExceptions = canResolveKdsException(access)
  const canCancelFulfillment = canManagerCancelKds(access, data.viewer?.permissionIds ?? [])
  const occupiedTables = useMemo(() => data.tables.filter((table) => table.status === 'occupied'), [data.tables])
  const [tableId, setTableId] = useState(() => occupiedTables.length === 1 ? occupiedTables[0]!.id : '')
  const [orderMode, setOrderMode] = useState<'paid' | 'gift'>('paid')
  const [settlementMode, setSettlementMode] = useState<'immediate_payment' | 'table_tab'>('immediate_payment')
  const [giftReason, setGiftReason] = useState('')
  const [workspaceMode, setWorkspaceMode] = useState<'order' | 'fulfillment'>('fulfillment')
  const [orderingFocusMode, setOrderingFocusMode] = useState(false)
  const [orderingCartCount, setOrderingCartCount] = useState(0)
  const [exitPinOpen, setExitPinOpen] = useState(false)
  const [exitPin, setExitPin] = useState('')
  const [exitPinError, setExitPinError] = useState('')
  const [verifyingExit, setVerifyingExit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyKdsIds, setBusyKdsIds] = useState<ReadonlySet<string>>(() => new Set())
  const [paymentSheet, setPaymentSheet] = useState<PaymentSheet | null>(null)
  const [paymentCodeScannerOpen, setPaymentCodeScannerOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<KdsTask | null>(null)
  const [cancelReasonCode, setCancelReasonCode] = useState<ManagerKdsCancellationInput['reasonCode']>('manager_cancelled')
  const [cancelReasonNote, setCancelReasonNote] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [focusedTableCode, setFocusedTableCode] = useState('')
  const [focusedTaskId, setFocusedTaskId] = useState('')
  const [kdsFilter, setKdsFilter] = useState<KdsFocusFilter>('all')
  const handledFocusRequestId = useRef<number | null>(null)
  const ledgerTotal = data.orderDomain.tableLedgerEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const activeKds = data.orderDomain.kdsTasks.filter(kdsTaskOperationallyActive)
  const visibleKds = useMemo(() => activeKds.toSorted((a, b) => {
      const aTiming = taskTiming(a, data, now)
      const bTiming = taskTiming(b, data, now)
      if (aTiming.overdue !== bTiming.overdue) return aTiming.overdue ? -1 : 1
      return taskSortValue(a) - taskSortValue(b)
    }), [activeKds, data, now])
  const filteredKds = visibleKds.filter((task) => {
    if (kdsFilter === 'overdue') return taskTiming(task, data, now).overdue
    if (kdsFilter === 'production') return ['queued', 'preparing'].includes(task.status)
    if (kdsFilter === 'pickup') return task.status === 'completed'
    if (kdsFilter === 'delivery') return task.status === 'picked_up'
    return true
  })
  const actionableKdsCount = visibleKds.filter((task) => (
    nextAction(task.status) && actionAllowedForAccess(task, access, data.config.workstations)
  )).length
  const overdueCount = visibleKds.filter((task) => taskTiming(task, data, now).overdue).length
  const activeGiftAuthority = currentEmployee
    ? data.orderDomain.authorizationAuthorities.find((authority) => (
        authority.actorId === currentEmployee.id
        && authority.kinds.includes('gift')
        && authority.maxAmount > 0
        && Date.parse(authority.validFrom) <= now
        && Date.parse(authority.validUntil) >= now
      ))
    : undefined
  const giftApprovalLimit = Math.max(0, ...access.roleIds.map((roleId) => (
    data.config.roles.find((role) => role.id === roleId)?.approvalLimits?.giftAmount ?? 0
  )))
  const giftPermissionGranted = (data.viewer?.permissionIds ?? []).includes('commerce.authorization.request')
  const giftAuthorities = currentEmployee
    ? data.orderDomain.authorizationAuthorities.filter((authority) => (
        authority.actorId === currentEmployee.id && authority.kinds.includes('gift')
      ))
    : []
  const canGift = Boolean(
    currentEmployee
    && access.canOrder
    && activeGiftAuthority
    && giftApprovalLimit > 0
    && giftPermissionGranted,
  )
  const giftUnavailableReason = !currentEmployee
    ? '当前员工身份无效，请重新登录'
    : !access.canOrder
      ? '当前岗位没有点单权限'
      : !giftPermissionGranted
        ? '当前岗位没有赠送申请权限'
        : giftApprovalLimit <= 0
          ? '当前岗位的赠送额度为0，请由管理员配置'
          : giftAuthorities.length === 0
            ? '当前账号尚未配置赠送授权，请由店长或管理员授权'
            : !activeGiftAuthority
              ? '当前账号的赠送授权已过期，请由店长或管理员更新有效期'
              : ''

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (occupiedTables.some((table) => table.id === tableId)) return
    setTableId(occupiedTables.length === 1 ? occupiedTables[0]!.id : '')
  }, [occupiedTables, tableId])

  useEffect(() => {
    if (canGift || orderMode === 'paid') return
    setOrderMode('paid')
    setGiftReason('')
  }, [canGift, orderMode])

  useEffect(() => {
    document.documentElement.classList.toggle('employee-ordering-focus', orderingFocusMode)
    return () => document.documentElement.classList.remove('employee-ordering-focus')
  }, [orderingFocusMode])

  useEffect(() => {
    if (!focusRequest || handledFocusRequestId.current === focusRequest.id) return
    handledFocusRequestId.current = focusRequest.id
    const orderShortcut = focusRequest.focus?.query === 'employee-order-paid'
      || focusRequest.focus?.query === 'employee-order-gift'
    const requestedTable = focusRequest.focus?.tableCode
      ? occupiedTables.find((table) => (
          table.code.toLocaleLowerCase('zh-CN') === focusRequest.focus?.tableCode?.toLocaleLowerCase('zh-CN')
        ))
      : undefined
    if (orderShortcut) {
      if (requestedTable) setTableId(requestedTable.id)
      setWorkspaceMode('order')
      setOrderingFocusMode(true)
      setOrderMode(focusRequest.focus?.query === 'employee-order-gift' && canGift ? 'gift' : 'paid')
    } else {
      setOrderingFocusMode(false)
      setWorkspaceMode('fulfillment')
    }
    setExitPinOpen(false)
    const requestedFilter = kdsFilterForQuery(focusRequest.focus?.query)
    setKdsFilter(requestedFilter)
    const exactTask = visibleKds.find((task) => task.id === focusRequest.focus?.objectId)
    const tableTask = visibleKds.find((task) => {
      const code = task.tableCode ?? tableFromSession(data, task.tableSessionId)?.code ?? ''
      return code.toLocaleLowerCase('zh-CN') === (focusRequest.focus?.tableCode ?? '').toLocaleLowerCase('zh-CN')
    })
    const matchingTask = exactTask ?? tableTask
    setFocusedTaskId(exactTask?.id ?? '')
    setFocusedTableCode(exactTask ? '' : (focusRequest.focus?.tableCode ?? ''))
    if (matchingTask) {
      window.requestAnimationFrame(() => document.getElementById(`kds-task-${matchingTask.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }
  }, [canGift, data, focusRequest, occupiedTables, visibleKds])

  const sheetPayment = paymentSheet
    ? data.paymentDomain.paymentIntents
        .filter((intent) => intent.orderIds.includes(paymentSheet.orderId))
        .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    : undefined
  const sheetPaid = sheetPayment?.status === 'succeeded'
  const sheetBarcodeProcessing = sheetPayment?.status === 'processing'
    && sheetPayment.providerPaymentPayload?.presentation === 'barcode'

  useEffect(() => {
    if (!paymentSheet || sheetPaid) return
    const timer = window.setInterval(() => void onRefresh(), 2500)
    return () => window.clearInterval(timer)
  }, [onRefresh, paymentSheet, sheetPaid])

  async function submit(items: MenuCartItem[], options: MenuSubmitOptions) {
    if (!currentEmployee) {
      const reason = '当前员工身份无效，请重新登录后再试'
      onNotice(`下单未完成：${reason}`)
      throw new Error(reason)
    }
    const orderTable = occupiedTables.find((table) => table.id === tableId)
    if (!orderTable) {
      const reason = occupiedTables.length === 0
        ? '当前没有已开台桌台，请先到“现场调度”开台'
        : '请先选择客人所在桌台，再确认下单'
      onNotice(`下单未完成：${reason}`)
      throw new Error(reason)
    }
    setBusy(true)
    try {
      if (orderMode === 'gift') {
        if (!canGift) throw new Error('当前账号没有有效赠送权限，请由有权限的员工登录本人账号操作')
        if (giftReason.trim().length < 2) throw new Error('请填写至少2个字的赠送原因')
        await createComplimentaryOrder({
          tableId: orderTable.id,
          items,
          reason: giftReason.trim(),
          fulfillmentNote: options.fulfillmentNote,
          sourceKdsTaskId: null,
          idempotencyKey: `gift-cart-${crypto.randomUUID()}`,
        })
        setGiftReason('')
        onNotice(`${orderTable.code}赠送订单已按${currentEmployee.displayName}本人权限提交，零应付并已进入出品`)
        await onRefresh()
        return
      }
      const order = await createCartOrder({
        tableId: orderTable.id,
        items,
        fulfillmentNote: options.fulfillmentNote,
        settlementMode,
        actorId: currentEmployee.id,
        idempotencyKey: `cart-${crypto.randomUUID()}`,
      })
      if (settlementMode === 'table_tab') {
        onNotice(`${orderTable.code}已挂单并进入出品，结台前必须完成收款`)
        await onRefresh()
        return
      }
      const link = await createAssistedPaymentLink(order.id, { idempotencyKey: `pay-link-${crypto.randomUUID()}` })
      const paymentUrl = assistedPaymentUrl(link)
      const QRCode = await import('qrcode')
      const qrDataUrl = await QRCode.toDataURL(paymentUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 360,
        color: { dark: '#151915', light: '#ffffff' },
      })
      setPaymentSheet({
        ...link,
        paymentUrl,
        qrDataUrl,
        tableSessionId: order.tableSessionId,
        paymentItems: order.items.map((item) => ({ orderId: order.id, orderItemId: item.id, quantity: item.quantity })),
        fulfillmentNote: order.fulfillmentNote ?? '',
      })
      onNotice('订单已确认，请客人扫码支付；客人手机订单页也已同步')
      await onRefresh()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('系统暂时无法提交，请稍后重试')
      onNotice(`下单未完成：${failure.message}`)
      throw failure
    } finally {
      setBusy(false)
    }
  }

  async function collectCustomerPaymentCode(customerAuthCode: string) {
    if (!paymentSheet) return false
    try {
      await paymentApi.createTablePaymentIntent(
        paymentSheet.tableSessionId,
        'postar',
        { mode: 'items', items: paymentSheet.paymentItems },
        { presentation: 'barcode', customerAuthCode },
      )
      setPaymentCodeScannerOpen(false)
      onNotice(`${paymentSheet.tableCode}付款码收款已发起，正在等待渠道确认`)
      await onRefresh()
      return true
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '付款码收款发起失败')
      throw error
    }
  }

  async function advance(task: KdsTask, action: KdsActionInput['action']) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后操作KDS')
      return
    }
    const optimisticTask = projectKdsTask(task, action, currentEmployee.id, new Date().toISOString())
    const replaceTask = (replacement: KdsTask) => onOptimisticUpdate((current) => ({
      ...current,
      orderDomain: {
        ...current.orderDomain,
        kdsTasks: current.orderDomain.kdsTasks.map((item) => item.id === task.id ? replacement : item),
      },
    }))
    setBusyKdsIds((current) => new Set(current).add(task.id))
    try {
      await runOptimisticAction({
        key: `kds-task:${task.id}`,
        apply: () => { replaceTask(optimisticTask); return task },
        commit: () => actOnKdsTask(task.id, { action, actorId: currentEmployee.id, idempotencyKey: `kds-${action}-${crypto.randomUUID()}` }),
        reconcile: replaceTask,
        rollback: (snapshot) => replaceTask(snapshot),
      })
      onNotice(`${task.itemName}已更新为${nextLabel(action)}`)
      void onRefresh()
    } catch (error) {
      onNotice(`${error instanceof Error ? error.message : 'KDS操作失败'}；状态已恢复，可以重试`)
    } finally {
      setBusyKdsIds((current) => {
        const next = new Set(current)
        next.delete(task.id)
        return next
      })
    }
  }

  async function reportException(
    task: KdsTask,
    exceptionKind: KdsExceptionReportInput['exceptionKind'],
    reasonCode: KdsExceptionReportInput['reasonCode'],
  ) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后报告异常')
      return
    }
    setBusy(true)
    try {
      await reportKdsException(task.id, {
        exceptionKind,
        reasonCode,
        reasonNote: '',
        actorId: currentEmployee.id,
        idempotencyKey: `kds-exception-${crypto.randomUUID()}`,
      })
      onNotice(`${task.itemName}已报告${exceptionKind === 'wrong_item' ? '错品' : exceptionKind === 'shortage' ? '缺货' : '拒绝出品'}，等待领班或经理处置`)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'KDS异常报告失败')
    } finally {
      setBusy(false)
    }
  }

  async function resolveException(event: KdsExceptionEvent, disposition: KdsExceptionDecisionInput['disposition']) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后处置异常')
      return
    }
    setBusy(true)
    try {
      await decideKdsException(event.exceptionId, {
        disposition,
        reasonCode: disposition === 'remake' ? 'service_recovery' : 'manager_cancelled',
        reasonNote: '',
        actorId: currentEmployee.id,
        idempotencyKey: `kds-decision-${crypto.randomUUID()}`,
      })
      onNotice(disposition === 'remake' ? `${event.exceptionKind === 'wrong_item' ? '错品' : '异常商品'}已创建补做任务` : '该出品项已由经理取消')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'KDS异常处置失败')
    } finally {
      setBusy(false)
    }
  }

  async function cancelFulfillmentTask() {
    if (!cancelTarget || !currentEmployee) return
    setBusy(true)
    try {
      const result = await managerCancelKdsTask(cancelTarget.id, {
        reasonCode: cancelReasonCode,
        reasonNote: cancelReasonNote.trim(),
        idempotencyKey: `kds-manager-cancel-${crypto.randomUUID()}`,
      })
      const accountingHint = result.accounting.recommendation === 'review_refund'
        ? '该项已有收款，请到收银工作台确认退款'
        : result.accounting.recommendation === 'review_receivable'
          ? '该项仍在桌账中，请到收银工作台核对处理'
          : '当前无需额外财务处理'
      setCancelTarget(null)
      setCancelReasonNote('')
      onNotice(`${result.itemName}已停止出品；${accountingHint}`)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '取消出品失败')
    } finally {
      setBusy(false)
    }
  }

  function enterOrderingFocus() {
    setWorkspaceMode('order')
    setOrderingFocusMode(true)
    setExitPinOpen(false)
    setExitPin('')
    setExitPinError('')
  }

  function requestOrderingExit() {
    setExitPinOpen(true)
    setExitPin('')
    setExitPinError('')
  }

  async function verifyOrderingExit() {
    if (exitPin.length !== 4 || verifyingExit) return
    setVerifyingExit(true)
    setExitPinError('')
    try {
      await verifyCurrentEmployeePin(exitPin)
      setExitPinOpen(false)
      setOrderingFocusMode(false)
      setWorkspaceMode('fulfillment')
      setOrderingCartCount(0)
      setExitPin('')
      onNotice(orderingCartCount > 0 ? '已退出客用点单，未提交的购物车已清空' : '已退出客用点单')
    } catch (error) {
      setExitPinError(error instanceof Error ? error.message : 'PIN验证失败，请重试')
    } finally {
      setVerifyingExit(false)
    }
  }

  const accountRows = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const entry of data.orderDomain.tableLedgerEntries) {
      grouped.set(entry.tableSessionId, (grouped.get(entry.tableSessionId) ?? 0) + entry.amount)
    }
    return Array.from(grouped, ([sessionId, balance]) => ({ sessionId, balance }))
  }, [data.orderDomain.tableLedgerEntries])
  const latestPaidSignal = data.paymentDomain.paymentIntents
    .filter((intent) => ['succeeded', 'reported_pending_reconciliation'].includes(intent.status))
    .toSorted((left, right) => Date.parse(right.paidAt ?? right.createdAt) - Date.parse(left.paidAt ?? left.createdAt))[0]
  const paidTable = latestPaidSignal ? tableFromSession(data, latestPaidSignal.tableSessionId) : undefined
  const selectedTable = occupiedTables.find((table) => table.id === tableId)
  const tableSelectionMessage = selectedTable
    ? ''
    : occupiedTables.length === 0
      ? '当前没有已开台桌台，请先到“现场调度”开台'
      : '请先选择客人所在桌台，再开始核对订单'
  const giftReasonMissing = orderMode === 'gift' && giftReason.trim().length < 2

  return (
    <section className={`commerce-view${orderingFocusMode ? ' is-ordering-focus' : ''}`}>
      {!orderingFocusMode && <div className="section-heading">
        <div><span className="eyebrow">{access.roleLabel} · {access.scopeLabel}</span><h2>岗位履约工作台</h2></div>
        <span className="count-chip">{visibleKds.length}项履约进度</span>
      </div>}
      {!orderingFocusMode && latestPaidSignal && <div className="paid-signal" role="status"><CheckCheck size={20} /><div><strong>{paidTable?.code ?? '桌台'} 已收款 {money(latestPaidSignal.amount)}</strong><span>{latestPaidSignal.channel === 'physical_pos' ? '物理POS待对账' : '支付成功，服务与收银已同步'}</span></div></div>}
      {paymentSheet && <div className="assisted-payment-backdrop" role="presentation">
        <section className={`assisted-payment-dialog ${sheetPaid ? 'is-paid' : ''}`} role="dialog" aria-modal="true" aria-label={`${paymentSheet.tableCode}订单支付`}>
          <header>
            <div><span>{sheetPaid ? '支付已确认' : '请客人扫码支付'}</span><strong>{paymentSheet.tableCode} · {money(paymentSheet.amount)}</strong></div>
            <button className="icon-button" title="关闭支付窗口" onClick={() => { setPaymentCodeScannerOpen(false); setPaymentSheet(null) }}><X size={20} /></button>
          </header>
          {paymentSheet.fulfillmentNote && <div className="assisted-payment-note"><MessageSquareWarning size={18} /><span><strong>订单重点备注</strong>{paymentSheet.fulfillmentNote}</span></div>}
          {sheetPaid ? <div className="assisted-payment-success"><CheckCheck size={54} /><strong>支付成功</strong><span>服务员、收银与出品岗位已同步到账状态</span></div> : sheetBarcodeProcessing ? <div className="assisted-payment-processing"><Clock3 className="spin" size={48} /><strong>正在确认付款</strong><span>请勿重复扫码，到账后本页自动更新</span></div> : <>
            <div className="assisted-payment-methods">
              <button className="is-active" type="button"><QrCode size={17} />客人扫码支付</button>
              <button type="button" onClick={() => setPaymentCodeScannerOpen(true)}><ScanLine size={17} />扫客户付款码</button>
            </div>
            <div className="assisted-payment-qr"><img src={paymentSheet.qrDataUrl} alt={`${paymentSheet.tableCode}支付二维码`} /></div>
            <div className="assisted-payment-guidance">
              <p><QrCode size={18} /><span>客人使用微信扫描二维码，在手机订单页确认支付。</span></p>
              <p><Smartphone size={18} /><span>客人已打开本桌页面时，订单会自动出现，点击“微信支付”即可。</span></p>
            </div>
            <button className="secondary-button assisted-copy" onClick={() => void navigator.clipboard.writeText(paymentSheet.paymentUrl)}><Copy size={16} />复制手机支付链接</button>
            <small>二维码将在北京时间 {formatChinaTime(paymentSheet.expiresAt)} 失效</small>
          </>}
          {sheetPaid && <button className="primary-button assisted-done" onClick={() => setPaymentSheet(null)}>继续点单</button>}
        </section>
      </div>}
      {paymentSheet && paymentCodeScannerOpen && (
        <CustomerPaymentCodeScanner
          tableCode={paymentSheet.tableCode}
          amountLabel={money(paymentSheet.amount)}
          onClose={() => setPaymentCodeScannerOpen(false)}
          onConfirm={collectCustomerPaymentCode}
        />
      )}
      {cancelTarget && <div className="manager-cancel-backdrop" role="presentation">
        <section className="manager-cancel-dialog" role="dialog" aria-modal="true" aria-label={`取消${cancelTarget.itemName}出品`}>
          <header>
            <div><span>店长取消出品</span><strong>{cancelTarget.tableCode ?? tableFromSession(data, cancelTarget.tableSessionId)?.code ?? '当前桌台'} · {cancelTarget.itemName} × {cancelTarget.quantity}</strong></div>
            <button className="icon-button" title="关闭取消窗口" disabled={busy} onClick={() => setCancelTarget(null)}><X size={20} /></button>
          </header>
          <div className="manager-cancel-boundary"><CircleAlert size={18} /><span>取消后停止本次制作或送达，原订单、桌账和支付不会自动修改。</span></div>
          <label><span>取消原因</span><select value={cancelReasonCode} onChange={(event) => setCancelReasonCode(event.target.value as ManagerKdsCancellationInput['reasonCode'])}><option value="manager_cancelled">店长现场取消</option><option value="guest_cancelled">客人确认取消</option><option value="unavailable_confirmed">确认无法出品</option><option value="other">其他原因</option></select></label>
          <label><span>情况说明（选填）</span><input autoFocus maxLength={200} value={cancelReasonNote} onChange={(event) => setCancelReasonNote(event.target.value)} placeholder="可补充现场情况" /></label>
          <footer>
            <button className="secondary-button" disabled={busy} onClick={() => setCancelTarget(null)}>暂不取消</button>
            <button className="danger-button" disabled={busy} onClick={() => void cancelFulfillmentTask()}><Ban size={16} />确认取消出品</button>
          </footer>
        </section>
      </div>}
      {!orderingFocusMode && access.canOrder && <div className="commerce-mode-tabs">
        <button onClick={enterOrderingFocus}>全屏点单</button>
        <button className={workspaceMode === 'fulfillment' ? 'is-active' : ''} onClick={() => setWorkspaceMode('fulfillment')}>出品履约 <span>{visibleKds.length}</span></button>
        <div className="employee-order-type">
          <small>订单类型</small>
          <div className="employee-order-mode" role="group" aria-label="订单类型">
            <button type="button" className={orderMode === 'paid' ? 'is-active' : ''} onClick={() => setOrderMode('paid')}><ShoppingCart size={15} />正常下单</button>
            <button
              type="button"
              className={`${orderMode === 'gift' ? 'is-active is-gift' : ''}${canGift ? '' : ' is-unavailable'}`}
              aria-describedby={canGift ? undefined : 'gift-availability-note'}
              onClick={() => {
                setOrderMode('gift')
                if (!canGift) onNotice(`暂不能赠送：${giftUnavailableReason}`)
              }}
            >
              <Gift size={15} />权限赠送
            </button>
          </div>
          {!canGift && <span className="employee-gift-availability" id="gift-availability-note">{giftUnavailableReason}</span>}
        </div>
      </div>}

      {workspaceMode === 'order' && access.canOrder ? (
        <>
          {orderingFocusMode && <button className="employee-ordering-exit" type="button" onClick={requestOrderingExit}><LogOut size={17} />员工退出</button>}
          <MenuOrderingWorkspace
            products={data.products}
            tableLabel={selectedTable ? `${selectedTable.code} · ${selectedTable.displayName}` : '尚未选择桌台'}
            tableControl={<div className="employee-order-controls">
              <div className="menu-table-control"><select aria-label="选择桌台" value={tableId} disabled={occupiedTables.length === 0} onChange={(event) => setTableId(event.target.value)}><option value="">{occupiedTables.length === 0 ? '当前没有已开台桌台' : '请选择客人所在桌台'}</option>{occupiedTables.map((table) => <option key={table.id} value={table.id}>{table.code} · {table.displayName} · {table.guestCount}人</option>)}</select>{tableSelectionMessage && <span className="menu-table-guidance" role="alert">{tableSelectionMessage}</span>}</div>
              <span className={`employee-order-badge${orderMode === 'gift' ? ' is-gift' : ''}`}>{orderMode === 'gift' ? <Gift size={14} /> : <ShoppingCart size={14} />}{orderMode === 'gift' ? '权限赠送' : '正常下单'}</span>
              {orderMode === 'paid' && <div className="employee-settlement-mode" role="group" aria-label="结算方式">
                <button type="button" className={settlementMode === 'immediate_payment' ? 'is-active' : ''} onClick={() => setSettlementMode('immediate_payment')}><QrCode size={14} />立即付款</button>
                <button type="button" className={settlementMode === 'table_tab' ? 'is-active' : ''} onClick={() => setSettlementMode('table_tab')}><Clock3 size={14} />挂单消费</button>
              </div>}
              {orderMode === 'gift' && <label className="employee-gift-reason"><span>赠送原因（必填）</span><input aria-label="赠送原因" maxLength={200} value={giftReason} onChange={(event) => setGiftReason(event.target.value)} placeholder="例如：生日关怀、服务补偿" /></label>}
            </div>}
            submitLabel={!selectedTable
              ? '请先选择桌台'
              : orderMode === 'gift' && !canGift
                ? '当前账号暂不能赠送'
                : giftReasonMissing
                  ? '请填写赠送原因'
                  : orderMode === 'gift'
                    ? '确认赠送并出品'
                    : settlementMode === 'table_tab' ? '确认挂单并出品' : '确认订单并收款'}
            submitHint={!selectedTable
              ? occupiedTables.length === 0 ? '请先到现场调度开台，再回到这里提交订单。' : '请选择客人所在桌台，确认后才会创建订单。'
              : orderMode === 'gift'
                ? canGift
                  ? `按${currentEmployee?.displayName ?? '当前员工'}本人账号权限校验，客人零应付；商品、库存、成本及赠送原因全部留痕。`
                  : `暂不能赠送：${giftUnavailableReason}`
                : settlementMode === 'table_tab'
                  ? '订单立即进入出品并计入桌账；结台前必须完成收款。'
                  : '订单进入出品，同时打开客扫二维码或付款码收款。'}
            submitDisabled={!selectedTable || giftReasonMissing || (orderMode === 'gift' && !canGift)}
            complimentaryMode={orderMode === 'gift'}
            compactCart
            deemphasizeCollapsedTotal
            busy={busy}
            timeZone={data.store.timezone}
            orderSafety={data.commercialOps?.config.orderSafety}
            onSubmit={submit}
            onCartCountChange={setOrderingCartCount}
          />
        </>
      ) : <>
      <div className="commerce-metrics">
        <div><ChefHat size={19} /><strong>{actionableKdsCount}</strong><span>我可处理</span></div>
        <div className={overdueCount > 0 ? 'is-risk' : ''}><CircleAlert size={19} /><strong>{overdueCount}</strong><span>SLA超时</span></div>
        {access.canViewLedger
          ? <div><CircleDollarSign size={19} /><strong>{money(ledgerTotal)}</strong><span>桌账应收</span></div>
          : <div><UserRound size={19} /><strong>{access.stationIds.length || '全'}</strong><span>负责制作工位</span></div>}
      </div>
      <div className={access.canViewLedger ? 'commerce-grid' : 'commerce-grid is-task-only'}>
        <section className="kds-section">
          <div className="commerce-section-title"><ChefHat size={18} /><strong>出品履约进度</strong><span>岗位与工作站匹配者可操作，其他人员只读</span></div>
          {kdsFilter !== 'all' && <div className="kds-focus-filter" role="status"><span>{kdsFilterLabel(kdsFilter)} · {filteredKds.length}项</span><button type="button" onClick={() => { setKdsFilter('all'); setFocusedTaskId(''); setFocusedTableCode('') }}>查看全部</button></div>}
          <div className="kds-list">
            {filteredKds.length === 0 && <div className="commerce-empty"><CheckCheck size={22} />{kdsFilter === 'all' ? '当前岗位没有待处理商品' : `${kdsFilterLabel(kdsFilter)}已处理完成或状态已更新`}</div>}
            {filteredKds.map((task) => {
              const table = tableFromSession(data, task.tableSessionId)
              const action = nextAction(task.status)
              const timing = taskTiming(task, data, now)
              const responsibleRole = taskResponsibleRole(task, data)
              const exception = openKdsException(task)
              const exceptionActor = exception ? data.employees.find((employee) => employee.id === exception.actorId) : undefined
              const canAct = Boolean(action && actionAllowedForAccess(task, access, data.config.workstations))
              const canCompleteAndDeliver = task.status === 'preparing'
                && (task.fulfillmentType ?? 'made_to_order') === 'made_to_order'
                && canAct
                && actionAllowedForAccess({ ...task, status: 'completed' }, access, data.config.workstations)
              const canReportProductionException = !exception && ['queued', 'preparing'].includes(task.status) && canAct
              const canReportWrongItem = !exception && ['completed', 'picked_up'].includes(task.status) && canAct
              return (
                <article
                  id={`kds-task-${task.id}`}
                  className={`kds-row kds-${task.status} ${timing.overdue ? 'is-overdue' : ''} ${exception ? 'has-exception' : ''} ${(focusedTaskId === task.id || (focusedTableCode && (task.tableCode ?? table?.code) === focusedTableCode)) ? 'is-ai-focus' : ''}`}
                  key={task.id}
                  aria-busy={busyKdsIds.has(task.id)}
                >
                  <div className="kds-table"><span>{table?.code ?? task.tableCode ?? '未知桌号'}</span><small>{table?.displayName ?? (task.tableCode ? '按桌号出品' : '桌台未匹配')}</small></div>
                  <div className="kds-product">
                    <strong>{task.itemName} × {task.quantity}</strong>
                    <span>{task.specification} · {task.workstation?.name ?? stationLabel(task.stationId)}</span>
                    {task.fulfillmentNote && <span className="kds-fulfillment-note"><MessageSquareWarning size={14} />重点：{task.fulfillmentNote}</span>}
                    {task.remakeOf && <span className="kds-remake-badge">第 {task.remakeOf.attempt} 次补做 · 关联原订单明细</span>}
                  </div>
                  <div className="kds-meta">
                    {exception ? <>
                      <span className="kds-exception-state"><CircleAlert size={13} />{exceptionKindLabel(exception)}待处置</span>
                      <span>{exceptionReasonLabel(exception.reasonCode)}</span>
                      <span>{exceptionActor?.displayName ?? exception.actorId} · {formatEventTime(exception.occurredAt)}</span>
                      <span>经理处置：待取消或补做</span>
                    </> : <>
                      <span className={`kds-state state-${task.status}`}>{kdsLabels[task.status]}</span>
                      <span><Clock3 size={13} />等待 {formatDuration(timing.waitSeconds)}</span>
                      <span className={timing.overdue ? 'sla-overdue' : 'sla-normal'}>{timing.overdue ? `SLA超时 ${formatDuration(timing.overSeconds)}` : `SLA剩余 ${formatDuration(timing.remainingSeconds)}`}</span>
                      <span>负责岗位 {responsibleRole}</span>
                    </>}
                  </div>
                  <div className="kds-actions">
                    {!exception && action && canAct && <button className="secondary-button" disabled={busy || busyKdsIds.has(task.id) || !currentEmployee} title={currentEmployee ? `由${currentEmployee.displayName}执行` : '请重新登录'} onClick={() => void advance(task, action)}>{actionIcon(action)}{nextLabel(action)}</button>}
                    {!exception && canCompleteAndDeliver && <button className="primary-button" disabled={busy || busyKdsIds.has(task.id) || !currentEmployee} title="制作人与取送岗位相同时，一次记录完成、取货和送达" onClick={() => void advance(task, 'completeAndDeliver')}><CheckCheck size={16} />完成并送达</button>}
                    {!exception && action && !canAct && <span className="kds-readonly-note">仅查看进度</span>}
                    {canReportProductionException && <button className="secondary-button kds-exception-button" disabled={busy || !currentEmployee} title="按商品缺货报告，等待领班或经理处置" onClick={() => void reportException(task, 'shortage', 'product_out_of_stock')}><PackageX size={16} />报告缺货</button>}
                    {canReportProductionException && task.status === 'preparing' && <button className="icon-button kds-reject-button" disabled={busy || !currentEmployee} title="质量不合格，拒绝本次出品" onClick={() => void reportException(task, 'production_rejection', 'quality_rejected')}><CircleAlert size={16} /></button>}
                    {canReportWrongItem && <button className="secondary-button kds-exception-button" disabled={busy || !currentEmployee} title="报告错品并等待经理安排补做" onClick={() => void reportException(task, 'wrong_item', 'wrong_product')}><PackageX size={16} />报告错品</button>}
                    {!exception && canCancelFulfillment && <button className="secondary-button kds-cancel-button" disabled={busy || !currentEmployee} title="停止本次出品，订单和收款保持不变" onClick={() => { setCancelReasonCode('manager_cancelled'); setCancelReasonNote(''); setCancelTarget(task) }}><Ban size={16} />取消出品</button>}
                    {exception && canResolveExceptions && <>
                      <button className="secondary-button kds-cancel-button" disabled={busy || !currentEmployee} title="保留原订单和原KDS记录，仅关闭本次出品" onClick={() => void resolveException(exception, 'cancelled')}><Ban size={16} />取消该项</button>
                      <button className="primary-button" disabled={busy || !currentEmployee} title="创建关联原订单明细和原KDS任务的补做任务" onClick={() => void resolveException(exception, 'remake')}><RotateCcw size={16} />安排补做</button>
                    </>}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        {access.canViewLedger && <section className="ledger-section">
          <div className="commerce-section-title"><CircleDollarSign size={18} /><strong>桌账余额</strong></div>
          <div className="ledger-list">
            {accountRows.length === 0 && <div className="commerce-empty">暂无桌账流水</div>}
            {accountRows.map((row) => {
              const table = tableFromSession(data, row.sessionId)
              return <div className="ledger-row" key={row.sessionId}><div><strong>{table?.displayName ?? row.sessionId}</strong><span>{table?.code}</span></div><b>{money(row.balance)}</b></div>
            })}
          </div>
        </section>}
      </div>
      </>}
      {exitPinOpen && <div className="ordering-exit-backdrop" role="presentation">
        <section className="ordering-exit-dialog" role="dialog" aria-modal="true" aria-label="退出客用点单">
          <header><span><LockKeyhole size={20} /></span><div><small>员工验证</small><h2>退出客用点单</h2></div></header>
          <p>{orderingCartCount > 0 ? `当前购物车还有 ${orderingCartCount} 件未提交商品，退出后会清空。` : '验证当前员工PIN后返回出品履约页面。'}</p>
          <label><span>当前员工PIN</span><input autoFocus aria-label="当前员工PIN" type="password" inputMode="numeric" autoComplete="current-password" minLength={4} maxLength={4} value={exitPin} onChange={(event) => { setExitPin(event.target.value.replace(/\D/g, '').slice(0, 4)); setExitPinError('') }} onKeyDown={(event) => { if (event.key === 'Enter' && exitPin.length === 4) void verifyOrderingExit() }} /></label>
          {exitPinError && <div className="ordering-exit-error" role="alert">{exitPinError}</div>}
          <footer>
            <button className="secondary-button" type="button" disabled={verifyingExit} onClick={() => { setExitPinOpen(false); setExitPin(''); setExitPinError('') }}>继续点单</button>
            <button className="primary-button" type="button" disabled={exitPin.length !== 4 || verifyingExit} onClick={() => void verifyOrderingExit()}>{verifyingExit ? '正在验证' : '验证并退出'}</button>
          </footer>
        </section>
      </div>}
    </section>
  )
}

function tableFromSession(data: BootstrapResponse, sessionId: string) {
  const session = data.songState.tableSessions.find((item) => item.id === sessionId)
  return data.tables.find((table) => table.id === session?.tableId)
}

function kdsFilterForQuery(query?: string | null): KdsFocusFilter {
  if (query === 'kds-overdue') return 'overdue'
  if (query === 'kds-production') return 'production'
  if (query === 'kds-pickup') return 'pickup'
  if (query === 'kds-delivery') return 'delivery'
  return 'all'
}

function kdsFilterLabel(filter: Exclude<KdsFocusFilter, 'all'>) {
  if (filter === 'overdue') return '仅看 SLA 超时'
  if (filter === 'production') return '仅看待制作'
  if (filter === 'pickup') return '仅看待取货'
  return '仅看配送中'
}

function nextAction(status: KdsTask['status']): KdsActionInput['action'] | null {
  return status === 'queued' ? 'start' : status === 'preparing' ? 'complete' : status === 'completed' ? 'pickUp' : status === 'picked_up' ? 'deliver' : null
}

function nextLabel(action: KdsActionInput['action']) {
  return action === 'start' ? '接单制作' : action === 'complete' ? '完成制作' : action === 'completeAndDeliver' ? '完成并送达' : action === 'pickUp' ? '确认取货' : '确认送达'
}

function actionIcon(action: KdsActionInput['action']) {
  return action === 'start' ? <Play size={16} /> : action === 'complete' ? <PackageCheck size={16} /> : action === 'completeAndDeliver' ? <CheckCheck size={16} /> : action === 'pickUp' ? <ShoppingCart size={16} /> : <CheckCheck size={16} />
}

function exceptionKindLabel(event: KdsExceptionEvent) {
  return event.exceptionKind === 'shortage' ? '缺货' : event.exceptionKind === 'wrong_item' ? '错品' : '拒绝出品'
}

function exceptionReasonLabel(reasonCode: KdsExceptionEvent['reasonCode']) {
  const labels: Record<KdsExceptionEvent['reasonCode'], string> = {
    product_out_of_stock: '商品缺货',
    ingredient_out_of_stock: '原料缺货',
    equipment_unavailable: '设备不可用',
    quality_rejected: '质量不合格',
    wrong_product: '商品错误',
    wrong_specification: '规格错误',
    damaged: '破损或洒漏',
    unavailable_confirmed: '确认无法出品',
    guest_cancelled: '客人取消',
    manager_cancelled: '经理取消',
    service_recovery: '服务补救',
    quality_recovery: '质量补救',
    other: '其他原因',
  }
  return labels[reasonCode]
}

function formatEventTime(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? formatChinaTime(timestamp)
    : value
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}

function assistedPaymentUrl(link: AssistedPaymentLink) {
  const configuredBase = String(import.meta.env.VITE_MBOX_GUEST_BASE_URL ?? '').trim()
  const url = new URL(configuredBase || '/guest', window.location.origin)
  url.searchParams.set('token', link.tableToken)
  url.searchParams.set('payOrder', link.orderId)
  return url.toString()
}

function taskTiming(task: KdsTask, data: BootstrapResponse, now: number) {
  const startedAt = task.status === 'queued' ? task.queuedAt
    : task.status === 'preparing' ? task.startedAt ?? task.queuedAt
      : task.status === 'completed' ? task.completedAt ?? task.queuedAt
        : task.pickedUpAt ?? task.completedAt ?? task.queuedAt
  const linkedServiceTask = task.deliveryServiceTask
    ? data.tasks.find((item) => item.id === task.deliveryServiceTask?.id)
    : undefined
  const snapshot = ['queued', 'preparing'].includes(task.status) ? task.productionSla : task.pickupSla
  const configuredDeadline = task.status === 'picked_up'
    ? linkedServiceTask?.escalateAt ?? snapshot?.dueAt ?? undefined
    : snapshot?.dueAt ?? readTaskString(task, ['slaDeadlineAt', 'deadlineAt', 'dueAt', 'targetAt'])
  const configuredSeconds = snapshot?.targetSeconds
    ?? readTaskNumber(task, ['slaSeconds', 'slaTargetSeconds', 'targetSeconds'])
    ?? readStationSlaSeconds(data, task.stationId, task.status)
  const fallbackSeconds = task.status === 'queued' ? 300 : task.status === 'preparing' ? 600 : task.status === 'completed' ? 180 : 300
  const deadline = configuredDeadline ? Date.parse(configuredDeadline) : Date.parse(startedAt) + (configuredSeconds ?? fallbackSeconds) * 1000
  const waitSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const deltaSeconds = Math.floor((deadline - now) / 1000)
  return {
    waitSeconds,
    overdue: deltaSeconds < 0,
    overSeconds: Math.max(0, -deltaSeconds),
    remainingSeconds: Math.max(0, deltaSeconds),
  }
}

function taskSortValue(task: KdsTask) {
  const queuedAt = Date.parse(task.queuedAt)
  return Number.isFinite(queuedAt) ? queuedAt : 0
}

function readStationSlaSeconds(data: BootstrapResponse, stationId: string, status: KdsTask['status']) {
  const config = data.config as unknown as Record<string, unknown>
  const candidates = [config.workstations, config.fulfillmentWorkstations, config.productionStations]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const station = candidate.find((item) => isRecord(item) && [item.id, item.stationId, item.workstationId].includes(stationId))
    if (!isRecord(station)) continue
    const stageKey = ['queued', 'preparing'].includes(status) ? 'productionSlaSeconds' : 'deliverySlaSeconds'
    const stageValue = station[stageKey]
    if (typeof stageValue === 'number' && Number.isFinite(stageValue) && stageValue > 0) return stageValue
    const value = station.slaSeconds
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function readTaskString(task: KdsTask, keys: string[]) {
  const record = task as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readTaskNumber(task: KdsTask, keys: string[]) {
  const record = task as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function taskResponsibleRole(task: KdsTask, data: BootstrapResponse) {
  const explicit = readTaskString(task, ['responsibleRoleName', 'ownerRoleName', 'roleName'])
  if (explicit) return explicit
  const ownerId = task.deliveryServiceTask?.ownerId
  const owner = ownerId ? data.employees.find((employee) => employee.id === ownerId) : undefined
  const ownerRole = owner ? data.config.roles.find((role) => role.id === owner.roleId)?.name : undefined
  if (ownerRole) return ownerRole
  const workstation = data.config.workstations.find((item) => item.id === task.stationId) ?? task.workstation
  const roleIds = ['queued', 'preparing'].includes(task.status)
    ? workstation?.productionRoleIds
    : workstation?.deliveryRoleIds
  const roleNames = roleIds
    ?.filter((roleId) => !['supervisor', 'manager'].includes(roleId))
    .map((roleId) => data.config.roles.find((role) => role.id === roleId)?.name ?? roleId)
  return roleNames && roleNames.length > 0
    ? roleNames.join('/')
    : ['queued', 'preparing'].includes(task.status) ? '出品岗' : '取送岗'
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder > 0 ? `${minutes}分${remainder}秒` : `${minutes}分钟`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
