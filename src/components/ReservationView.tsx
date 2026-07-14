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
  Search,
  Settings2,
  UserCheck,
  UserRoundX,
  UsersRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { getBootstrap } from '../api'
import {
  actOnReservation,
  confirmDeposit,
  confirmDepositRefund,
  createReservation,
  failDepositRefund,
  listReservations,
  recordDepositIntent,
  startDepositRefund,
  updateReservationConfig,
  type ReservationListResponse,
  type ReservationConfigWriteInput,
} from '../reservation-api'
import type { Table } from '../shared/contracts'
import type {
  Reservation,
  ReservationDepositStatus,
  ReservationConfig,
  ReservationOccasionCode,
  ReservationStatus,
} from '../shared/reservation-contracts'
import './ReservationView.css'

type DateRange = 'today' | 'upcoming' | 'all'
type Notice = { tone: 'success' | 'error'; message: string }
type OperationType = 'deposit_intent' | 'deposit_confirm' | 'seat' | 'cancel' | 'no_show' | 'refund_start' | 'refund_complete' | 'refund_fail'
type Operation = { type: OperationType; reservation: Reservation }

interface CreateDraft {
  customerName: string
  contactReference: string
  sourceCode: string
  partySize: number
  areaPreferenceCode: string
  occasionCode: '' | ReservationOccasionCode
  occasionNote: string
  scheduledAt: string
  depositYuan: string
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

function defaultScheduledAt() {
  const date = new Date()
  date.setMinutes(date.getMinutes() + 60 - (date.getMinutes() % 15), 0, 0)
  return toLocalInputValue(date)
}

function createEmptyDraft(): CreateDraft {
  return {
    customerName: '',
    contactReference: '',
    sourceCode: '',
    partySize: 2,
    areaPreferenceCode: '',
    occasionCode: '',
    occasionNote: '',
    scheduledAt: defaultScheduledAt(),
    depositYuan: '0',
  }
}

export function ReservationView() {
  const [response, setResponse] = useState<ReservationListResponse>(emptyResponse)
  const [tables, setTables] = useState<Table[]>([])
  const [businessDate, setBusinessDate] = useState('')
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

  const load = useCallback(async (withSpinner = true) => {
    if (withSpinner) setLoading(true)
    try {
      const [reservations, bootstrap] = await Promise.all([listReservations(), getBootstrap()])
      setResponse(reservations)
      setTables(bootstrap.tables)
      setBusinessDate(bootstrap.store.businessDate)
      setNotice(null)
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error, '预约数据加载失败') })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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

  const reservations = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
    return response.reservations
      .filter((reservation) => inDateRange(reservation.scheduledAt, dateRange))
      .filter((reservation) => statusFilter === 'all' || reservation.status === statusFilter)
      .filter((reservation) => !normalizedQuery || [
        reservation.customerName,
        reservation.contactReference,
        reservation.tableCode ?? '',
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery)))
      .toSorted((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))
  }, [dateRange, query, response.reservations, statusFilter])

  const metrics = useMemo(() => ({
    today: response.reservations.filter((item) => inDateRange(item.scheduledAt, 'today')).length,
    requested: response.reservations.filter((item) => item.status === 'requested').length,
    arriving: response.reservations.filter((item) => item.status === 'confirmed' && Date.parse(item.scheduledAt) <= Date.now() + 2 * 60 * 60 * 1000).length,
    refunds: response.reservations.filter((item) => ['refund_required', 'refund_processing', 'refund_failed'].includes(item.deposit.status)).length,
  }), [response.reservations])

  async function execute(actionKey: string, successMessage: string, action: () => Promise<unknown>) {
    setBusyAction(actionKey)
    setNotice(null)
    try {
      await action()
      await load(false)
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
    if (!draft.customerName.trim() || !draft.contactReference.trim() || !draft.sourceCode || !draft.scheduledAt) {
      setNotice({ tone: 'error', message: '请完整填写客人姓名、CRM/企微客户编号、来源和预约时间' })
      return
    }
    const externalCustomerReference = draft.contactReference.trim()
    if (looksLikePlaintextMobile(externalCustomerReference)) {
      setNotice({ tone: 'error', message: '禁止录入明文手机号，请填写CRM或企微客户编号' })
      return
    }
    const depositAmount = Math.round(Number(draft.depositYuan) * 100)
    if (!Number.isFinite(depositAmount) || depositAmount < 0) {
      setNotice({ tone: 'error', message: '定金金额必须是大于或等于0的数字' })
      return
    }
    void execute('create', '预约已创建，进入待确认队列', async () => {
      const staffReference = `staff-ref:${externalCustomerReference}`
      await createReservation({
        customerReference: staffReference,
        customerName: draft.customerName.trim(),
        contactReference: staffReference,
        sourceCode: draft.sourceCode,
        partySize: draft.partySize,
        areaPreferenceCode: draft.areaPreferenceCode || undefined,
        occasionCode: draft.occasionCode || undefined,
        occasionNote: draft.occasionNote.trim() || undefined,
        scheduledAt: new Date(draft.scheduledAt).toISOString(),
        depositRequiredAmount: depositAmount,
        depositCurrency: 'CNY',
        idempotencyKey: idempotencyKey('create'),
      })
      setDraft(createEmptyDraft())
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
  }

  function closeOperation() {
    setOperation(null)
    setReference('')
    setSecondaryReference('')
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
      const serviceDate = businessDate || new Date().toISOString().slice(0, 10)
      void execute(key, `客人已安排至${table.code}`, () => actOnReservation(reservation.id, {
        action: 'seat',
        tableId: table.id,
        tableCode: table.code,
        tableSessionId: `session:${table.id}:${serviceDate}`,
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
          <button className="secondary-button" type="button" disabled={!config || Boolean(busyAction)} onClick={showConfig ? closeConfig : openConfig}>
            {showConfig ? <X size={17} /> : <Settings2 size={17} />}{showConfig ? '关闭配置' : '经理配置'}
          </button>
          <button className="primary-button" type="button" onClick={() => { setShowCreate((current) => !current); closeConfig() }}>
            {showCreate ? <X size={17} /> : <Plus size={17} />}{showCreate ? '关闭创建' : '新建预约'}
          </button>
        </div>
      </header>

      {notice && <div className={`reservation-notice is-${notice.tone}`} role="status">
        {notice.tone === 'success' ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
        <span>{notice.message}</span>
        <button type="button" title="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button>
      </div>}

      <section className="reservation-metrics" aria-label="预约概览">
        <Metric icon={CalendarDays} value={String(metrics.today)} label="今日预约" />
        <Metric icon={Clock3} value={String(metrics.requested)} label="待确认" />
        <Metric icon={UserCheck} value={String(metrics.arriving)} label="两小时内待到店" />
        <Metric icon={RotateCcw} value={String(metrics.refunds)} label="定金退款待办" warning={metrics.refunds > 0} />
      </section>

      {config && <div className="reservation-rule-summary" aria-label="当前预约规则">
        <span><Settings2 size={15} /><strong>版本</strong>V{config.version}</span>
        <span><UsersRound size={15} /><strong>人数</strong>{config.minimumPartySize}-{config.maximumPartySize}人</span>
        <span><Search size={15} /><strong>来源</strong>{enabledSources.map((item) => item.name).join('、') || '未配置'}</span>
        <span><CalendarClock size={15} /><strong>场景</strong>{enabledOccasions.map((item) => item.name).join('、') || '未配置'}</span>
      </div>}

      {showConfig && configDraft && config && <ReservationConfigPanel
        currentVersion={config.version}
        draft={configDraft}
        reason={configReason}
        busy={busyAction === 'config'}
        onChange={setConfigDraft}
        onReasonChange={setConfigReason}
        onClose={closeConfig}
        onSubmit={submitConfig}
      />}

      {showCreate && <form className="reservation-create" onSubmit={submitCreate}>
        <div className="reservation-section-title"><Plus size={18} /><div><span>人工录入</span><h3>创建预约</h3></div></div>
        <div className="reservation-form-grid">
          <Field label="客人姓名"><input required maxLength={100} value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} /></Field>
          <Field label="CRM/企微客户编号"><input required maxLength={118} autoComplete="off" placeholder="例如 CRM-102938 或 wm_xxx" value={draft.contactReference} onChange={(event) => setDraft({ ...draft, contactReference: event.target.value })} /></Field>
          <Field label="预约时间"><input required type="datetime-local" value={draft.scheduledAt} onChange={(event) => setDraft({ ...draft, scheduledAt: event.target.value })} /></Field>
          <Field label="人数"><input required type="number" min={config?.minimumPartySize ?? 1} max={config?.maximumPartySize ?? 100} value={draft.partySize} onChange={(event) => setDraft({ ...draft, partySize: Number(event.target.value) })} /></Field>
          <Field label="来源"><select required value={draft.sourceCode} onChange={(event) => setDraft({ ...draft, sourceCode: event.target.value })}><option value="">请选择</option>{enabledSources.map((source) => <option key={source.code} value={source.code}>{source.name}</option>)}</select></Field>
          <Field label="区域偏好"><select value={draft.areaPreferenceCode} onChange={(event) => setDraft({ ...draft, areaPreferenceCode: event.target.value })}><option value="">无指定</option>{enabledAreas.map((area) => <option key={area.code} value={area.code}>{area.name}</option>)}</select></Field>
          <Field label="到店场景"><select value={draft.occasionCode} onChange={(event) => setDraft({ ...draft, occasionCode: event.target.value as CreateDraft['occasionCode'] })}><option value="">普通到店</option>{enabledOccasions.map((occasion) => <option key={occasion.code} value={occasion.code}>{occasion.name}</option>)}</select></Field>
          <Field label="定金（元）"><input type="number" min={0} step="0.01" value={draft.depositYuan} onChange={(event) => setDraft({ ...draft, depositYuan: event.target.value })} /></Field>
          <Field label="接待备注" wide><input maxLength={500} placeholder="生日称呼、座位要求或其他交接事项" value={draft.occasionNote} onChange={(event) => setDraft({ ...draft, occasionNote: event.target.value })} /></Field>
          <button className="primary-button" type="submit" disabled={Boolean(busyAction) || !config}>
            {busyAction === 'create' ? <LoaderCircle className="reservation-spin" size={17} /> : <Check size={17} />}保存预约
          </button>
        </div>
      </form>}

      {operation && <OperationPanel
        operation={operation}
        tables={tables}
        selectedTableId={selectedTableId}
        reference={reference}
        secondaryReference={secondaryReference}
        reason={reason}
        busy={Boolean(busyAction)}
        onTableChange={setSelectedTableId}
        onReferenceChange={setReference}
        onSecondaryReferenceChange={setSecondaryReference}
        onReasonChange={setReason}
        onClose={closeOperation}
        onSubmit={submitOperation}
      />}

      <section className="reservation-list-section">
        <div className="reservation-toolbar">
          <div className="reservation-tabs" aria-label="预约日期范围">
            {([['today', '今日'], ['upcoming', '未来7天'], ['all', '全部']] as const).map(([id, label]) => <button key={id} className={dateRange === id ? 'is-active' : ''} type="button" onClick={() => setDateRange(id)}>{label}</button>)}
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
            busyAction={busyAction}
            onQuickAction={quickAction}
            onOpenOperation={openOperation}
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

  return <form className="reservation-config-panel" onSubmit={onSubmit}>
    <header className="reservation-config-heading">
      <div><Settings2 size={19} /><span><small>经理权限</small><strong>预约规则配置</strong></span></div>
      <span className="reservation-config-version">当前 V{currentVersion} · 保存后 V{currentVersion + 1}</span>
    </header>

    <section className="reservation-config-general">
      <div className="reservation-config-section-title"><strong>人数范围</strong><span>用于创建预约时的前端和服务端约束</span></div>
      <Field label="最少人数"><input required type="number" min={1} max={100} value={draft.minimumPartySize} onChange={(event) => onChange({ ...draft, minimumPartySize: Number(event.target.value) })} /></Field>
      <Field label="最多人数"><input required type="number" min={1} max={100} value={draft.maximumPartySize} onChange={(event) => onChange({ ...draft, maximumPartySize: Number(event.target.value) })} /></Field>
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

function ReservationRow({ reservation, busyAction, onQuickAction, onOpenOperation }: {
  reservation: Reservation
  busyAction: string
  onQuickAction: (reservation: Reservation, action: 'confirm' | 'arrive') => void
  onOpenOperation: (type: OperationType, reservation: Reservation) => void
}) {
  const canConfirm = reservation.status === 'requested' && ['not_required', 'payment_confirmed'].includes(reservation.deposit.status)
  const canNoShow = reservation.status === 'confirmed' && Date.parse(reservation.scheduledAt) <= Date.now()
  const source = reservation.sourceCode === 'phone' ? '电话' : reservation.sourceCode === 'wechat' ? '微信' : reservation.sourceCode === 'walk_in' ? '现场' : reservation.sourceCode
  return <article className={`reservation-row status-${reservation.status}`}>
    <div className="reservation-time"><strong>{formatDay(reservation.scheduledAt)}</strong><b>{formatTime(reservation.scheduledAt)}</b><span>{relativeTime(reservation.scheduledAt)}</span></div>
    <div className="reservation-customer"><div><strong>{reservation.customerName}</strong><span>{reservation.partySize}人 · {source}</span></div><small>{displayCustomerReference(reservation.contactReference)}</small>{reservation.occasionNote && <p>{reservation.occasionNote}</p>}</div>
    <div className="reservation-placement"><span><MapPin size={13} />{reservation.tableCode ?? reservation.areaPreferenceCode ?? '区域待定'}</span>{reservation.occasionCode && <b>{occasionLabel(reservation.occasionCode)}</b>}</div>
    <div className="reservation-state"><span className={`reservation-status is-${reservation.status}`}>{statusLabels[reservation.status]}</span><small className={`deposit-status is-${reservation.deposit.status}`}>{depositLabels[reservation.deposit.status]}{reservation.deposit.requiredAmount > 0 ? ` · ${money(reservation.deposit.requiredAmount)}` : ''}</small></div>
    <fieldset className="reservation-actions" disabled={Boolean(busyAction)}>
      {reservation.deposit.status === 'payment_required' && <ActionButton icon={Banknote} label="登记支付单" onClick={() => onOpenOperation('deposit_intent', reservation)} />}
      {reservation.deposit.status === 'payment_intent_recorded' && <ActionButton icon={Banknote} label="确认定金到账" primary onClick={() => onOpenOperation('deposit_confirm', reservation)} />}
      {canConfirm && <ActionButton icon={Check} label="确认预约" primary loading={busyAction === `confirm:${reservation.id}`} onClick={() => onQuickAction(reservation, 'confirm')} />}
      {reservation.status === 'confirmed' && <ActionButton icon={UserCheck} label="确认到店" primary loading={busyAction === `arrive:${reservation.id}`} onClick={() => onQuickAction(reservation, 'arrive')} />}
      {reservation.status === 'arrived' && <ActionButton icon={DoorOpen} label="安排入座" primary onClick={() => onOpenOperation('seat', reservation)} />}
      {['requested', 'confirmed', 'arrived'].includes(reservation.status) && <ActionButton icon={X} label="取消" onClick={() => onOpenOperation('cancel', reservation)} />}
      {canNoShow && <ActionButton icon={UserRoundX} label="未到店" danger onClick={() => onOpenOperation('no_show', reservation)} />}
      {['refund_required', 'refund_failed'].includes(reservation.deposit.status) && <ActionButton icon={RotateCcw} label={reservation.deposit.status === 'refund_failed' ? '重试退款' : '发起退款'} primary onClick={() => onOpenOperation('refund_start', reservation)} />}
      {reservation.deposit.status === 'refund_processing' && <><ActionButton icon={Check} label="确认退款" primary onClick={() => onOpenOperation('refund_complete', reservation)} /><ActionButton icon={CircleAlert} label="记录失败" danger onClick={() => onOpenOperation('refund_fail', reservation)} /></>}
      {['seated', 'cancelled', 'no_show'].includes(reservation.status) && !['refund_required', 'refund_processing', 'refund_failed'].includes(reservation.deposit.status) && <span className="reservation-closed">流程已结束</span>}
    </fieldset>
  </article>
}

function OperationPanel({ operation, tables, selectedTableId, reference, secondaryReference, reason, busy, onTableChange, onReferenceChange, onSecondaryReferenceChange, onReasonChange, onClose, onSubmit }: {
  operation: Operation
  tables: Table[]
  selectedTableId: string
  reference: string
  secondaryReference: string
  reason: string
  busy: boolean
  onTableChange: (value: string) => void
  onReferenceChange: (value: string) => void
  onSecondaryReferenceChange: (value: string) => void
  onReasonChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const labels: Record<OperationType, string> = {
    deposit_intent: '登记定金支付单', deposit_confirm: '确认定金到账', seat: '安排入座', cancel: '取消预约', no_show: '标记未到店', refund_start: '发起定金退款', refund_complete: '确认退款完成', refund_fail: '记录退款失败',
  }
  return <form className="reservation-operation" onSubmit={onSubmit}>
    <div className="operation-identity"><span>当前操作</span><strong>{labels[operation.type]}</strong><small>{operation.reservation.customerName} · {formatDateTime(operation.reservation.scheduledAt)}</small></div>
    {operation.type === 'seat' && <Field label="入座桌台"><select required value={selectedTableId} onChange={(event) => onTableChange(event.target.value)}><option value="">请选择桌台</option>{tables.map((table) => <option key={table.id} value={table.id} disabled={['occupied', 'paused'].includes(table.status)}>{table.code} · {table.displayName} · {table.status === 'available' ? '可用' : table.status === 'reserved' ? '已预留' : table.status === 'occupied' ? '使用中' : '暂停'}</option>)}</select></Field>}
    {operation.type === 'deposit_intent' && <Field label="外部支付单号"><input required autoFocus maxLength={256} value={reference} onChange={(event) => onReferenceChange(event.target.value)} /></Field>}
    {operation.type === 'deposit_confirm' && <><Field label="支付单号"><input disabled value={operation.reservation.deposit.paymentIntentReference ?? reference} /></Field><Field label="到账确认流水"><input required autoFocus maxLength={256} value={secondaryReference} onChange={(event) => onSecondaryReferenceChange(event.target.value)} /></Field></>}
    {operation.type === 'refund_start' && <Field label="退款请求单号"><input required autoFocus maxLength={256} value={reference} onChange={(event) => onReferenceChange(event.target.value)} /></Field>}
    {operation.type === 'refund_complete' && <><Field label="退款请求单号"><input disabled value={operation.reservation.deposit.refundRequestReference ?? reference} /></Field><Field label="退款确认流水"><input required autoFocus maxLength={256} value={secondaryReference} onChange={(event) => onSecondaryReferenceChange(event.target.value)} /></Field></>}
    {['cancel', 'no_show', 'refund_fail'].includes(operation.type) && <Field label={operation.type === 'refund_fail' ? '失败原因' : '操作原因'}><input required autoFocus maxLength={500} value={reason} onChange={(event) => onReasonChange(event.target.value)} /></Field>}
    <div className="operation-summary">{operationHint(operation)}</div>
    <div className="operation-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>返回</button><button className={['cancel', 'no_show', 'refund_fail'].includes(operation.type) ? 'reservation-danger-button' : 'primary-button'} type="submit" disabled={busy}>{busy ? <LoaderCircle className="reservation-spin" size={16} /> : <Check size={16} />}确认提交</button></div>
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
    sources: config.sources.map((item) => ({ ...item })),
    areaPreferences: config.areaPreferences.map((item) => ({ ...item })),
    occasions: config.occasions.map((item) => ({ ...item, serviceScript: [...item.serviceScript] })),
  }
}

function normalizeConfigDraft(draft: ConfigDraft): ConfigDraft {
  return {
    minimumPartySize: draft.minimumPartySize,
    maximumPartySize: draft.maximumPartySize,
    sources: draft.sources.map((item) => ({ ...item, code: item.code.trim(), name: item.name.trim() })),
    areaPreferences: draft.areaPreferences.map((item) => ({ ...item, code: item.code.trim(), name: item.name.trim() })),
    occasions: draft.occasions.map((item) => ({
      ...item,
      name: item.name.trim(),
      serviceScript: item.serviceScript.map((step) => step.trim()).filter(Boolean),
    })),
  }
}

function validateConfigDraft(draft: ConfigDraft, reason: string) {
  if (!Number.isInteger(draft.minimumPartySize) || draft.minimumPartySize < 1 || draft.minimumPartySize > 100) return '最少人数必须是1至100之间的整数'
  if (!Number.isInteger(draft.maximumPartySize) || draft.maximumPartySize < draft.minimumPartySize || draft.maximumPartySize > 300) return '最多人数必须是不小于最少人数且不超过300的整数'
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

function looksLikePlaintextMobile(value: string) {
  const compact = value.replace(/[\s()+-]/g, '')
  return /^(?:86)?1[3-9]\d{9}$/.test(compact)
}

function displayCustomerReference(value: string) {
  return value.startsWith('staff-ref:') ? value.slice('staff-ref:'.length) : value
}

function inDateRange(value: string, range: DateRange) {
  if (range === 'all') return true
  const target = new Date(value)
  const start = startOfToday()
  const end = new Date(start)
  end.setDate(end.getDate() + (range === 'today' ? 1 : 7))
  return target >= start && target < end
}

function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function formatDay(value: string) {
  const date = new Date(value)
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' })
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
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

function toLocalInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function idempotencyKey(scope: string) {
  return `reservation-ui-${scope}-${crypto.randomUUID()}`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
