import {
  Banknote,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  DoorOpen,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ImageDown,
  Search,
  Settings2,
  UserCheck,
  UserRoundX,
  UsersRound,
  UserPlus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { getCurrentActorId } from '../api'
import {
  actOnReservation,
  assignReservationSales,
  confirmDeposit,
  confirmDepositRefund,
  createReservation,
  failDepositRefund,
  listReservations,
  recordDepositIntent,
  startDepositRefund,
  updateReservationConfig,
  updateReservationDetails,
  decideLateReservationHold,
  type ReservationListResponse,
  type ReservationConfigWriteInput,
} from '../reservation-api'
import type { BootstrapResponse, Employee, StaffPermissionId, Table } from '../shared/contracts'
import type {
  Reservation,
  ReservationDepositStatus,
  ReservationConfig,
  ReservationOccasionCode,
  ReservationStatus,
} from '../shared/reservation-contracts'
import { CHINA_TIME_ZONE, chinaBusinessDateKey, chinaDateTimeLocalValue, chinaLocalDateTimeToIso, formatChinaDateTime, formatChinaTime, shiftDateKey } from '../shared/china-time'
import './ReservationView.css'
import { WaitlistPanel } from './WaitlistPanel'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import type { OperationsConsoleNavigationRequest } from './OperationsConsole'

type DateRange = 'today' | 'upcoming' | 'all'
type Notice = { tone: 'success' | 'error'; message: string }
type OperationType = 'edit' | 'sales' | 'late_hold' | 'late_release' | 'deposit_intent' | 'deposit_confirm' | 'seat' | 'cancel' | 'no_show' | 'refund_start' | 'refund_complete' | 'refund_fail'
type Operation = { type: OperationType; reservation: Reservation }

interface CreateDraft {
  customerName: string
  customerReference: string
  phone: string
  wechatId: string
  sourceCode: string
  partySize: number
  areaPreferenceCode: string
  occasionCode: '' | ReservationOccasionCode
  occasionNote: string
  scheduledAt: string
  depositYuan: string
  salesEmployeeId: string
}

type ConfigDraft = ReservationConfigWriteInput

const statusLabels: Record<ReservationStatus, string> = {
  requested: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  seated: '已入座',
  cancelled: '已取消',
  no_show: '未到店',
}

const depositLabels: Record<ReservationDepositStatus, string> = {
  not_required: '无需定金',
  payment_required: '待创建支付单',
  payment_intent_recorded: '待确认到账',
  payment_confirmed: '定金已到账',
  refund_required: '待发起退款',
  refund_processing: '退款处理中',
  refunded: '退款完成',
  refund_failed: '退款失败',
}

const emptyResponse: ReservationListResponse = { config: null, reservations: [] }
const RESERVATION_POLL_INTERVAL_MS = 10_000

interface ReservationPollingOptions {
  isVisible?: () => boolean
  schedule?: (callback: () => void, delay: number) => number
  cancel?: (timer: number) => void
  visibilityTarget?: Pick<Document, 'addEventListener' | 'removeEventListener'>
  pageShowTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

// oxlint-disable-next-line react/only-export-components -- exported for lifecycle tests
export function startReservationPolling(
  refresh: () => void | Promise<void>,
  options: ReservationPollingOptions = {},
) {
  const isVisible = options.isVisible ?? (() => document.visibilityState === 'visible')
  const schedule = options.schedule ?? ((callback, delay) => window.setTimeout(callback, delay))
  const cancel = options.cancel ?? ((timer) => window.clearTimeout(timer))
  const visibilityTarget = options.visibilityTarget ?? document
  const pageShowTarget = options.pageShowTarget ?? window
  let stopped = false
  let timer: number | undefined
  let running = false
  let refreshAfterCurrent = false

  const clearTimer = () => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const scheduleNext = () => {
    clearTimer()
    if (stopped || !isVisible()) return
    timer = schedule(() => {
      timer = undefined
      void poll()
    }, RESERVATION_POLL_INTERVAL_MS)
  }
  const poll = async () => {
    if (stopped || running || !isVisible()) return
    running = true
    try {
      await refresh()
    } catch {
      // ReservationView owns the visible error notice; keep the polling loop recoverable.
    } finally {
      running = false
    }
    if (stopped || !isVisible()) return
    if (refreshAfterCurrent) {
      refreshAfterCurrent = false
      void poll()
      return
    }
    scheduleNext()
  }
  const refreshNow = () => {
    clearTimer()
    if (!isVisible()) return
    if (running) {
      refreshAfterCurrent = true
      return
    }
    void poll()
  }
  const handleVisibilityChange = () => {
    if (isVisible()) refreshNow()
    else {
      refreshAfterCurrent = false
      clearTimer()
    }
  }

  visibilityTarget.addEventListener('visibilitychange', handleVisibilityChange)
  pageShowTarget.addEventListener('pageshow', refreshNow)
  refreshNow()
  return () => {
    stopped = true
    refreshAfterCurrent = false
    clearTimer()
    visibilityTarget.removeEventListener('visibilitychange', handleVisibilityChange)
    pageShowTarget.removeEventListener('pageshow', refreshNow)
  }
}

function defaultScheduledAt() {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 60 - (date.getMinutes() % 15), 0, 0)
  return chinaDateTimeLocalValue(date)
}

function createEmptyDraft(salesEmployeeId = ''): CreateDraft {
  return {
    customerName: '',
    customerReference: '',
    phone: '',
    wechatId: '',
    sourceCode: '',
    partySize: 2,
    areaPreferenceCode: '',
    occasionCode: '',
    occasionNote: '',
    scheduledAt: defaultScheduledAt(),
    depositYuan: '0',
    salesEmployeeId,
  }
}

interface ReservationAccess {
  manage: boolean
  configure: boolean
  confirmDeposit: boolean
  requestRefund: boolean
  approveRefund: boolean
}

export function ReservationView({ data, focusRequest = null }: { data: BootstrapResponse; focusRequest?: OperationsConsoleNavigationRequest | null }) {
  const [response, setResponse] = useState<ReservationListResponse>(emptyResponse)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>('today')
  const [statusFilter, setStatusFilter] = useState<'all' | ReservationStatus>('all')
  const [query, setQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [draft, setDraft] = useState<CreateDraft>(createEmptyDraft)
  const [configDraft, setConfigDraft] = useState<ConfigDraft | null>(null)
  const [configReason, setConfigReason] = useState('')
  const [operation, setOperation] = useState<Operation | null>(null)
  const [reference, setReference] = useState('')
  const [secondaryReference, setSecondaryReference] = useState('')
  const [reason, setReason] = useState('')
  const [selectedTableId, setSelectedTableId] = useState('')
  const [selectedSalesEmployeeId, setSelectedSalesEmployeeId] = useState('')
  const [editPartySize, setEditPartySize] = useState(1)
  const [editScheduledAt, setEditScheduledAt] = useState('')
  const [editAreaCode, setEditAreaCode] = useState('')
  const [focusedReservationId, setFocusedReservationId] = useState('')
  const configPanelRef = useRevealPanelScroll<HTMLDivElement>(showConfig && configDraft ? 'config' : '')
  const createPanelRef = useRevealPanelScroll<HTMLFormElement>(showCreate ? 'create' : '')
  const operationPanelRef = useRevealPanelScroll<HTMLDivElement>(operation ? `${operation.type}:${operation.reservation.id}` : '')
  const loadInFlight = useRef<Promise<void> | null>(null)
  const handledFocusRequestId = useRef<number | null>(null)
  const actorId = getCurrentActorId()
  const employee = data.employees.find((item) => item.id === actorId)
  const activeShift = data.shiftAssignments.find((shift) =>
    shift.employeeId === actorId && shift.businessDate === data.store.businessDate && shift.status === 'active',
  )
  const businessDayRolloverHour = data.tableOperationsConfig?.businessDayRolloverHour ?? 6
  const role = data.config.roles.find((item) => item.id === (activeShift?.roleId ?? employee?.roleId))
  const permissions = new Set<StaffPermissionId>(role?.permissionIds ?? [])
  const salesEmployees = data.employees.filter((item) => item.status === 'active' && item.online)
  const access: ReservationAccess = {
    manage: permissions.has('reservation.manage'),
    configure: permissions.has('reservation.config.manage'),
    confirmDeposit: permissions.has('payment.collect'),
    requestRefund: permissions.has('payment.refund.request'),
    approveRefund: permissions.has('payment.refund.approve'),
  }

  const load = useCallback(async (withSpinner = true, refreshAfterActiveRequest = false) => {
    if (loadInFlight.current) {
      await loadInFlight.current
      if (!refreshAfterActiveRequest) return
      if (loadInFlight.current) await loadInFlight.current
    }
    if (withSpinner) setLoading(true)
    const request = (async () => {
      try {
        setResponse(await listReservations())
        setNotice(null)
      } catch (error) {
        setNotice({ tone: 'error', message: errorMessage(error, '预约数据加载失败') })
      } finally {
        setLoading(false)
      }
    })()
    loadInFlight.current = request
    try {
      await request
    } finally {
      if (loadInFlight.current === request) loadInFlight.current = null
    }
  }, [])

  useEffect(() => startReservationPolling(() => load(false)), [load])

  useEffect(() => {
    if (!focusRequest || handledFocusRequestId.current === focusRequest.id) return
    handledFocusRequestId.current = focusRequest.id
    setDateRange('today')
    setStatusFilter('all')
    setQuery(focusRequest.focus?.query ?? '')
    setFocusedReservationId(focusRequest.focus?.objectId ?? '')
  }, [focusRequest])

  const tables = data.tables
  const config = response.config
  const enabledSources = config?.sources.filter((item) => item.enabled).toSorted((a, b) => a.sortOrder - b.sortOrder) ?? []
  const enabledAreas = config?.areaPreferences.filter((item) => item.enabled).toSorted((a, b) => a.sortOrder - b.sortOrder) ?? []
  const enabledOccasions = config?.occasions.filter((item) => item.enabled) ?? []
  const defaultSourceCode = enabledSources[0]?.code ?? ''

  useEffect(() => {
    if (!draft.sourceCode && defaultSourceCode) {
      setDraft((current) => ({ ...current, sourceCode: defaultSourceCode }))
    }
  }, [defaultSourceCode, draft.sourceCode])

  useEffect(() => {
    if (!draft.salesEmployeeId && salesEmployees.length > 0) {
      setDraft((current) => ({ ...current, salesEmployeeId: salesEmployees.find((item) => item.id === actorId)?.id ?? salesEmployees[0]!.id }))
    }
  }, [actorId, draft.salesEmployeeId, salesEmployees])

  const reservations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
    return response.reservations
      .filter((reservation) => reservationInBusinessDateRange(
        reservation.scheduledAt,
        dateRange,
        data.store.businessDate,
        businessDayRolloverHour,
      ))
      .filter((reservation) => statusFilter === 'all' || reservation.status === statusFilter)
      .filter((reservation) => !normalizedQuery || [
        reservation.customerName,
        reservation.contactReference,
        reservation.tableCode ?? '',
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery)))
      .toSorted((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))
  }, [businessDayRolloverHour, data.store.businessDate, dateRange, query, response.reservations, statusFilter])

  useEffect(() => {
    if (!focusedReservationId || loading || !reservations.some((reservation) => reservation.id === focusedReservationId)) return
    window.requestAnimationFrame(() => document.getElementById(`reservation-${focusedReservationId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }, [focusedReservationId, loading, reservations])
  const salesByReservation = new Map<string, string>()
  for (const record of data.salesAttributionRecords ?? []) {
    if (record.subjectType === 'reservation') salesByReservation.set(record.subjectId, record.salesEmployeeId)
  }

  const metrics = useMemo(() => ({
    today: response.reservations.filter((item) => reservationInBusinessDateRange(
      item.scheduledAt,
      'today',
      data.store.businessDate,
      businessDayRolloverHour,
    )).length,
    requested: response.reservations.filter((item) => item.status === 'requested').length,
    arriving: response.reservations.filter((item) => item.status === 'confirmed' && Date.parse(item.scheduledAt) <= Date.now() + 2 * 60 * 60 * 1000).length,
    refunds: response.reservations.filter((item) => ['refund_required', 'refund_processing', 'refund_failed'].includes(item.deposit.status)).length,
  }), [businessDayRolloverHour, data.store.businessDate, response.reservations])

  async function execute(actionKey: string, successMessage: string, action: () => Promise<unknown>) {
    setBusyAction(actionKey)
    setNotice(null)
    try {
      await action()
      await load(false, true)
      setNotice({ tone: 'success', message: successMessage })
      closeOperation()
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error, '预约操作失败，请重试') })
    } finally {
      setBusyAction('')
    }
  }

  function submitCreate(event: FormEvent) {
    event.preventDefault()
    if (!draft.customerName.trim() || !draft.customerReference.trim() || (!draft.phone.trim() && !draft.wechatId.trim()) || !draft.sourceCode || !draft.scheduledAt || !draft.salesEmployeeId) {
      setNotice({ tone: 'error', message: '请填写客人姓名、顾客ID、手机号或微信号、来源、预约时间和销售归属' })
      return
    }
    if (draft.phone.trim() && !/^1\d{10}$/.test(draft.phone.trim())) {
      setNotice({ tone: 'error', message: '手机号需填写11位中国大陆号码' })
      return
    }
    const depositAmount = Math.round(Number(draft.depositYuan) * 100)
    if (!Number.isFinite(depositAmount) || depositAmount < 0) {
      setNotice({ tone: 'error', message: '定金金额必须是大于或等于0的数字' })
      return
    }
    void execute('create', '预约已创建，进入待确认队列', async () => {
      const created = await createReservation({
        customerReference: draft.customerReference.trim(),
        customerName: draft.customerName.trim(),
        phone: draft.phone.trim() || undefined,
        wechatId: draft.wechatId.trim() || undefined,
        sourceCode: draft.sourceCode,
        partySize: draft.partySize,
        areaPreferenceCode: draft.areaPreferenceCode || undefined,
        occasionCode: draft.occasionCode || undefined,
        occasionNote: draft.occasionNote.trim() || undefined,
        scheduledAt: chinaLocalDateTimeToIso(draft.scheduledAt),
        depositRequiredAmount: depositAmount,
        depositCurrency: 'CNY',
        salesEmployeeId: draft.salesEmployeeId,
        idempotencyKey: idempotencyKey('create'),
      })
      downloadReservationCard(created, config)
      setDraft(createEmptyDraft(draft.salesEmployeeId))
      setShowCreate(false)
    })
  }

  function openConfig() {
    if (!config) return
    setConfigDraft(configWriteDraft(config))
    setConfigReason('')
    setShowConfig(true)
    setShowCreate(false)
  }

  function closeConfig() {
    setShowConfig(false)
    setConfigDraft(null)
    setConfigReason('')
  }

  function submitConfig(event: FormEvent) {
    event.preventDefault()
    if (!configDraft || !config) return
    const normalized = normalizeConfigDraft(configDraft)
    const validationError = validateConfigDraft(normalized, configReason)
    if (validationError) {
      setNotice({ tone: 'error', message: validationError })
      return
    }
    void execute('config', `预约规则已保存为V${config.version + 1}`, async () => {
      await updateReservationConfig({
        config: normalized,
        reason: configReason.trim(),
        idempotencyKey: idempotencyKey('config'),
      })
      closeConfig()
    })
  }

  function quickAction(reservation: Reservation, action: 'confirm' | 'arrive') {
    const label = action === 'confirm' ? '预约已确认' : '已记录客人到店'
    void execute(`${action}:${reservation.id}`, label, () => actOnReservation(reservation.id, {
      action,
      idempotencyKey: idempotencyKey(action),
    }))
  }

  function openOperation(type: OperationType, reservation: Reservation) {
    setOperation({ type, reservation })
    setReference(defaultPrimaryReference(type, reservation))
    setSecondaryReference('')
    setReason('')
    setSelectedTableId(tables.find((table) => ['available', 'reserved'].includes(table.status))?.id ?? '')
    setSelectedSalesEmployeeId(salesByReservation.get(reservation.id) ?? '')
    setEditPartySize(reservation.partySize)
    setEditScheduledAt(chinaDateTimeLocalValue(reservation.scheduledAt))
    setEditAreaCode(reservation.areaPreferenceCode ?? '')
    if (type === 'late_hold' || type === 'late_release') {
      setReference(reservation.lateContactReference ?? '')
      const expected = reservation.expectedArrivalAt
        ? new Date(reservation.expectedArrivalAt)
        : new Date(Math.max(Date.now(), Date.parse(reservation.scheduledAt)) + 20 * 60_000)
      setSecondaryReference(chinaDateTimeLocalValue(expected))
      setReason(type === 'late_hold' ? '顾客已联系并确认在途' : '超过保留时间，释放桌位')
    }
  }

  function closeOperation() {
    setOperation(null)
    setReference('')
    setSecondaryReference('')
    setSelectedSalesEmployeeId('')
    setReason('')
  }

  function submitOperation(event: FormEvent) {
    event.preventDefault()
    if (!operation) return
    const reservation = operation.reservation
    const key = `${operation.type}:${reservation.id}`
    const ref = reference.trim()
    const secondary = secondaryReference.trim()
    const note = reason.trim()

    if (operation.type === 'sales') {
      if (!selectedSalesEmployeeId || !note) return setNotice({ tone: 'error', message: '请选择销售并填写变更原因' })
      void execute(key, '预约销售归属已更新并写入审计', () => assignReservationSales(reservation.id, {
        salesEmployeeId: selectedSalesEmployeeId,
        reason: note,
        idempotencyKey: idempotencyKey('sales-attribution'),
      }))
      return
    }

    if (operation.type === 'edit') {
      if (!editScheduledAt || !note) return setNotice({ tone: 'error', message: '请确认人数、时间并填写修改原因' })
      void execute(key, '预约人数和时间已更新', () => updateReservationDetails(reservation.id, {
        partySize: editPartySize,
        scheduledAt: chinaLocalDateTimeToIso(editScheduledAt),
        areaPreferenceCode: editAreaCode || undefined,
        reason: note,
        idempotencyKey: idempotencyKey('update-details'),
      }))
      return
    }
    if (operation.type === 'late_hold' || operation.type === 'late_release') {
      if (!ref || !secondary || !note) return setNotice({ tone: 'error', message: '请填写预计到店时间、联系记录和决定原因' })
      void execute(key, operation.type === 'late_hold' ? '迟到保留决定已记录' : '预约桌位已释放', () => decideLateReservationHold(reservation.id, {
        decision: operation.type === 'late_hold' ? 'hold' : 'release',
        expectedArrivalAt: chinaLocalDateTimeToIso(secondary),
        contactReference: ref,
        reason: note,
        idempotencyKey: idempotencyKey(operation.type),
      }))
      return
    }

    if (operation.type === 'deposit_intent') {
      if (!ref) return setNotice({ tone: 'error', message: '请填写外部支付单号' })
      void execute(key, '定金支付单已登记，等待外部到账确认', () => recordDepositIntent(reservation.id, {
        paymentIntentReference: ref,
        idempotencyKey: idempotencyKey('deposit-intent'),
      }))
      return
    }
    if (operation.type === 'deposit_confirm') {
      if (!secondary) return setNotice({ tone: 'error', message: '请填写外部支付确认流水号' })
      void execute(key, '定金到账已确认，可以确认预约', () => confirmDeposit(reservation.id, {
        paymentIntentReference: reservation.deposit.paymentIntentReference ?? ref,
        paymentConfirmationReference: secondary,
        confirmedAmount: reservation.deposit.requiredAmount,
        currency: reservation.deposit.currency,
        idempotencyKey: idempotencyKey('deposit-confirm'),
      }))
      return
    }
    if (operation.type === 'seat') {
      const table = tables.find((item) => item.id === selectedTableId)
      if (!table) return setNotice({ tone: 'error', message: '请选择入座桌台' })
      void execute(key, `客人已安排至${table.code}`, () => actOnReservation(reservation.id, {
        action: 'seat',
        tableId: table.id,
        idempotencyKey: idempotencyKey('seat'),
      }))
      return
    }
    if (operation.type === 'cancel' || operation.type === 'no_show') {
      if (!note) return setNotice({ tone: 'error', message: '请填写原因，便于交接和复盘' })
      const action = operation.type === 'cancel' ? 'cancel' : 'no_show'
      void execute(key, action === 'cancel' ? '预约已取消' : '已标记客人未到店', () => actOnReservation(reservation.id, {
        action,
        reason: note,
        idempotencyKey: idempotencyKey(action),
      }))
      return
    }
    if (operation.type === 'refund_start') {
      if (!ref) return setNotice({ tone: 'error', message: '请填写退款请求单号' })
      void execute(key, '定金退款已发起，等待渠道确认', () => startDepositRefund(reservation.id, {
        refundRequestReference: ref,
        idempotencyKey: idempotencyKey('refund-start'),
      }))
      return
    }
    const refundReference = reservation.deposit.refundRequestReference ?? ref
    if (operation.type === 'refund_complete') {
      if (!secondary) return setNotice({ tone: 'error', message: '请填写渠道退款确认流水号' })
      void execute(key, '定金退款已确认完成', () => confirmDepositRefund(reservation.id, {
        refundRequestReference: refundReference,
        refundConfirmationReference: secondary,
        refundedAmount: reservation.deposit.requiredAmount,
        currency: reservation.deposit.currency,
        idempotencyKey: idempotencyKey('refund-complete'),
      }))
      return
    }
    if (!note) return setNotice({ tone: 'error', message: '请填写退款失败原因' })
    void execute(key, '退款失败已记录，可重新发起', () => failDepositRefund(reservation.id, {
      refundRequestReference: refundReference,
      reason: note,
      idempotencyKey: idempotencyKey('refund-fail'),
    }))
  }

  return (
    <section className="reservation-view">
      <header className="reservation-heading">
        <div><span className="eyebrow">到店前确认、定金与接待衔接</span><h2>预约接待台</h2></div>
        <div className="reservation-heading-actions">
          <button className="icon-button" type="button" title="刷新预约" disabled={loading || Boolean(busyAction)} onClick={() => void load()}>
            <RefreshCw className={loading ? 'reservation-spin' : ''} size={17} />
          </button>
          {access.configure && <button className="secondary-button" type="button" disabled={!config || Boolean(busyAction)} onClick={showConfig ? closeConfig : openConfig}>
            {showConfig ? <X size={17} /> : <Settings2 size={17} />}{showConfig ? '关闭配置' : '经理配置'}
          </button>}
          {access.manage && <button className="primary-button" type="button" onClick={() => { setShowCreate((current) => !current); closeConfig() }}>
            {showCreate ? <X size={17} /> : <Plus size={17} />}{showCreate ? '关闭创建' : '新建预约'}
          </button>}
        </div>
      </header>

      {notice && <div className={`reservation-notice is-${notice.tone}`} role="status">
        {notice.tone === 'success' ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
        <span>{notice.message}</span>
        <button type="button" title="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button>
      </div>}

      <WaitlistPanel areas={data.areas} tables={tables} employees={salesEmployees} canManage={access.manage} />

      <section className="reservation-metrics" aria-label="预约概览">
        <Metric icon={CalendarDays} value={String(metrics.today)} label="本营业日预约" />
        <Metric icon={Clock3} value={String(metrics.requested)} label="待确认" />
        <Metric icon={UserCheck} value={String(metrics.arriving)} label="两小时内待到店" />
        <Metric icon={RotateCcw} value={String(metrics.refunds)} label="定金退款待办" warning={metrics.refunds > 0} />
      </section>

      {config && <div className="reservation-rule-summary" aria-label="当前预约规则">
        <span><Settings2 size={15} /><strong>版本</strong>V{config.version}</span>
        <span><UsersRound size={15} /><strong>人数</strong>{config.minimumPartySize}-{config.maximumPartySize}人</span>
        <span><Clock3 size={15} /><strong>迟到保留</strong>{config.lateHoldMinutes}分钟</span>
        <span><Search size={15} /><strong>来源</strong>{enabledSources.map((item) => item.name).join('、') || '未配置'}</span>
        <span><CalendarClock size={15} /><strong>场景</strong>{enabledOccasions.map((item) => item.name).join('、') || '未配置'}</span>
        <span><Banknote size={15} /><strong>定金</strong>{config.depositPolicy.enabled ? '按区域自动计算' : '未开启'}</span>
      </div>}

      {showConfig && configDraft && config && <div className="reveal-panel-target" ref={configPanelRef}><ReservationConfigPanel
        currentVersion={config.version}
        draft={configDraft}
        reason={configReason}
        busy={busyAction === 'config'}
        onChange={setConfigDraft}
        onReasonChange={setConfigReason}
        onClose={closeConfig}
        onSubmit={submitConfig}
      /></div>}

      {showCreate && <form className="reservation-create reveal-panel-target" ref={createPanelRef} onSubmit={submitCreate}>
        <div className="reservation-section-title"><Plus size={18} /><div><span>人工录入</span><h3>创建预约</h3></div></div>
        <div className="reservation-form-grid">
          <Field label="客人姓名"><input required maxLength={100} value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} /></Field>
          <Field label="顾客ID（支持中文）"><input required maxLength={128} autoComplete="off" placeholder="例如 李先生0720 / 企业客户A" value={draft.customerReference} onChange={(event) => setDraft({ ...draft, customerReference: event.target.value })} /></Field>
          <Field label="联系电话"><input inputMode="tel" maxLength={11} placeholder="电话预约建议必填" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value.replace(/\D/g, '').slice(0, 11) })} /></Field>
          <Field label="微信号"><input maxLength={80} placeholder="手机号、微信号至少填一项" value={draft.wechatId} onChange={(event) => setDraft({ ...draft, wechatId: event.target.value })} /></Field>
          <Field label="预约时间（北京时间）"><input required type="datetime-local" value={draft.scheduledAt} onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} /></Field>
          <Field label="人数"><input required type="number" min={config?.minimumPartySize ?? 1} max={config?.maximumPartySize ?? 100} value={draft.partySize} onChange={(event) => setDraft({ ...draft, partySize: Number(event.target.value) })} /></Field>
          <Field label="来源"><select required value={draft.sourceCode} onChange={(event) => setDraft({ ...draft, sourceCode: event.target.value })}><option value="">请选择</option>{enabledSources.map((source) => <option key={source.code} value={source.code}>{source.name}</option>)}</select></Field>
          <Field label="销售归属"><select required value={draft.salesEmployeeId} onChange={(event) => setDraft({ ...draft, salesEmployeeId: event.target.value })}><option value="">请选择销售</option>{salesEmployees.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field>
          <Field label="区域偏好"><select value={draft.areaPreferenceCode} onChange={(event) => setDraft({ ...draft, areaPreferenceCode: event.target.value })}><option value="">无指定</option>{enabledAreas.map((area) => <option key={area.code} value={area.code}>{area.name}</option>)}</select></Field>
          <Field label="到店场景"><select value={draft.occasionCode} onChange={(event) => setDraft({ ...draft, occasionCode: event.target.value as CreateDraft['occasionCode'] })}><option value="">普通到店</option>{enabledOccasions.map((occasion) => <option key={occasion.code} value={occasion.code}>{occasion.name}</option>)}</select></Field>
          <Field label="定金（元）"><input type="number" min={0} step="0.01" disabled={config?.depositPolicy.enabled} value={config?.depositPolicy.enabled ? String(depositRuleForDraft(config, draft.areaPreferenceCode).depositAmount / 100) : draft.depositYuan} onChange={(event) => setDraft({ ...draft, depositYuan: event.target.value })} /></Field>
          {config?.depositPolicy.enabled && <div className="reservation-deposit-preview"><Banknote size={16} /><span>此位置定金 <b>{money(depositRuleForDraft(config, draft.areaPreferenceCode).depositAmount)}</b> · 可抵消费 {(depositRuleForDraft(config, draft.areaPreferenceCode).deductibleRateBps / 100).toFixed(0)}% · 低消 {money(depositRuleForDraft(config, draft.areaPreferenceCode).minimumSpendAmount)}</span></div>}
          <Field label="接待备注" wide><input maxLength={500} placeholder="生日称呼、座位要求或其他交接事项" value={draft.occasionNote} onChange={(event) => setDraft({ ...draft, occasionNote: event.target.value })} /></Field>
          <button className="primary-button" type="submit" disabled={Boolean(busyAction) || !config}>
            {busyAction === 'create' ? <LoaderCircle className="reservation-spin" size={17} /> : <Check size={17} />}保存预约
          </button>
        </div>
      </form>}

      {operation && <div className="reveal-panel-target" ref={operationPanelRef}><OperationPanel
        operation={operation}
        tables={tables}
        selectedTableId={selectedTableId}
        reference={reference}
        secondaryReference={secondaryReference}
        reason={reason}
        config={config}
        editPartySize={editPartySize}
        editScheduledAt={editScheduledAt}
        editAreaCode={editAreaCode}
        employees={salesEmployees}
        selectedSalesEmployeeId={selectedSalesEmployeeId}
        busy={Boolean(busyAction)}
        onTableChange={setSelectedTableId}
        onReferenceChange={setReference}
        onSecondaryReferenceChange={setSecondaryReference}
        onReasonChange={setReason}
        onEditPartySize={setEditPartySize}
        onEditScheduledAt={setEditScheduledAt}
        onEditAreaCode={setEditAreaCode}
        onSalesEmployeeChange={setSelectedSalesEmployeeId}
        onClose={closeOperation}
        onSubmit={submitOperation}
      /></div>}

      <section className="reservation-list-section">
        <div className="reservation-toolbar">
          <div className="reservation-tabs" aria-label="预约日期范围">
            {([['today', '本营业日'], ['upcoming', '未来7个营业日'], ['all', '全部']] as const).map(([id, label]) => <button key={id} className={dateRange === id ? 'is-active' : ''} type="button" onClick={() => setDateRange(id)}>{label}</button>)}
          </div>
          <label className="reservation-search"><Search size={16} /><input aria-label="搜索预约" placeholder="姓名、客户编号、桌号" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <select className="reservation-status-filter" aria-label="预约状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <div className="reservation-list" aria-busy={loading}>
          {loading && <div className="reservation-empty"><LoaderCircle className="reservation-spin" size={22} />正在加载预约</div>}
          {!loading && reservations.length === 0 && <div className="reservation-empty"><CalendarClock size={22} />当前筛选条件下没有预约</div>}
          {!loading && reservations.map((reservation) => <ReservationRow
            key={reservation.id}
            reservation={reservation}
            focused={reservation.id === focusedReservationId}
            salesName={data.employees.find((employee) => employee.id === salesByReservation.get(reservation.id))?.displayName ?? '未指定销售'}
            access={access}
            busyAction={busyAction}
            onQuickAction={quickAction}
            onOpenOperation={openOperation}
            onSaveCard={(item) => downloadReservationCard(item, config)}
          />)}
        </div>
      </section>
    </section>
  )
}

function ReservationConfigPanel({ currentVersion, draft, reason, busy, onChange, onReasonChange, onClose, onSubmit }: {
  currentVersion: number
  draft: ConfigDraft
  reason: string
  busy: boolean
  onChange: (draft: ConfigDraft) => void
  onReasonChange: (reason: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const [existingSourceCount] = useState(draft.sources.length)
  const [existingAreaCount] = useState(draft.areaPreferences.length)

  function updateSource(index: number, patch: Partial<ConfigDraft['sources'][number]>) {
    onChange({ ...draft, sources: draft.sources.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  }

  function updateArea(index: number, patch: Partial<ConfigDraft['areaPreferences'][number]>) {
    onChange({ ...draft, areaPreferences: draft.areaPreferences.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  }

  function updateOccasion(index: number, patch: Partial<ConfigDraft['occasions'][number]>) {
    onChange({ ...draft, occasions: draft.occasions.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
  }

  function addSource() {
    onChange({
      ...draft,
      sources: [...draft.sources, { code: '', name: '', enabled: true, sortOrder: nextSortOrder(draft.sources) }],
    })
  }

  function addArea() {
    onChange({
      ...draft,
      areaPreferences: [...draft.areaPreferences, { code: '', name: '', enabled: true, sortOrder: nextSortOrder(draft.areaPreferences) }],
    })
  }

  function updateDateOverride(index: number, patch: Partial<ConfigDraft['capacity']['dateOverrides'][number]>) {
    onChange({ ...draft, capacity: { ...draft.capacity, dateOverrides: draft.capacity.dateOverrides.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) } })
  }

  function toggleClosedWeekday(day: number) {
    const closedWeekdays = draft.businessHours.closedWeekdays.includes(day)
      ? draft.businessHours.closedWeekdays.filter((item) => item !== day)
      : [...draft.businessHours.closedWeekdays, day].toSorted((left, right) => left - right)
    onChange({ ...draft, businessHours: { ...draft.businessHours, closedWeekdays } })
  }

  function toggleContactMethod(method: 'phone' | 'wechat') {
    const acceptedContactMethods = draft.publicRules.acceptedContactMethods.includes(method)
      ? draft.publicRules.acceptedContactMethods.filter((item) => item !== method)
      : [...draft.publicRules.acceptedContactMethods, method]
    onChange({ ...draft, publicRules: { ...draft.publicRules, acceptedContactMethods } })
  }

  function updateDepositAreaRule(areaPreferenceCode: string, patch: Partial<ConfigDraft['depositPolicy']['areaRules'][number]>) {
    const existing = draft.depositPolicy.areaRules.find((item) => item.areaPreferenceCode === areaPreferenceCode)
    const next = existing
      ? draft.depositPolicy.areaRules.map((item) => item.areaPreferenceCode === areaPreferenceCode ? { ...item, ...patch } : item)
      : [...draft.depositPolicy.areaRules, {
          areaPreferenceCode,
          depositAmount: draft.depositPolicy.defaultDepositAmount,
          minimumSpendAmount: draft.depositPolicy.defaultMinimumSpendAmount,
          deductibleRateBps: draft.depositPolicy.defaultDeductibleRateBps,
          customerNotice: '',
          ...patch,
        }]
    onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, areaRules: next } })
  }

  return <form className="reservation-config-panel" onSubmit={onSubmit}>
    <header className="reservation-config-heading">
      <div><Settings2 size={19} /><span><small>经理权限</small><strong>预约规则配置</strong></span></div>
      <span className="reservation-config-version">当前 V{currentVersion} · 保存后 V{currentVersion + 1}</span>
    </header>

    <section className="reservation-config-general">
      <div className="reservation-config-section-title"><strong>人数范围</strong><span>用于创建预约时的前端和服务端约束</span></div>
      <Field label="最少人数"><input required type="number" min={1} max={100} value={draft.minimumPartySize} onChange={(event) => onChange({ ...draft, minimumPartySize: Number(event.target.value) })} /></Field>
      <Field label="最多人数"><input required type="number" min={1} max={100} value={draft.maximumPartySize} onChange={(event) => onChange({ ...draft, maximumPartySize: Number(event.target.value) })} /></Field>
      <Field label="迟到保留（分钟）"><input required type="number" min={0} max={240} value={draft.lateHoldMinutes} onChange={(event) => onChange({ ...draft, lateHoldMinutes: Number(event.target.value) })} /></Field>
      <Field label="候补响应（分钟）"><input required type="number" min={1} max={120} value={draft.waitlistResponseMinutes} onChange={(event) => onChange({ ...draft, waitlistResponseMinutes: Number(event.target.value) })} /></Field>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>预约定金与位置低消</strong><span>开启后由系统按区域自动计算，员工不能随意改金额</span></div>
      <div className="reservation-config-choice-row"><span>定金模式</span><label><input type="checkbox" checked={draft.depositPolicy.enabled} onChange={(event) => onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, enabled: event.target.checked } })} />{draft.depositPolicy.enabled ? '已开启' : '未开启'}</label></div>
      <div className="reservation-config-business-grid is-rules">
        <Field label="默认定金（元）"><input type="number" min={0} step="0.01" value={draft.depositPolicy.defaultDepositAmount / 100} onChange={(event) => onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, defaultDepositAmount: Math.max(0, Math.round(Number(event.target.value) * 100)) } })} /></Field>
        <Field label="默认低消（元）"><input type="number" min={0} step="0.01" value={draft.depositPolicy.defaultMinimumSpendAmount / 100} onChange={(event) => onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, defaultMinimumSpendAmount: Math.max(0, Math.round(Number(event.target.value) * 100)) } })} /></Field>
        <Field label="默认可抵消费（%）"><input type="number" min={0} max={100} step={1} value={draft.depositPolicy.defaultDeductibleRateBps / 100} onChange={(event) => onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, defaultDeductibleRateBps: Math.max(0, Math.min(10_000, Math.round(Number(event.target.value) * 100))) } })} /></Field>
      </div>
      <Field label="顾客提示" wide><input required maxLength={300} value={draft.depositPolicy.customerNotice} onChange={(event) => onChange({ ...draft, depositPolicy: { ...draft.depositPolicy, customerNotice: event.target.value } })} /></Field>
      <div className="reservation-deposit-rule-list">
        {draft.areaPreferences.filter((area) => area.enabled).map((area) => {
          const rule = draft.depositPolicy.areaRules.find((item) => item.areaPreferenceCode === area.code) ?? {
            areaPreferenceCode: area.code,
            depositAmount: draft.depositPolicy.defaultDepositAmount,
            minimumSpendAmount: draft.depositPolicy.defaultMinimumSpendAmount,
            deductibleRateBps: draft.depositPolicy.defaultDeductibleRateBps,
            customerNotice: '',
          }
          return <div className="reservation-deposit-rule" key={area.code}>
            <strong>{area.name}</strong>
            <Field label="定金（元）"><input type="number" min={0} step="0.01" value={rule.depositAmount / 100} onChange={(event) => updateDepositAreaRule(area.code, { depositAmount: Math.max(0, Math.round(Number(event.target.value) * 100)) })} /></Field>
            <Field label="低消（元）"><input type="number" min={0} step="0.01" value={rule.minimumSpendAmount / 100} onChange={(event) => updateDepositAreaRule(area.code, { minimumSpendAmount: Math.max(0, Math.round(Number(event.target.value) * 100)) })} /></Field>
            <Field label="抵扣（%）"><input type="number" min={0} max={100} value={rule.deductibleRateBps / 100} onChange={(event) => updateDepositAreaRule(area.code, { deductibleRateBps: Math.max(0, Math.min(10_000, Math.round(Number(event.target.value) * 100))) })} /></Field>
          </div>
        })}
      </div>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>公开预约营业时间</strong><span>M-BOX默认12:00营业、次日02:00结束；20:30后的演出排班单独管理</span></div>
      <div className="reservation-config-business-grid">
        <Field label="门店时区"><input required maxLength={80} value={draft.businessHours.timeZone} onChange={(event) => onChange({ ...draft, businessHours: { ...draft.businessHours, timeZone: event.target.value } })} /></Field>
        <Field label="开始"><input required type="time" value={draft.businessHours.openingTime} onChange={(event) => onChange({ ...draft, businessHours: { ...draft.businessHours, openingTime: event.target.value } })} /></Field>
        <Field label="结束"><input required type="time" value={draft.businessHours.closingTime} onChange={(event) => onChange({ ...draft, businessHours: { ...draft.businessHours, closingTime: event.target.value } })} /></Field>
        <Field label="时段（分钟）"><input required type="number" min={5} max={240} value={draft.businessHours.slotMinutes} onChange={(event) => onChange({ ...draft, businessHours: { ...draft.businessHours, slotMinutes: Number(event.target.value) } })} /></Field>
      </div>
      <div className="reservation-config-choice-row"><span>每周闭店</span>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, day) => <label key={label}><input type="checkbox" checked={draft.businessHours.closedWeekdays.includes(day)} onChange={() => toggleClosedWeekday(day)} />{label}</label>)}</div>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>容量与公开规则</strong><span>容量按预约笔数计算；指定日期可闭店或覆盖总量</span></div>
      <div className="reservation-config-business-grid is-rules">
        <Field label="每日容量"><input required type="number" min={1} max={10_000} value={draft.capacity.defaultDailyCapacity} onChange={(event) => onChange({ ...draft, capacity: { ...draft.capacity, defaultDailyCapacity: Number(event.target.value) } })} /></Field>
        <Field label="每时段容量"><input required type="number" min={1} max={1_000} value={draft.capacity.defaultSlotCapacity} onChange={(event) => onChange({ ...draft, capacity: { ...draft.capacity, defaultSlotCapacity: Number(event.target.value) } })} /></Field>
        <Field label="至少提前（分钟）"><input required type="number" min={0} max={10_080} value={draft.publicRules.minimumLeadMinutes} onChange={(event) => onChange({ ...draft, publicRules: { ...draft.publicRules, minimumLeadMinutes: Number(event.target.value) } })} /></Field>
        <Field label="最远预约（天）"><input required type="number" min={1} max={730} value={draft.publicRules.maximumAdvanceDays} onChange={(event) => onChange({ ...draft, publicRules: { ...draft.publicRules, maximumAdvanceDays: Number(event.target.value) } })} /></Field>
        <Field label="防重复窗口（分钟）"><input required type="number" min={0} max={1_440} value={draft.publicRules.duplicateWindowMinutes} onChange={(event) => onChange({ ...draft, publicRules: { ...draft.publicRules, duplicateWindowMinutes: Number(event.target.value) } })} /></Field>
        <Field label="限流次数"><input required type="number" min={1} max={100} value={draft.publicRules.createRateLimit.limit} onChange={(event) => onChange({ ...draft, publicRules: { ...draft.publicRules, createRateLimit: { ...draft.publicRules.createRateLimit, limit: Number(event.target.value) } } })} /></Field>
        <Field label="限流窗口（分钟）"><input required type="number" min={1} max={1_440} value={draft.publicRules.createRateLimit.windowMinutes} onChange={(event) => onChange({ ...draft, publicRules: { ...draft.publicRules, createRateLimit: { ...draft.publicRules.createRateLimit, windowMinutes: Number(event.target.value) } } })} /></Field>
      </div>
      <div className="reservation-config-choice-row"><span>联系方式</span><label><input type="checkbox" checked={draft.publicRules.acceptedContactMethods.includes('phone')} onChange={() => toggleContactMethod('phone')} />手机号</label><label><input type="checkbox" checked={draft.publicRules.acceptedContactMethods.includes('wechat')} onChange={() => toggleContactMethod('wechat')} />微信号</label></div>
      <div className="reservation-config-section-title is-nested"><strong>指定日期</strong><span>时段覆盖格式：20:30=8，每行一个；0表示关闭该时段</span><button className="secondary-button" type="button" disabled={busy || draft.capacity.dateOverrides.length >= 366} onClick={() => onChange({ ...draft, capacity: { ...draft.capacity, dateOverrides: [...draft.capacity.dateOverrides, { date: '', enabled: true, totalCapacity: draft.capacity.defaultDailyCapacity, slotCapacities: [] }] } })}><Plus size={15} />新增日期</button></div>
      <div className="reservation-config-rows">
        {draft.capacity.dateOverrides.length === 0 && <div className="reservation-config-empty">没有特殊日期，使用默认容量</div>}
        {draft.capacity.dateOverrides.map((item, index) => <div className="reservation-config-date-row" key={`${item.date}-${index}`}>
          <Field label="日期"><input required type="date" value={item.date} onChange={(event) => updateDateOverride(index, { date: event.target.value })} /></Field>
          <Field label="当日总容量"><input required type="number" min={item.enabled ? 1 : 0} max={10_000} value={item.totalCapacity} onChange={(event) => updateDateOverride(index, { totalCapacity: Number(event.target.value) })} /></Field>
          <label className="reservation-script-field"><span>时段容量覆盖</span><textarea rows={2} placeholder="20:30=8" value={item.slotCapacities.map((slot) => `${slot.time}=${slot.capacity}`).join('\n')} onChange={(event) => updateDateOverride(index, { slotCapacities: parseSlotCapacityLines(event.target.value) })} /></label>
          <label className="reservation-config-toggle"><span>状态</span><input type="checkbox" checked={item.enabled} onChange={(event) => updateDateOverride(index, { enabled: event.target.checked, totalCapacity: event.target.checked ? Math.max(1, item.totalCapacity) : 0 })} /><b>{item.enabled ? '接预约' : '闭店'}</b></label>
          <button className="secondary-button reservation-config-remove" type="button" title="删除日期规则" onClick={() => onChange({ ...draft, capacity: { ...draft.capacity, dateOverrides: draft.capacity.dateOverrides.filter((_, itemIndex) => itemIndex !== index) } })}><X size={15} /></button>
        </div>)}
      </div>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>预约来源</strong><span>既有代码锁定，可停用并保留历史数据</span><button className="secondary-button" type="button" disabled={busy || draft.sources.length >= 50} onClick={addSource}><Plus size={15} />新增来源</button></div>
      <div className="reservation-config-rows">
        {draft.sources.map((item, index) => <div className="reservation-config-row" key={`${item.code || 'new-source'}-${index}`}>
          <Field label="代码"><input required maxLength={64} disabled={index < existingSourceCount} placeholder="例如 partner" value={item.code} onChange={(event) => updateSource(index, { code: normalizeCodeInput(event.target.value) })} /></Field>
          <Field label="显示名称"><input required maxLength={80} value={item.name} onChange={(event) => updateSource(index, { name: event.target.value })} /></Field>
          <label className="reservation-config-toggle"><span>状态</span><input type="checkbox" checked={item.enabled} onChange={(event) => updateSource(index, { enabled: event.target.checked })} /><b>{item.enabled ? '启用' : '停用'}</b></label>
        </div>)}
      </div>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>区域偏好</strong><span>用于预约偏好，不直接改变现场桌台布局</span><button className="secondary-button" type="button" disabled={busy || draft.areaPreferences.length >= 100} onClick={addArea}><Plus size={15} />新增区域</button></div>
      <div className="reservation-config-rows">
        {draft.areaPreferences.length === 0 && <div className="reservation-config-empty">暂未配置区域偏好</div>}
        {draft.areaPreferences.map((item, index) => <div className="reservation-config-row" key={`${item.code || 'new-area'}-${index}`}>
          <Field label="代码"><input required maxLength={64} disabled={index < existingAreaCount} placeholder="例如 window" value={item.code} onChange={(event) => updateArea(index, { code: normalizeCodeInput(event.target.value) })} /></Field>
          <Field label="显示名称"><input required maxLength={80} value={item.name} onChange={(event) => updateArea(index, { name: event.target.value })} /></Field>
          <label className="reservation-config-toggle"><span>状态</span><input type="checkbox" checked={item.enabled} onChange={(event) => updateArea(index, { enabled: event.target.checked })} /><b>{item.enabled ? '启用' : '停用'}</b></label>
        </div>)}
      </div>
    </section>

    <section className="reservation-config-section">
      <div className="reservation-config-section-title"><strong>到店场景与服务脚本</strong><span>每行一条服务动作，最多20条</span></div>
      <div className="reservation-occasion-list">
        {draft.occasions.map((item, index) => <div className="reservation-occasion-row" key={item.code}>
          <div className="reservation-occasion-identity"><code>{item.code}</code><label className="reservation-config-toggle"><input type="checkbox" checked={item.enabled} onChange={(event) => updateOccasion(index, { enabled: event.target.checked })} /><b>{item.enabled ? '启用' : '停用'}</b></label></div>
          <Field label="场景名称"><input required maxLength={80} value={item.name} onChange={(event) => updateOccasion(index, { name: event.target.value })} /></Field>
          <label className="reservation-script-field"><span>服务脚本</span><textarea rows={3} maxLength={3_220} placeholder="确认客人称呼与时间&#10;通知值班经理准备权益" value={item.serviceScript.join('\n')} onChange={(event) => updateOccasion(index, { serviceScript: event.target.value.split('\n') })} /></label>
        </div>)}
      </div>
    </section>

    <footer className="reservation-config-footer">
      <Field label="保存原因"><input required minLength={2} maxLength={500} placeholder="例如：新增企业微信预约来源并更新生日接待流程" value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field>
      <span>配置保存后立即对新预约生效，历史预约保留原配置版本。</span>
      <div><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="reservation-spin" size={16} /> : <Save size={16} />}保存为 V{currentVersion + 1}</button></div>
    </footer>
  </form>
}

function ReservationRow({ reservation, focused, salesName, access, busyAction, onQuickAction, onOpenOperation, onSaveCard }: {
  reservation: Reservation
  focused: boolean
  salesName: string
  access: ReservationAccess
  busyAction: string
  onQuickAction: (reservation: Reservation, action: 'confirm' | 'arrive') => void
  onOpenOperation: (type: OperationType, reservation: Reservation) => void
  onSaveCard: (reservation: Reservation) => void
}) {
  const canConfirm = reservation.status === 'requested' && ['not_required', 'payment_confirmed'].includes(reservation.deposit.status)
  const canNoShow = reservation.status === 'confirmed' && Date.parse(reservation.scheduledAt) <= Date.now()
  const source = reservation.sourceCode === 'phone' ? '电话' : reservation.sourceCode === 'wechat' ? '微信' : reservation.sourceCode === 'walk_in' ? '现场' : reservation.sourceCode
  return <article id={`reservation-${reservation.id}`} className={`reservation-row status-${reservation.status}${focused ? ' is-ai-focus' : ''}`}>
    <div className="reservation-time"><strong>{formatDay(reservation.scheduledAt)}</strong><b>{formatTime(reservation.scheduledAt)}</b><span>{relativeTime(reservation.scheduledAt)}</span></div>
    <div className="reservation-customer"><div><strong>{reservation.customerName}</strong><span>{reservation.partySize}人 · {source}</span></div><small>{displayCustomerReference(reservation.contactReference)}</small>{reservation.occasionNote && <p>{reservation.occasionNote}</p>}</div>
    <div className="reservation-placement"><span><MapPin size={13} />{reservation.tableCode ?? reservation.areaPreferenceCode ?? '区域待定'}</span><small><UserPlus size={12} />{salesName}</small>{reservation.occasionCode && <b>{occasionLabel(reservation.occasionCode)}</b>}</div>
    <div className="reservation-state"><span className={`reservation-status is-${reservation.status}`}>{statusLabels[reservation.status]}</span><small className={`deposit-status is-${reservation.deposit.status}`}>{depositLabels[reservation.deposit.status]}{reservation.deposit.requiredAmount > 0 ? ` · ${money(reservation.deposit.requiredAmount)}` : ''}</small></div>
    <fieldset className="reservation-actions" disabled={Boolean(busyAction)}>
      <ActionButton icon={ImageDown} label="保存预约卡" onClick={() => onSaveCard(reservation)} />
      {access.manage && ['requested', 'confirmed', 'arrived'].includes(reservation.status) && <ActionButton icon={RefreshCw} label="修改人数/时间" onClick={() => onOpenOperation('edit', reservation)} />}
      {access.manage && ['requested', 'confirmed', 'arrived', 'seated'].includes(reservation.status) && <ActionButton icon={UserPlus} label="变更销售" onClick={() => onOpenOperation('sales', reservation)} />}
      {access.manage && reservation.status === 'confirmed' && reservation.holdStatus !== 'held' && <ActionButton icon={Clock3} label="迟到保留" onClick={() => onOpenOperation('late_hold', reservation)} />}
      {access.manage && reservation.status === 'confirmed' && reservation.holdStatus === 'held' && <ActionButton icon={UserRoundX} label="释放保留" danger onClick={() => onOpenOperation('late_release', reservation)} />}
      {access.manage && reservation.deposit.status === 'payment_required' && <ActionButton icon={Banknote} label="登记支付单" onClick={() => onOpenOperation('deposit_intent', reservation)} />}
      {access.confirmDeposit && reservation.deposit.status === 'payment_intent_recorded' && <ActionButton icon={Banknote} label="确认定金到账" primary onClick={() => onOpenOperation('deposit_confirm', reservation)} />}
      {access.manage && canConfirm && <ActionButton icon={Check} label="确认预约" primary loading={busyAction === `confirm:${reservation.id}`} onClick={() => onQuickAction(reservation, 'confirm')} />}
      {access.manage && reservation.status === 'confirmed' && <ActionButton icon={UserCheck} label="确认到店" primary loading={busyAction === `arrive:${reservation.id}`} onClick={() => onQuickAction(reservation, 'arrive')} />}
      {access.manage && reservation.status === 'arrived' && <ActionButton icon={DoorOpen} label="安排入座" primary onClick={() => onOpenOperation('seat', reservation)} />}
      {access.manage && ['requested', 'confirmed', 'arrived'].includes(reservation.status) && <ActionButton icon={X} label="取消" onClick={() => onOpenOperation('cancel', reservation)} />}
      {access.manage && canNoShow && <ActionButton icon={UserRoundX} label="未到店" danger onClick={() => onOpenOperation('no_show', reservation)} />}
      {access.requestRefund && ['refund_required', 'refund_failed'].includes(reservation.deposit.status) && <ActionButton icon={RotateCcw} label={reservation.deposit.status === 'refund_failed' ? '重试退款' : '发起退款'} primary onClick={() => onOpenOperation('refund_start', reservation)} />}
      {reservation.deposit.status === 'refund_processing' && <>{access.approveRefund && <ActionButton icon={Check} label="确认退款" primary onClick={() => onOpenOperation('refund_complete', reservation)} />}{access.requestRefund && <ActionButton icon={CircleAlert} label="记录失败" danger onClick={() => onOpenOperation('refund_fail', reservation)} />}</>}
      {['seated', 'cancelled', 'no_show'].includes(reservation.status) && !['refund_required', 'refund_processing', 'refund_failed'].includes(reservation.deposit.status) && <span className="reservation-closed">流程已结束</span>}
    </fieldset>
  </article>
}

function OperationPanel({ operation, tables, selectedTableId, reference, secondaryReference, reason, config, editPartySize, editScheduledAt, editAreaCode, employees, selectedSalesEmployeeId, busy, onTableChange, onReferenceChange, onSecondaryReferenceChange, onReasonChange, onEditPartySize, onEditScheduledAt, onEditAreaCode, onSalesEmployeeChange, onClose, onSubmit }: {
  operation: Operation
  tables: Table[]
  selectedTableId: string
  reference: string
  secondaryReference: string
  reason: string
  config: ReservationConfig | null
  editPartySize: number
  editScheduledAt: string
  editAreaCode: string
  employees: Employee[]
  selectedSalesEmployeeId: string
  busy: boolean
  onTableChange: (value: string) => void
  onReferenceChange: (value: string) => void
  onSecondaryReferenceChange: (value: string) => void
  onReasonChange: (value: string) => void
  onEditPartySize: (value: number) => void
  onEditScheduledAt: (value: string) => void
  onEditAreaCode: (value: string) => void
  onSalesEmployeeChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const labels: Record<OperationType, string> = {
    edit: '修改人数与时间', sales: '变更销售归属', late_hold: '记录迟到并保留', late_release: '释放迟到预约', deposit_intent: '登记定金支付单', deposit_confirm: '确认定金到账', seat: '安排入座', cancel: '取消预约', no_show: '标记未到店', refund_start: '发起定金退款', refund_complete: '确认退款完成', refund_fail: '记录退款失败',
  }
  return <form className="reservation-operation" onSubmit={onSubmit}>
    <div className="operation-identity"><span>当前操作</span><strong>{labels[operation.type]}</strong><small>{operation.reservation.customerName} · {formatDateTime(operation.reservation.scheduledAt)}</small></div>
    {operation.type === 'seat' && <Field label="入座桌台"><select required value={selectedTableId} onChange={(event) => onTableChange(event.target.value)}><option value="">请选择桌台</option>{tables.map((table) => <option key={table.id} value={table.id} disabled={['occupied', 'paused'].includes(table.status)}>{table.code} · {table.displayName} · {table.status === 'available' ? '可用' : table.status === 'reserved' ? '已预留' : table.status === 'occupied' ? '使用中' : '暂停'}</option>)}</select></Field>}
    {operation.type === 'sales' && <><Field label="销售归属"><select required value={selectedSalesEmployeeId} onChange={(event) => onSalesEmployeeChange(event.target.value)}><option value="">请选择销售</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></Field><Field label="变更原因"><input required minLength={2} maxLength={300} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field></>}
    {operation.type === 'edit' && <><Field label="人数"><input required type="number" min={config?.minimumPartySize ?? 1} max={config?.maximumPartySize ?? 100} value={editPartySize} onChange={(event) => onEditPartySize(Number(event.target.value))} /></Field><Field label="预约时间（北京时间）"><input required type="datetime-local" value={editScheduledAt} onChange={(event) => onEditScheduledAt(event.target.value)} /></Field><div className="operation-area-picks"><span>区域偏好</span><button type="button" className={!editAreaCode ? 'is-active' : ''} onClick={() => onEditAreaCode('')}>不限</button>{config?.areaPreferences.filter((area) => area.enabled).map((area) => <button type="button" key={area.code} className={editAreaCode === area.code ? 'is-active' : ''} onClick={() => onEditAreaCode(area.code)}>{area.name}</button>)}</div><Field label="修改原因"><input required maxLength={500} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field></>}
    {(operation.type === 'late_hold' || operation.type === 'late_release') && <><Field label="预计到店（北京时间）"><input required type="datetime-local" value={secondaryReference} onChange={(event) => onSecondaryReferenceChange(event.target.value)} /></Field><Field label="联系记录"><input required maxLength={256} placeholder="企微消息或电话记录编号" value={reference} onChange={(event) => onReferenceChange(event.target.value)} /></Field><Field label="决定原因"><input required maxLength={500} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field></>}
    {operation.type === 'deposit_intent' && <Field label="外部支付单号"><input required autoFocus maxLength={256} value={reference} onChange={(event) => onReferenceChange(event.target.value)} /></Field>}
    {operation.type === 'deposit_confirm' && <><Field label="支付单号"><input disabled value={operation.reservation.deposit.paymentIntentReference ?? reference} /></Field><Field label="到账确认流水"><input required autoFocus maxLength={256} value={secondaryReference} onChange={(event) => onSecondaryReferenceChange(event.target.value)} /></Field></>}
    {operation.type === 'refund_start' && <Field label="退款请求单号"><input required autoFocus maxLength={256} value={reference} onChange={(event) => onReferenceChange(event.target.value)} /></Field>}
    {operation.type === 'refund_complete' && <><Field label="退款请求单号"><input disabled value={operation.reservation.deposit.refundRequestReference ?? reference} /></Field><Field label="退款确认流水"><input required autoFocus maxLength={256} value={secondaryReference} onChange={(event) => onSecondaryReferenceChange(event.target.value)} /></Field></>}
    {['cancel', 'no_show', 'refund_fail'].includes(operation.type) && <Field label={operation.type === 'refund_fail' ? '失败原因' : '操作原因'}><input required autoFocus maxLength={500} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field>}
    <div className="operation-summary">{operationHint(operation)}</div>
    <div className="operation-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>返回</button><button className={['cancel', 'no_show', 'refund_fail', 'late_release'].includes(operation.type) ? 'reservation-danger-button' : 'primary-button'} type="submit" disabled={busy}>{busy ? <LoaderCircle className="reservation-spin" size={16} /> : <Check size={16} />}确认提交</button></div>
  </form>
}

function Metric({ icon: Icon, value, label, warning = false }: { icon: typeof CalendarDays; value: string; label: string; warning?: boolean }) {
  return <div className={warning ? 'is-warning' : ''}><Icon size={19} /><strong>{value}</strong><span>{label}</span></div>
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={wide ? 'reservation-field is-wide' : 'reservation-field'}><span>{label}</span>{children}</label>
}

function ActionButton({ icon: Icon, label, primary = false, danger = false, loading = false, onClick }: { icon: typeof Check; label: string; primary?: boolean; danger?: boolean; loading?: boolean; onClick: () => void }) {
  return <button className={danger ? 'reservation-danger-button' : primary ? 'primary-button' : 'secondary-button'} type="button" disabled={loading} onClick={onClick}>{loading ? <LoaderCircle className="reservation-spin" size={15} /> : <Icon size={15} />}{label}</button>
}

function operationHint(operation: Operation) {
  const amount = money(operation.reservation.deposit.requiredAmount)
  if (operation.type === 'deposit_intent') return `登记外部支付意图，不代表${amount}已经到账。`
  if (operation.type === 'deposit_confirm') return `仅在支付渠道确认${amount}实际到账后提交。`
  if (operation.type === 'refund_start') return `该操作仅记录已向支付渠道发起${amount}退款。`
  if (operation.type === 'refund_complete') return `仅在支付渠道返回成功后确认${amount}已退回。`
  if (operation.type === 'refund_fail') return '记录真实失败原因后，系统会允许重新发起退款。'
  if (operation.type === 'sales') return '提交后保留原销售、现销售、操作人和原因，入座时传递到桌次。'
  if (operation.type === 'seat') return '桌台会与本次预约绑定，请确认现场桌台状态。'
  return '提交后会写入预约审计记录，请填写真实原因。'
}

function defaultPrimaryReference(type: OperationType, reservation: Reservation) {
  if (type === 'deposit_confirm') return reservation.deposit.paymentIntentReference ?? ''
  if (type === 'refund_complete' || type === 'refund_fail') return reservation.deposit.refundRequestReference ?? ''
  return ''
}

function configWriteDraft(config: ReservationConfig): ConfigDraft {
  return {
    minimumPartySize: config.minimumPartySize,
    maximumPartySize: config.maximumPartySize,
    lateHoldMinutes: config.lateHoldMinutes,
    waitlistResponseMinutes: config.waitlistResponseMinutes,
    sources: config.sources.map((item) => ({ ...item })),
    areaPreferences: config.areaPreferences.map((item) => ({ ...item })),
    occasions: config.occasions.map((item) => ({ ...item, serviceScript: [...item.serviceScript] })),
    businessHours: { ...config.businessHours, closedWeekdays: [...config.businessHours.closedWeekdays] },
    capacity: {
      ...config.capacity,
      dateOverrides: config.capacity.dateOverrides.map((item) => ({
        ...item, slotCapacities: item.slotCapacities.map((slot) => ({ ...slot })),
      })),
    },
    publicRules: {
      ...config.publicRules,
      acceptedContactMethods: [...config.publicRules.acceptedContactMethods],
      createRateLimit: { ...config.publicRules.createRateLimit },
    },
    depositPolicy: {
      ...config.depositPolicy,
      areaRules: config.depositPolicy.areaRules.map((item) => ({ ...item })),
    },
  }
}

function normalizeConfigDraft(draft: ConfigDraft): ConfigDraft {
  return {
    minimumPartySize: draft.minimumPartySize,
    maximumPartySize: draft.maximumPartySize,
    lateHoldMinutes: draft.lateHoldMinutes,
    waitlistResponseMinutes: draft.waitlistResponseMinutes,
    sources: draft.sources.map((item) => ({ ...item, code: item.code.trim(), name: item.name.trim() })),
    areaPreferences: draft.areaPreferences.map((item) => ({ ...item, code: item.code.trim(), name: item.name.trim() })),
    occasions: draft.occasions.map((item) => ({
      ...item,
      name: item.name.trim(),
      serviceScript: item.serviceScript.map((step) => step.trim()).filter(Boolean),
    })),
    businessHours: { ...draft.businessHours, timeZone: draft.businessHours.timeZone.trim(), closedWeekdays: [...draft.businessHours.closedWeekdays] },
    capacity: {
      ...draft.capacity,
      dateOverrides: draft.capacity.dateOverrides.map((item) => ({
        ...item, date: item.date.trim(), slotCapacities: item.slotCapacities.map((slot) => ({ ...slot, time: slot.time.trim() })),
      })),
    },
    publicRules: {
      ...draft.publicRules,
      acceptedContactMethods: [...draft.publicRules.acceptedContactMethods],
      createRateLimit: { ...draft.publicRules.createRateLimit },
    },
    depositPolicy: {
      ...draft.depositPolicy,
      customerNotice: draft.depositPolicy.customerNotice.trim(),
      areaRules: draft.depositPolicy.areaRules.map((item) => ({
        ...item,
        customerNotice: item.customerNotice.trim(),
      })),
    },
  }
}

function validateConfigDraft(draft: ConfigDraft, reason: string) {
  if (!Number.isInteger(draft.minimumPartySize) || draft.minimumPartySize < 1 || draft.minimumPartySize > 100) return '最少人数必须是1至100之间的整数'
  if (!Number.isInteger(draft.maximumPartySize) || draft.maximumPartySize < draft.minimumPartySize || draft.maximumPartySize > 300) return '最多人数必须是不小于最少人数且不超过300的整数'
  if (!Number.isInteger(draft.lateHoldMinutes) || draft.lateHoldMinutes < 0 || draft.lateHoldMinutes > 240) return '迟到保留时间必须是0至240分钟'
  if (!Number.isInteger(draft.waitlistResponseMinutes) || draft.waitlistResponseMinutes < 1 || draft.waitlistResponseMinutes > 120) return '候补响应时间必须是1至120分钟'
  if (!draft.businessHours.timeZone.trim()) return '门店时区不能为空'
  if (!/^\d{2}:\d{2}$/.test(draft.businessHours.openingTime) || !/^\d{2}:\d{2}$/.test(draft.businessHours.closingTime) || draft.businessHours.openingTime === draft.businessHours.closingTime) return '请填写有效且不同的营业开始、结束时间'
  if (!Number.isInteger(draft.businessHours.slotMinutes) || draft.businessHours.slotMinutes < 5 || draft.businessHours.slotMinutes > 240) return '预约时段必须是5至240分钟'
  if (!Number.isInteger(draft.capacity.defaultDailyCapacity) || draft.capacity.defaultDailyCapacity < 1 || draft.capacity.defaultDailyCapacity > 10_000) return '每日预约容量必须是1至10000'
  if (!Number.isInteger(draft.capacity.defaultSlotCapacity) || draft.capacity.defaultSlotCapacity < 1 || draft.capacity.defaultSlotCapacity > 1_000) return '每时段预约容量必须是1至1000'
  if (new Set(draft.capacity.dateOverrides.map((item) => item.date)).size !== draft.capacity.dateOverrides.length) return '指定日期不能重复'
  if (draft.capacity.dateOverrides.some((item) => !/^\d{4}-\d{2}-\d{2}$/.test(item.date))) return '请填写完整的指定日期'
  if (draft.capacity.dateOverrides.some((item) => !Number.isInteger(item.totalCapacity) || item.totalCapacity < (item.enabled ? 1 : 0) || item.totalCapacity > 10_000)) return '指定日期容量不合法'
  if (draft.capacity.dateOverrides.some((item) => item.slotCapacities.some((slot) => !/^\d{2}:\d{2}$/.test(slot.time) || !Number.isInteger(slot.capacity) || slot.capacity < 0 || slot.capacity > 1_000))) return '时段容量覆盖格式或数值不合法'
  if (!Number.isInteger(draft.publicRules.minimumLeadMinutes) || draft.publicRules.minimumLeadMinutes < 0 || draft.publicRules.minimumLeadMinutes > 10_080) return '预约提前时间不合法'
  if (!Number.isInteger(draft.publicRules.maximumAdvanceDays) || draft.publicRules.maximumAdvanceDays < 1 || draft.publicRules.maximumAdvanceDays > 730) return '最远预约天数不合法'
  if (!Number.isInteger(draft.publicRules.duplicateWindowMinutes) || draft.publicRules.duplicateWindowMinutes < 0 || draft.publicRules.duplicateWindowMinutes > 1_440) return '防重复时间窗口不合法'
  if (draft.publicRules.acceptedContactMethods.length < 1) return '手机号和微信号至少启用一种'
  if (!Number.isInteger(draft.publicRules.createRateLimit.limit) || draft.publicRules.createRateLimit.limit < 1 || draft.publicRules.createRateLimit.limit > 100) return '公开预约限流次数不合法'
  if (!Number.isInteger(draft.publicRules.createRateLimit.windowMinutes) || draft.publicRules.createRateLimit.windowMinutes < 1 || draft.publicRules.createRateLimit.windowMinutes > 1_440) return '公开预约限流窗口不合法'
  if (!draft.depositPolicy.customerNotice.trim()) return '请填写定金抵扣规则的顾客提示'
  if (!Number.isInteger(draft.depositPolicy.defaultDepositAmount) || draft.depositPolicy.defaultDepositAmount < 0) return '默认定金金额不合法'
  if (!Number.isInteger(draft.depositPolicy.defaultMinimumSpendAmount) || draft.depositPolicy.defaultMinimumSpendAmount < 0) return '默认低消金额不合法'
  if (!Number.isInteger(draft.depositPolicy.defaultDeductibleRateBps) || draft.depositPolicy.defaultDeductibleRateBps < 0 || draft.depositPolicy.defaultDeductibleRateBps > 10_000) return '默认定金抵扣比例不合法'
  if (new Set(draft.depositPolicy.areaRules.map((item) => item.areaPreferenceCode)).size !== draft.depositPolicy.areaRules.length) return '同一位置不能配置两条定金规则'
  if (draft.sources.length < 1 || draft.sources.length > 50) return '预约来源数量必须为1至50个'
  if (!draft.sources.some((item) => item.enabled)) return '至少需要启用一个预约来源'
  const sourceError = validateNamedCodes(draft.sources, '预约来源')
  if (sourceError) return sourceError
  if (draft.areaPreferences.length > 100) return '区域偏好不能超过100个'
  const areaError = validateNamedCodes(draft.areaPreferences, '区域偏好')
  if (areaError) return areaError
  if (draft.occasions.length < 1 || draft.occasions.length > 4) return '到店场景数量必须为1至4个'
  if (draft.occasions.some((item) => !item.name)) return '场景名称不能为空'
  if (draft.occasions.some((item) => item.serviceScript.length > 20)) return '每个场景最多配置20条服务脚本'
  if (draft.occasions.some((item) => item.serviceScript.some((step) => step.length > 160))) return '单条服务脚本不能超过160个字符'
  if (reason.trim().length < 2) return '请填写至少2个字符的保存原因'
  return ''
}

function parseSlotCapacityLines(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [time = '', capacity = ''] = line.split('=').map((item) => item.trim())
    return { time, capacity: Number(capacity) }
  })
}

function validateNamedCodes(items: Array<{ code: string; name: string }>, label: string) {
  if (items.some((item) => !item.code || !item.name)) return `${label}的代码和名称不能为空`
  if (new Set(items.map((item) => item.code)).size !== items.length) return `${label}代码不能重复`
  return ''
}

function nextSortOrder(items: Array<{ sortOrder: number }>) {
  return Math.min(10_000, Math.max(0, ...items.map((item) => item.sortOrder)) + 10)
}

function normalizeCodeInput(value: string) {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9_-]/g, '')
}

function displayCustomerReference(value: string) {
  const displayed = value.startsWith('staff-ref:') ? value.slice('staff-ref:'.length) : value
  return displayed
    .replace(/phone:(?:\+86)?(\d{3})\d{4}(\d{4})/, '电话：$1****$2')
    .replace(/wechat:/g, '微信：')
}

function depositRuleForDraft(config: ReservationConfig, areaPreferenceCode: string) {
  const policy = config.depositPolicy
  const areaRule = policy.areaRules.find((item) => item.areaPreferenceCode === areaPreferenceCode)
  return {
    depositAmount: areaRule?.depositAmount ?? policy.defaultDepositAmount,
    minimumSpendAmount: areaRule?.minimumSpendAmount ?? policy.defaultMinimumSpendAmount,
    deductibleRateBps: areaRule?.deductibleRateBps ?? policy.defaultDeductibleRateBps,
    customerNotice: areaRule?.customerNotice || policy.customerNotice,
  }
}

function downloadReservationCard(reservation: Reservation, config: ReservationConfig | null) {
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 1350
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = '#111310'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#d8b84e'
  context.fillRect(0, 0, canvas.width, 22)
  context.fillStyle = '#f7f7f2'
  context.font = '700 68px sans-serif'
  context.fillText('M-BOX', 88, 130)
  context.font = '500 28px sans-serif'
  context.fillStyle = '#c6c9c1'
  context.fillText('LIVEHOUSE · LUJIAZUI', 88, 178)
  context.fillStyle = '#f7f7f2'
  context.font = '700 48px sans-serif'
  context.fillText('预约确认', 88, 292)
  context.strokeStyle = '#42483f'
  context.lineWidth = 2
  context.strokeRect(72, 340, 936, 690)
  const rows = [
    ['预约姓名', reservation.customerName],
    ['预约时间', formatChinaDateTime(reservation.scheduledAt, { second: undefined })],
    ['到店人数', `${reservation.partySize}人`],
    ['区域偏好', config?.areaPreferences.find((area) => area.code === reservation.areaPreferenceCode)?.name ?? '到店安排'],
    ['预约编号', reservation.id.slice(0, 12).toUpperCase()],
    ['定金金额', money(reservation.deposit.requiredAmount)],
  ]
  rows.forEach(([label, value], index) => {
    const y = 430 + index * 96
    context.fillStyle = '#999f95'
    context.font = '500 27px sans-serif'
    context.fillText(label!, 112, y)
    context.fillStyle = '#f7f7f2'
    context.font = '650 32px sans-serif'
    context.fillText(value!, 340, y)
  })
  const depositRule = config ? depositRuleForDraft(config, reservation.areaPreferenceCode ?? '') : null
  context.fillStyle = '#d8b84e'
  context.font = '600 27px sans-serif'
  context.fillText(depositRule && reservation.deposit.requiredAmount > 0
    ? `定金可抵消费 ${(depositRule.deductibleRateBps / 100).toFixed(0)}% · 本位置低消 ${money(depositRule.minimumSpendAmount)}`
    : '到店后由服务伙伴为您安排座位与接待', 88, 1125)
  context.fillStyle = '#aeb3aa'
  context.font = '500 25px sans-serif'
  context.fillText('地址：上海市浦东南路889号陆家嘴中心RG05', 88, 1210)
  context.fillText('预约如有变化，请提前联系门店。', 88, 1258)
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `MBOX预约-${reservation.customerName}-${reservation.scheduledAt.slice(0, 10)}.png`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }, 'image/png')
}

// oxlint-disable-next-line react/only-export-components -- deterministic business-day boundary is tested independently.
export function reservationInBusinessDateRange(
  value: string,
  range: DateRange,
  businessDate: string,
  rolloverHour = 6,
) {
  if (range === 'all') return true
  const targetBusinessDate = chinaBusinessDateKey(value, rolloverHour)
  if (range === 'today') return targetBusinessDate === businessDate
  return targetBusinessDate >= businessDate && targetBusinessDate < shiftDateKey(businessDate, 7)
}

function formatDay(value: string) {
  const date = new Date(value)
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short', timeZone: CHINA_TIME_ZONE })
}

function formatTime(value: string) {
  return formatChinaTime(value)
}

function formatDateTime(value: string) {
  return formatChinaDateTime(value, { year: undefined, second: undefined })
}

function relativeTime(value: string) {
  const minutes = Math.round((Date.parse(value) - Date.now()) / 60_000)
  if (Math.abs(minutes) < 1) return '现在'
  if (minutes > 0 && minutes < 60) return `${minutes}分钟后`
  if (minutes > 0 && minutes < 1_440) return `${Math.round(minutes / 60)}小时后`
  if (minutes < 0 && minutes > -60) return `已过${Math.abs(minutes)}分钟`
  return minutes < 0 ? '时间已过' : `${Math.round(minutes / 1_440)}天后`
}

function occasionLabel(code: ReservationOccasionCode) {
  return code === 'birthday' ? '生日' : code === 'anniversary' ? '纪念日' : code === 'business' ? '商务' : '特殊接待'
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}

function idempotencyKey(scope: string) {
  return `reservation-ui-${scope}-${crypto.randomUUID()}`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
