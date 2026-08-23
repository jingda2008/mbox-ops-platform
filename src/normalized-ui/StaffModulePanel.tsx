import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  LoaderCircle,
  Music2,
  PackageSearch,
  Printer,
  RefreshCw,
  ScanLine,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { NormalizedApiClient, NormalizedApiError, type StaffAuthView } from '../normalized-api'
import { CashierAfterSalesWorkbench } from './CashierAfterSalesWorkbench'
import { CatalogManagementPanel } from './CatalogManagementPanel'
import { VenueManagementPanel } from './VenueManagementPanel'
import { StaffAccessManagementPanel } from './StaffAccessManagementPanel'
import {
  CustomerExperienceManagementPanel,
  customerExperienceDashboard,
  type CustomerExperienceDashboard,
} from './CustomerExperienceManagementPanel'
import { paymentPolicyPresentation } from './payment-policy-presentation'
import { PerformanceRevisionPanel } from './PerformanceRevisionPanel'
import { InventoryBarcodeScanner } from './InventoryBarcodeScanner'
import './staff-module-panel.css'

export type StaffModule = 'payments' | 'performance' | 'inventory' | 'operations' | 'experience' | 'devices' | 'settings'

interface ScheduleEntry extends Record<string, unknown> {
  id: string
  performerStageName: string
  startsAt: string
  endsAt: string
  status: string
}

interface SongRequestEntry extends Record<string, unknown> {
  id: string
  songTitle: string
  status: string
  createdAt: string
}

interface PerformerEntry extends Record<string, unknown> {
  id: string
  code: string
  stageName: string
  profileSnapshot: Record<string, unknown>
  status: string
}

interface PerformerSongEntry extends Record<string, unknown> {
  id: string
  performerId: string
  code: string | null
  title: string
  aliases: string[]
  status: string
  requestCount: number
  performedCount: number
}

interface PerformanceView {
  phase: string
  current: ScheduleEntry | null
  next: ScheduleEntry | null
  schedules: ScheduleEntry[]
}

type PerformancePhaseCode = 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show'

interface PerformancePhaseEvent {
  publicId: string
  scheduleId: string
  performerStageName: string
  phaseCode: PerformancePhaseCode
  status: 'active' | 'ended' | 'cancelled'
  startedAt: string
  endedAt: string | null
  cancelledAt: string | null
}

interface InventoryItemView {
  id: string
  sku: string
  name: string
  itemType: string
  baseUnit: string
  categoryCode: string
  availableQuantity: string
  lowStock: boolean
}

interface PurchaseReceiptView {
  id: string
  publicId: string
  status: string
  lineCount: number
  lines: Array<{ inventoryItemId: string; itemName: string; batchCode: string; quantity: string; baseUnit: string }>
  createdAt: string
  receivedAt: string | null
}

interface PurchaseReceiptCommandView {
  id: string
  publicId: string
  status: string
  lineCount: number
  receivedAt: string | null
}

interface InventoryView {
  items: InventoryItemView[]
  lowStockCount: number
  receipts: PurchaseReceiptView[]
  storedBottles: unknown[]
}

interface ProfitView {
  status: string
  currency: string
  range: { startDate: string; endDate: string }
  revenue: { cash: { netReceiptsMinor: number } }
  costs: { cashPaidMinor: number; accrualAllocatedMinor: number }
  profit: { cashBasisMinor: number; accrualBasisMinor: number }
  caveats: string[]
}

interface HardwareDeviceView {
  id: string
  code: string
  name: string
  deviceType: string
  stationCode: string | null
  status: string
  connectivityStatus: string
  printBridgeId: string | null
  windowsQueueName: string | null
  printProfile: 'escpos_58' | 'escpos_80' | 'windows_text' | null
}

interface PrintBridgeView {
  id: string
  publicId: string
  name: string
  status: 'active' | 'revoked'
  hostname: string
  softwareVersion: string
  lastSeenAt: string | null
  printerCount: number
  online: boolean
  queues: string[]
}

interface PrinterRouteView {
  id: string
  code: string
  name: string
  stationCode: 'bar' | 'kitchen' | 'cashier'
  productCategoryCode: string | null
  printerDeviceId: string
  copies: number
  priority: number
  status: string
}

interface PrintJobView {
  id: string
  printerName: string
  stationCode: string
  status: string
  attempts: number
  maxAttempts: number
}

interface EmployeeSalesView {
  employeeId: string
  employeeDisplayName: string
  productId: string
  productName: string
  quantity: string
  salesAmountMinor: number
  contributionProfitMinor: number | null
  currency: string
}

interface CommercePolicyView extends Record<string, unknown> {
  configured: boolean
  policyOnlinePaymentEnabled: boolean
  onlinePaymentEnabled: boolean
  providerConfigured: boolean
  provider: 'postar' | 'simulation' | null
  paymentReservationMinutes: number
  policyVersion: number
  reason: string | null
  updatedAt: string | null
}

interface ModuleData {
  performance: PerformanceView | null
  performers: PerformerEntry[]
  songRequests: SongRequestEntry[]
  performancePhases: PerformancePhaseEvent[]
  inventory: InventoryView | null
  profit: ProfitView | null
  devices: HardwareDeviceView[]
  printJobs: PrintJobView[]
  printBridges: PrintBridgeView[]
  printerRoutes: PrinterRouteView[]
  employeeSales: EmployeeSalesView[]
  commercePolicy: CommercePolicyView | null
  customerExperience: CustomerExperienceDashboard | null
}

const emptyData: ModuleData = {
  performance: null,
  performers: [],
  songRequests: [],
  performancePhases: [],
  inventory: null,
  profit: null,
  devices: [],
  printJobs: [],
  printBridges: [],
  printerRoutes: [],
  employeeSales: [],
  commercePolicy: null,
  customerExperience: null,
}

export function StaffModulePanel({ api, auth, module, onLoginRequired }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  module: StaffModule
  onLoginRequired(): void
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [data, setData] = useState<ModuleData>(emptyData)
  const [paymentRefreshToken, setPaymentRefreshToken] = useState(0)
  const loadedModule = useRef<StaffModule | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPhase('loading')
    setMessage(null)
    try {
      if (module === 'payments') {
        setData(emptyData)
      } else if (module === 'performance') {
        const [performance, requests, performers, phases] = await Promise.all([
          api.getEndpoint<{ data: unknown }>('/api/staff/performances/today'),
          api.getEndpoint<{ data: unknown }>('/api/staff/song-requests'),
          api.getEndpoint<{ data: unknown }>('/api/staff/performers'),
          api.getEndpoint<{ data: unknown }>('/api/staff/customer-experience/performance-phases/current'),
        ])
        setData({
          ...emptyData,
          performance: performanceView(performance.data),
          songRequests: songRequests(requests.data),
          performers: performerEntries(performers.data),
          performancePhases: performancePhaseEvents(phases.data),
        })
      } else if (module === 'inventory') {
        const response = await api.getEndpoint<{ data: unknown }>('/api/inventory')
        setData({ ...emptyData, inventory: inventoryView(response.data) })
      } else if (module === 'operations') {
        if (auth.permissions.includes('commercial.profit.view')) {
          const response = await api.getEndpoint<{ data: unknown }>('/api/commercial-ops/profit?period=day')
          setData({ ...emptyData, profit: profitView(response.data) })
        } else {
          const response = await api.getEndpoint<{ data: unknown }>('/api/commercial-ops/employee-sales')
          setData({ ...emptyData, employeeSales: employeeSales(response.data) })
        }
      } else if (module === 'experience') {
        const response = await api.getEndpoint<{ data: unknown }>('/api/staff/customer-experience/dashboard')
        setData({ ...emptyData, customerExperience: customerExperienceDashboard(response.data) })
      } else if (module === 'devices') {
        const canManagePrinters = auth.permissions.includes('printer.manage') || auth.permissions.includes('hardware.manage')
        const canViewPrintJobs = canManagePrinters || auth.permissions.includes('print.view') || auth.permissions.includes('print.view_all')
        const canViewRoutes = canManagePrinters || auth.permissions.includes('hardware.view_all')
        const [devices, jobs, bridges, routes] = await Promise.all([
          api.getEndpoint<{ data: unknown }>('/api/hardware/devices'),
          canViewPrintJobs ? api.getEndpoint<{ data: unknown }>('/api/hardware/print-jobs?status=pending,printing,failed,dead&limit=50') : Promise.resolve({ data: [] }),
          canManagePrinters ? api.getEndpoint<{ data: unknown }>('/api/hardware/print-bridges') : Promise.resolve({ data: [] }),
          canViewRoutes ? api.getEndpoint<{ data: unknown }>('/api/hardware/printer-routes') : Promise.resolve({ data: [] }),
        ])
        setData({
          ...emptyData,
          devices: hardwareDevices(devices.data), printJobs: printJobs(jobs.data),
          printBridges: printBridges(bridges.data), printerRoutes: printerRoutes(routes.data),
        })
      } else {
        if (auth.permissions.includes('payment.policy.manage')) {
          const response = await api.getEndpoint<{ data: unknown }>('/api/store/commerce-policy')
          setData({ ...emptyData, commercePolicy: commercePolicyView(response.data) })
        } else {
          setData(emptyData)
        }
      }
      setPhase('ready')
    } catch (error) {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        onLoginRequired()
        return
      }
      setMessage(error instanceof Error ? error.message : '岗位数据暂时无法读取')
      setPhase('error')
    }
  }, [api, auth.permissions, module, onLoginRequired])

  const refresh = useCallback(() => load(true), [load])

  useEffect(() => {
    const quiet = loadedModule.current === module
    loadedModule.current = module
    void load(quiet)
  }, [load, module])

  const content = useMemo(() => {
    if (module === 'payments') {
      return <CashierAfterSalesWorkbench
        api={api}
        auth={auth}
        onLoginRequired={onLoginRequired}
        refreshToken={paymentRefreshToken}
      />
    }
    if (module === 'performance') return <PerformanceModule api={api} auth={auth} view={data.performance} performers={data.performers} requests={data.songRequests} phases={data.performancePhases} onChanged={refresh} />
    if (module === 'inventory') return <InventoryModule api={api} auth={auth} view={data.inventory} onChanged={refresh} />
    if (module === 'operations') return <OperationsModule view={data.profit} sales={data.employeeSales} canViewProfit={auth.permissions.includes('commercial.profit.view')} />
    if (module === 'experience' && data.customerExperience !== null) return <CustomerExperienceManagementPanel api={api} auth={auth} dashboard={data.customerExperience} />
    if (module === 'devices') return <DevicesModule api={api} auth={auth} devices={data.devices} jobs={data.printJobs} bridges={data.printBridges} routes={data.printerRoutes} onChanged={refresh} />
    return <SettingsModule api={api} auth={auth} policy={data.commercePolicy} onChanged={refresh} />
  }, [api, auth, data, module, onLoginRequired, paymentRefreshToken, refresh])

  const modulePresentation = {
    payments: { title: '收银与退款', icon: CircleDollarSign },
    performance: { title: '演出与点歌', icon: Music2 },
    inventory: { title: '库存与酒水上架', icon: PackageSearch },
    operations: { title: '经营数据', icon: BarChart3 },
    experience: { title: '客户体验与活动', icon: CalendarClock },
    devices: { title: '设备与打印', icon: Printer },
    settings: { title: '系统配置状态', icon: Settings2 },
  } satisfies Record<StaffModule, { title: string; icon: typeof Settings2 }>
  const { title, icon: Icon } = modulePresentation[module]

  return <section className="staff-module-panel" aria-label={title} data-action-reveal>
    <header>
      <span><Icon size={20} /></span>
      <div><small>岗位工作面</small><h1>{title}</h1></div>
      <button
        type="button"
        aria-label={`刷新${title}`}
        onClick={() => module === 'payments' ? setPaymentRefreshToken((value) => value + 1) : void load()}
        disabled={phase === 'loading'}
      >
        <RefreshCw size={18} className={phase === 'loading' ? 'is-spinning' : ''} />
      </button>
    </header>
    {phase === 'loading' && <div className="staff-module-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在读取最新状态</strong></div>}
    {phase === 'error' && <div className="staff-module-state is-error" role="alert"><strong>暂时没有接上</strong><p>{message}</p><button type="button" onClick={() => void load()}>重试</button></div>}
    {phase === 'ready' && content}
  </section>
}

function PerformanceModule({ api, auth, view, performers, requests, phases, onChanged }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  view: PerformanceView | null
  performers: PerformerEntry[]
  requests: SongRequestEntry[]
  phases: PerformancePhaseEvent[]
  onChanged(): Promise<void>
}) {
  const schedules = view?.schedules ?? []
  const stalePhases = phases.filter((phase) => (
    schedules.find((schedule) => schedule.id === phase.scheduleId)?.status !== 'performing'
  ))
  const canManage = auth.permissions.includes('song.manage')
  const canManagePhase = auth.permissions.includes('performance.phase.manage')
  const [form, setForm] = useState<'performer' | 'performer-edit' | 'schedule' | 'songs' | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [performerCode, setPerformerCode] = useState('')
  const [stageName, setStageName] = useState('')
  const [genres, setGenres] = useState('')
  const [schedulePerformerId, setSchedulePerformerId] = useState(performers[0]?.id ?? '')
  const [catalogPerformerId, setCatalogPerformerId] = useState(performers[0]?.id ?? '')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogSongs, setCatalogSongs] = useState<PerformerSongEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogMode, setCatalogMode] = useState<'upsert' | 'replace'>('upsert')
  const [catalogRows, setCatalogRows] = useState('')
  const [editingSong, setEditingSong] = useState<PerformerSongEntry | null>(null)
  const [editSongCode, setEditSongCode] = useState('')
  const [editSongTitle, setEditSongTitle] = useState('')
  const [editSongAliases, setEditSongAliases] = useState('')
  const [editPerformerName, setEditPerformerName] = useState('')
  const [editPerformerGenres, setEditPerformerGenres] = useState('')
  const [editPerformerStatus, setEditPerformerStatus] = useState<'active' | 'inactive'>('active')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [quotes, setQuotes] = useState<Record<string, string>>({})
  const [phaseChoice, setPhaseChoice] = useState<Record<string, PerformancePhaseCode>>({})

  const selectedPerformer = performers.find((performer) => performer.id === catalogPerformerId) ?? performers[0]

  useEffect(() => {
    if (catalogPerformerId === '' && performers[0] !== undefined) setCatalogPerformerId(performers[0].id)
  }, [catalogPerformerId, performers])

  const loadCatalog = useCallback(async (performerId: string, search: string) => {
    if (performerId === '') { setCatalogSongs([]); return }
    setCatalogLoading(true)
    try {
      const response = await api.getEndpoint<{ data: unknown }>(`/api/staff/performers/${performerId}/songs?search=${encodeURIComponent(search.trim())}&limit=500`)
      setCatalogSongs(performerSongEntries(response.data))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '歌单读取失败')
    } finally {
      setCatalogLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (form === 'songs' && catalogPerformerId !== '') void loadCatalog(catalogPerformerId, '')
  }, [catalogPerformerId, form, loadCatalog])

  async function run(key: string, operation: () => Promise<unknown>, success: string) {
    if (busyKey !== null) return
    setBusyKey(key)
    setNotice('')
    try {
      await operation()
      setNotice(success)
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未完成，请核对后重试')
    } finally {
      setBusyKey(null)
    }
  }

  async function createPerformer(event: React.FormEvent) {
    event.preventDefault()
    await run('performer-create', () => api.postEndpoint('/api/staff/performers', {
      code: performerCode.trim(),
      stageName: stageName.trim(),
      profileSnapshot: { genres: genres.split(/[，,]/).map((value) => value.trim()).filter(Boolean) },
      status: 'active',
    }, { idempotencyKey: operationIdempotency('performer-create') }), '演员资料已建立')
    setPerformerCode('')
    setStageName('')
    setGenres('')
  }

  function openPerformerEdit() {
    if (selectedPerformer === undefined) { setNotice('请先建立演员资料'); return }
    const rawGenres = selectedPerformer.profileSnapshot.genres
    setEditPerformerName(selectedPerformer.stageName)
    setEditPerformerGenres(Array.isArray(rawGenres) ? rawGenres.filter((value): value is string => typeof value === 'string').join('，') : '')
    setEditPerformerStatus(selectedPerformer.status === 'inactive' ? 'inactive' : 'active')
    setForm(form === 'performer-edit' ? null : 'performer-edit')
  }

  async function updatePerformer(event: React.FormEvent) {
    event.preventDefault()
    if (selectedPerformer === undefined) return
    await run(`performer-update-${selectedPerformer.id}`, () => api.patchEndpoint(`/api/staff/performers/${selectedPerformer.id}`, {
      stageName: editPerformerName.trim(),
      profileSnapshot: { ...selectedPerformer.profileSnapshot, genres: editPerformerGenres.split(/[，,]/).map((value) => value.trim()).filter(Boolean) },
      status: editPerformerStatus,
    }, { idempotencyKey: operationIdempotency('performer-update') }), '演员资料已更新，顾客端将读取最新状态')
  }

  async function importSongs(event: React.FormEvent) {
    event.preventDefault()
    if (catalogPerformerId === '') { setNotice('请选择演员'); return }
    let songs: Array<{ code: string | null; title: string; aliases: string[] }>
    try {
      songs = parseSongImportRows(catalogRows)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '歌单格式无效')
      return
    }
    if (songs.length === 0 && catalogMode !== 'replace') { setNotice('追加导入至少需要一首歌曲'); return }
    if (catalogMode === 'replace' && !window.confirm(`确认用当前${songs.length}首歌曲替换该演员的可用歌单？未列出的歌曲将停用。`)) return
    await run(`song-import-${catalogPerformerId}`, () => api.postEndpoint(`/api/staff/performers/${catalogPerformerId}/songs/import`, {
      sourceName: '员工端批量维护', mode: catalogMode, songs,
    }, { idempotencyKey: operationIdempotency('song-import') }), `已导入${songs.length}首歌曲`)
    setCatalogRows('')
    await loadCatalog(catalogPerformerId, catalogSearch)
  }

  function beginSongEdit(song: PerformerSongEntry) {
    setEditingSong(song)
    setEditSongCode(song.code ?? '')
    setEditSongTitle(song.title)
    setEditSongAliases(song.aliases.join('，'))
  }

  async function updateSong(event: React.FormEvent) {
    event.preventDefault()
    if (editingSong === null) return
    await run(`song-update-${editingSong.id}`, () => api.patchEndpoint(`/api/staff/songs/${editingSong.id}`, {
      code: editSongCode.trim() || null,
      title: editSongTitle.trim(),
      aliases: editSongAliases.split(/[，,]/).map((value) => value.trim()).filter(Boolean),
    }, { idempotencyKey: operationIdempotency('song-update') }), '歌曲资料已更新')
    setEditingSong(null)
    await loadCatalog(catalogPerformerId, catalogSearch)
  }

  async function deactivateSong(song: PerformerSongEntry) {
    if (!window.confirm(`确认停用“${song.title}”？停用后顾客不能再从该演员歌单点选。`)) return
    await run(`song-disable-${song.id}`, () => api.patchEndpoint(`/api/staff/songs/${song.id}`, { status: 'inactive' }, {
      idempotencyKey: operationIdempotency('song-disable'),
    }), '歌曲已停用')
    await loadCatalog(catalogPerformerId, catalogSearch)
  }

  async function createSchedule(event: React.FormEvent) {
    event.preventDefault()
    const performerId = schedulePerformerId || performers[0]?.id
    if (performerId === undefined) { setNotice('请先建立演员资料'); return }
    let start: string
    let end: string
    try {
      start = localDateTimeIso(startsAt)
      end = localDateTimeIso(endsAt)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '演出时间无效')
      return
    }
    if (Date.parse(end) <= Date.parse(start)) { setNotice('结束时间必须晚于开始时间'); return }
    await run('schedule-create', () => api.postEndpoint('/api/staff/schedules', {
      performerId, startsAt: start, endsAt: end, sortOrder: schedules.length,
    }, { idempotencyKey: operationIdempotency('schedule-create') }), '演出场次已保存并对顾客可见')
    setStartsAt('')
    setEndsAt('')
  }

  function transitionSchedule(schedule: ScheduleEntry, targetStatus: 'performing' | 'completed') {
    void run(`schedule-${schedule.id}-${targetStatus}`, () => api.postEndpoint(`/api/staff/schedules/${schedule.id}/status`, { targetStatus }, {
      idempotencyKey: operationIdempotency(`schedule-${targetStatus}`),
    }), targetStatus === 'performing' ? '已切换为演出中' : '已标记演出结束')
  }

  function startPhase(schedule: ScheduleEntry) {
    const phaseCode = phaseChoice[schedule.id] ?? 'band_live'
    void run(`phase-${schedule.id}-start`, () => api.postEndpoint(
      `/api/staff/customer-experience/schedules/${schedule.id}/performance-phases`,
      { phaseCode, reason: '舞台授权人员确认现场阶段开始' },
      { idempotencyKey: operationIdempotency('performance-phase-start') },
    ), `已开始“${performancePhaseCodeLabel(phaseCode)}”，受阶段限制的推荐将立即按此筛选`)
  }

  function transitionPhase(event: PerformancePhaseEvent, action: 'end' | 'cancel') {
    if (action === 'cancel' && !window.confirm('确认取消这条现场阶段记录？取消后受阶段限制的商品将停止推荐。')) return
    void run(`phase-${event.publicId}-${action}`, () => api.postEndpoint(
      `/api/staff/customer-experience/performance-phases/${event.publicId}/${action}`,
      { reason: action === 'end' ? '舞台授权人员确认本阶段结束' : '舞台授权人员确认阶段记录取消' },
      { idempotencyKey: operationIdempotency(`performance-phase-${action}`) },
    ), action === 'end' ? '现场阶段已结束' : '现场阶段记录已取消')
  }

  function transitionSong(request: SongRequestEntry, action: 'confirm' | 'reject' | 'performed' | 'cancel') {
    const quotedAmountMinor = Math.round(Number(quotes[request.id] ?? '') * 100)
    const body = action === 'confirm'
      ? { quotedAmountMinor, currency: 'CNY' }
      : {}
    if (action === 'confirm' && (!Number.isFinite(quotedAmountMinor) || quotedAmountMinor < 0)) {
      setNotice('请填写有效的点歌报价；免费可填0')
      return
    }
    void run(`song-${request.id}-${action}`, () => api.postEndpoint(`/api/staff/song-requests/${request.id}/${action}`, body, {
      idempotencyKey: operationIdempotency(`song-${action}`),
    }), action === 'confirm' ? '点歌需求已接受' : action === 'reject' ? '点歌需求已拒绝' : action === 'performed' ? '已记录演唱完成' : '点歌需求已取消')
  }

  return <div className="staff-module-body">
    <div className="staff-module-summary"><span><CalendarClock size={18} /></span><div><strong>{performancePhase(view?.phase)}</strong><small>{schedules.length} 个演出时段 · {requests.length} 条点歌需求</small></div></div>
    {notice !== '' && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManage && <div className="staff-module-actions"><button type="button" onClick={() => setForm(form === 'performer' ? null : 'performer')}>新增演员</button><button type="button" disabled={performers.length === 0} onClick={openPerformerEdit}>编辑演员</button><button type="button" disabled={performers.length === 0} onClick={() => setForm(form === 'songs' ? null : 'songs')}>维护歌单</button><button type="button" onClick={() => setForm(form === 'schedule' ? null : 'schedule')}>新增演出场次</button></div>}
    {form === 'performer' && <form className="staff-module-form" onSubmit={(event) => void createPerformer(event)}><header><strong>新增演员资料</strong><small>演员资料和歌单分别保存，避免旧整块JSON覆盖。</small></header><label>演员编号<input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={performerCode} onChange={(event) => setPerformerCode(event.target.value)} placeholder="例如 singer-liyan" /></label><label>艺名<input required maxLength={120} value={stageName} onChange={(event) => setStageName(event.target.value)} /></label><label>风格标签<input value={genres} onChange={(event) => setGenres(event.target.value)} placeholder="爵士，流行" /></label><button type="submit" disabled={busyKey !== null}>{busyKey === 'performer-create' ? '保存中' : '保存演员'}</button></form>}
    {form === 'performer-edit' && selectedPerformer !== undefined && <form className="staff-module-form" onSubmit={(event) => void updatePerformer(event)}><header><strong>编辑演员资料</strong><small>演员编号 {selectedPerformer.code} 保持不变；停用后不再进入顾客可选排班。</small></header><label>演员<select value={catalogPerformerId} onChange={(event) => { setCatalogPerformerId(event.target.value); const next = performers.find((item) => item.id === event.target.value); if (next) { setEditPerformerName(next.stageName); setEditPerformerStatus(next.status === 'inactive' ? 'inactive' : 'active'); const value = next.profileSnapshot.genres; setEditPerformerGenres(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('，') : '') } }}>{performers.map((performer) => <option value={performer.id} key={performer.id}>{performer.stageName}</option>)}</select></label><label>艺名<input required maxLength={120} value={editPerformerName} onChange={(event) => setEditPerformerName(event.target.value)} /></label><label>风格标签<input value={editPerformerGenres} onChange={(event) => setEditPerformerGenres(event.target.value)} /></label><label>可用状态<select value={editPerformerStatus} onChange={(event) => setEditPerformerStatus(event.target.value as 'active' | 'inactive')}><option value="active">启用</option><option value="inactive">停用</option></select></label><button type="submit" disabled={busyKey !== null}>保存演员变更</button></form>}
    {form === 'songs' && <section className="staff-song-catalog"><header><div><strong>演员歌单</strong><small>可搜索、批量导入、逐首修改；点歌次数来自真实请求记录。</small></div><label>演员<select value={catalogPerformerId} onChange={(event) => setCatalogPerformerId(event.target.value)}>{performers.map((performer) => <option value={performer.id} key={performer.id}>{performer.stageName}</option>)}</select></label></header><div className="staff-song-search"><label><span className="sr-only">搜索歌名、编号或别名</span><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="搜索歌名、编号或别名" /></label><button type="button" disabled={catalogLoading} onClick={() => void loadCatalog(catalogPerformerId, catalogSearch)}>{catalogLoading ? '搜索中' : '搜索'}</button></div><form className="staff-song-import" onSubmit={(event) => void importSongs(event)}><header><strong>批量导入</strong><small>每行格式：编号 | 歌名 | 别名1,别名2。编号和别名可留空。</small></header><textarea value={catalogRows} onChange={(event) => setCatalogRows(event.target.value)} rows={5} placeholder={'SONG-001 | 后来 | Hou Lai\n | 月亮代表我的心 | 月亮'} /><label>导入方式<select value={catalogMode} onChange={(event) => setCatalogMode(event.target.value as 'upsert' | 'replace')}><option value="upsert">追加或更新</option><option value="replace">整份替换</option></select></label><button type="submit" disabled={busyKey !== null}>开始导入</button></form>{editingSong !== null && <form className="staff-song-edit" onSubmit={(event) => void updateSong(event)}><strong>修改单曲</strong><label>编号<input value={editSongCode} onChange={(event) => setEditSongCode(event.target.value)} /></label><label>歌名<input required value={editSongTitle} onChange={(event) => setEditSongTitle(event.target.value)} /></label><label>别名<input value={editSongAliases} onChange={(event) => setEditSongAliases(event.target.value)} /></label><div><button type="submit" disabled={busyKey !== null}>保存</button><button type="button" onClick={() => setEditingSong(null)}>取消</button></div></form>}<div className="staff-song-catalog-list">{catalogSongs.length === 0 ? <p>{catalogLoading ? '正在读取歌单' : '暂无匹配歌曲'}</p> : catalogSongs.map((song) => <article key={song.id}><div><strong>{song.title}</strong><small>{song.code ?? '无编号'}{song.aliases.length > 0 ? ` · ${song.aliases.join('、')}` : ''}</small><span>点歌 {song.requestCount} 次 · 已演唱 {song.performedCount} 次</span></div><div><button type="button" onClick={() => beginSongEdit(song)}>修改</button><button type="button" className="is-danger" onClick={() => void deactivateSong(song)}>停用</button></div></article>)}</div></section>}
    {form === 'schedule' && <form className="staff-module-form" onSubmit={(event) => void createSchedule(event)}><header><strong>新增演出场次</strong><small>保存后立即进入当前排班并对顾客可见，请先核对时间。</small></header><label>演员<select required value={schedulePerformerId || performers[0]?.id || ''} onChange={(event) => setSchedulePerformerId(event.target.value)}><option value="">请选择</option>{performers.filter((performer) => performer.status === 'active').map((performer) => <option value={performer.id} key={performer.id}>{performer.stageName}</option>)}</select></label><label>开始时间<input required type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><label>结束时间<input required type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label><button type="submit" disabled={busyKey !== null || performers.length === 0}>{busyKey === 'schedule-create' ? '保存中' : '确认保存并展示'}</button></form>}
    {stalePhases.map((phase) => <div key={phase.publicId} className="staff-performance-phase staff-performance-phase-alert"><div><strong>发现未关闭的阶段记录</strong><small>{phase.performerStageName} · {performancePhaseCodeLabel(phase.phaseCode)}；对应场次已不在演出中，受限商品已停止推荐。</small></div>{canManagePhase && <div><button type="button" className="is-danger" disabled={busyKey !== null} onClick={() => transitionPhase(phase, 'cancel')}>取消过期记录</button></div>}</div>)}
    {schedules.length === 0 ? <EmptyState text="今日暂无演出排班" /> : <div className="staff-module-list">
      {schedules.map((schedule) => {
        const activePhase = phases.find((phase) => phase.scheduleId === schedule.id && phase.status === 'active')
        return <article key={schedule.id} className={schedule.status === 'performing' ? 'has-performance-phase' : undefined}>
          <div><strong>{schedule.performerStageName}</strong><small>{formatTime(schedule.startsAt)} - {formatTime(schedule.endsAt)}</small></div>
          <div className="staff-inline-actions"><em>{scheduleStatus(schedule.status)}</em>{canManage && schedule.status === 'scheduled' && <button type="button" disabled={busyKey !== null} onClick={() => transitionSchedule(schedule, 'performing')}>开始</button>}{canManage && schedule.status === 'performing' && activePhase === undefined && <button type="button" disabled={busyKey !== null} onClick={() => transitionSchedule(schedule, 'completed')}>结束整场</button>}</div>
          {schedule.status === 'performing' && <div className="staff-performance-phase">
            {activePhase === undefined
              ? <>
                <div><strong>推荐阶段尚未确认</strong><small>受阶段限制的商品当前不会进入推荐。</small></div>
                {canManagePhase && <div><select aria-label="现场演出阶段" value={phaseChoice[schedule.id] ?? 'band_live'} onChange={(event) => setPhaseChoice((current) => ({ ...current, [schedule.id]: event.target.value as PerformancePhaseCode }))}><option value="before_show">演出前</option><option value="acoustic">不插电</option><option value="band_live">乐队现场</option><option value="intermission">中场</option><option value="after_show">演出后</option></select><button type="button" disabled={busyKey !== null} onClick={() => startPhase(schedule)}>开始阶段</button></div>}
              </>
              : <>
                <div><strong>{performancePhaseCodeLabel(activePhase.phaseCode)}</strong><small>{formatTime(activePhase.startedAt)} 开始 · 已作为推荐硬门禁</small></div>
                {canManagePhase && <div><button type="button" disabled={busyKey !== null} onClick={() => transitionPhase(activePhase, 'end')}>结束阶段</button><button type="button" className="is-danger" disabled={busyKey !== null} onClick={() => transitionPhase(activePhase, 'cancel')}>取消记录</button></div>}
              </>}
          </div>}
        </article>
      })}
    </div>}
    <PerformanceRevisionPanel api={api} auth={auth} schedules={schedules} onChanged={onChanged} />
    {requests.length > 0 && <section className="staff-song-requests"><h3>点歌待办</h3>{requests.slice(0, 8).map((request) => <article key={request.id}><div><strong>{request.songTitle}</strong><span>{songStatus(request.status)}</span></div>{canManage && request.status === 'requested' && <div className="staff-song-actions"><label>报价（元）<input inputMode="decimal" value={quotes[request.id] ?? ''} onChange={(event) => setQuotes((current) => ({ ...current, [request.id]: event.target.value }))} placeholder="0" /></label><button type="button" disabled={busyKey !== null} onClick={() => transitionSong(request, 'confirm')}>接受</button><button type="button" className="is-danger" disabled={busyKey !== null} onClick={() => transitionSong(request, 'reject')}>拒绝</button></div>}{canManage && request.status === 'paid' && <button type="button" disabled={busyKey !== null} onClick={() => transitionSong(request, 'performed')}>已演唱</button>}{canManage && request.status === 'accepted' && <button type="button" className="is-danger" disabled={busyKey !== null} onClick={() => transitionSong(request, 'cancel')}>取消</button>}</article>)}</section>}
  </div>
}

function InventoryModule({ api, auth, view, onChanged }: { api: NormalizedApiClient; auth: StaffAuthView; view: InventoryView | null; onChanged(): Promise<void> }) {
  const [mode, setMode] = useState<'create' | 'count' | 'waste' | 'receive' | 'bind' | null>(null)
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [scanCode, setScanCode] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [batchCode, setBatchCode] = useState('')
  const [packages, setPackages] = useState('1')
  const [totalCostYuan, setTotalCostYuan] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [packageQuantity, setPackageQuantity] = useState('1')
  const [codeType, setCodeType] = useState<'barcode' | 'qr'>('barcode')
  const [newItemSku, setNewItemSku] = useState('')
  const [newItemName, setNewItemName] = useState('')
  const [newItemBaseUnit, setNewItemBaseUnit] = useState<'ml' | 'bottle' | 'piece'>('bottle')
  const [newItemLowStockThreshold, setNewItemLowStockThreshold] = useState('')
  const [pendingReceipt, setPendingReceipt] = useState<PurchaseReceiptCommandView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [catalogOpenRequest, setCatalogOpenRequest] = useState(0)
  const canManageCatalog = auth.permissions.includes('catalog.product.manage')
  if (view === null) return <div className="staff-module-body"><EmptyState text="库存数据暂时为空" />{canManageCatalog && <CatalogManagementPanel api={api} auth={auth} placement="inventory" openRequest={catalogOpenRequest} />}</div>
  const lowStock = view.items.filter((item) => item.lowStock)
  const visibleItems = [...lowStock, ...view.items.filter((item) => !item.lowStock)].slice(0, 20)
  const canCount = auth.permissions.includes('inventory.count')
  const canWaste = auth.permissions.includes('inventory.waste')
  const canReceive = auth.permissions.includes('inventory.receive')
  const canManage = auth.permissions.includes('inventory.manage')
  const draftReceipts = view.receipts.filter((receipt) => receipt.status === 'draft' && receipt.id !== pendingReceipt?.id)
  const bindableItems = view.items.filter((item) => item.categoryCode !== 'food' && (item.itemType === 'ingredient' || item.itemType === 'bottle'))
  const selectedBindableItem = bindableItems.find((item) => item.id === itemId) ?? null

  const modeLabel: Record<Exclude<typeof mode, null>, string> = {
    create: '新建酒水物料', receive: '手机扫码入库', bind: '首次绑定条码', count: '单项盘点', waste: '登记损耗',
  }

  function chooseMode(nextMode: Exclude<typeof mode, null>) {
    const next = mode === nextMode ? null : nextMode
    setMode(next)
    setNotice(next === null ? `已收起“${modeLabel[nextMode]}”` : `已切换至“${modeLabel[nextMode]}”，请填写并确认后再提交`)
    if (nextMode !== 'receive') setPendingReceipt(null)
  }

  function acceptScan(code: string) {
    setScanCode(code)
    setScannerOpen(false)
    setNotice('条码已识别，请核对后继续')
  }

  async function createInventoryItem(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const sku = newItemSku.trim()
    const name = newItemName.trim()
    const threshold = newItemLowStockThreshold.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(sku)) { setNotice('物料编号需为1至64位字母、数字、点、下划线或连字符'); return }
    if (name.length < 2 || name.length > 200) { setNotice('请填写2至200字的酒水物料名称'); return }
    if (threshold !== '' && !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(threshold)) { setNotice('安全库存必须是非负数字'); return }
    setBusy(true)
    setNotice('')
    try {
      const item = await api.postEndpoint<InventoryItemView>('/api/inventory/items', {
        sku,
        name,
        itemType: 'bottle',
        baseUnit: newItemBaseUnit,
        categoryCode: 'drinks',
        lowStockThreshold: threshold === '' ? null : threshold,
        wholeUnitCount: newItemBaseUnit === 'bottle' || newItemBaseUnit === 'piece',
        reasonableWasteQuantity: '0',
      }, { idempotencyKey: operationIdempotency('inventory-item-create') })
      setItemId(item.id)
      setNewItemSku('')
      setNewItemName('')
      setNewItemLowStockThreshold('')
      setMode('bind')
      setNotice(`${item.name} 已建立。下一步请绑定条码，随后即可扫码建立待收货单。`)
      await onChanged()
    } catch (error) {
      setNotice(inventoryActionMessage(error, '酒水物料未建立'))
    } finally {
      setBusy(false)
    }
  }

  async function submitInventoryAction(event: React.FormEvent) {
    event.preventDefault()
    if (mode === null || busy) return
    if (!itemId || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(quantity)) { setNotice('请选择物料并填写有效数量'); return }
    if (mode === 'waste' && reason.trim().length < 1) { setNotice('损耗必须填写原因'); return }
    setBusy(true)
    setNotice('')
    try {
      if (mode === 'count') {
        const count = await api.postEndpoint<{ id: string }>('/api/inventory/stock-counts', {
          lines: [{ inventoryItemId: itemId, countedQuantity: quantity, reason: reason.trim() || null }],
          note: '员工端单项盘点',
        }, { idempotencyKey: operationIdempotency('inventory-count-create') })
        await api.postEndpoint(`/api/inventory/stock-counts/${count.id}/submit`, {}, { idempotencyKey: operationIdempotency('inventory-count-submit') })
        setNotice('盘点已提交，等待有审批权限的岗位复核')
      } else {
        await api.postEndpoint(`/api/inventory/items/${itemId}/waste`, { quantity, reason: reason.trim() }, { idempotencyKey: operationIdempotency('inventory-waste') })
        setNotice('损耗已登记，库存数量已按服务端结果更新')
      }
      setQuantity('')
      setReason('')
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '库存操作未完成')
    } finally {
      setBusy(false)
    }
  }

  async function createReceipt(event: React.FormEvent) {
    event.preventDefault()
    if (busy || pendingReceipt !== null) return
    const normalizedCode = scanCode.trim()
    const totalCostMinor = yuanInputToMinor(totalCostYuan)
    if (normalizedCode.length < 3 || normalizedCode.length > 128) { setNotice('请扫描或输入有效条码'); return }
    if (batchCode.trim().length < 1) { setNotice('请填写批次号，可使用送货单号或当天批次'); return }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(packages) || packages === '0') { setNotice('请填写有效的包装数量'); return }
    if (totalCostMinor === null) { setNotice('本次总额最多保留两位小数'); return }
    setBusy(true)
    setNotice('')
    try {
      const receipt = await api.postEndpoint<PurchaseReceiptCommandView>('/api/inventory/receipts', {
        supplierSnapshot: supplierName.trim() === '' ? {} : { name: supplierName.trim() },
        currency: 'CNY',
        invoiceTotalMinor: totalCostMinor,
        note: '员工手机扫码创建，待实物验收确认',
        lines: [{
          scanCode: normalizedCode,
          batchCode: batchCode.trim(),
          packages,
          totalCostMinor,
          metadata: { entryMethod: 'staff_mobile_camera' },
        }],
      }, { idempotencyKey: operationIdempotency('inventory-receipt-create') })
      setPendingReceipt(receipt)
      setNotice('收货单已建立，库存尚未增加。请核对实物后进行第二次确认。')
      await onChanged()
    } catch (error) {
      setNotice(inventoryActionMessage(error, '收货单未建立；若提示条码未绑定，请由库存管理员先绑定'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmReceipt(receipt: { id: string }) {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      await api.postEndpoint<PurchaseReceiptCommandView>(`/api/inventory/receipts/${receipt.id}/receive`, {}, {
        idempotencyKey: operationIdempotency('inventory-receipt-confirm'),
      })
      setNotice('实物已确认入库，库存数量已更新')
      if (pendingReceipt?.id === receipt.id) {
        setPendingReceipt(null)
        setScanCode('')
        setBatchCode('')
        setPackages('1')
        setTotalCostYuan('')
        setSupplierName('')
      }
      await onChanged()
    } catch (error) {
      setNotice(inventoryActionMessage(error, '入库确认未完成'))
    } finally {
      setBusy(false)
    }
  }

  async function bindCode(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const normalizedCode = scanCode.trim()
    if (!itemId || normalizedCode.length < 3 || normalizedCode.length > 128) { setNotice('请选择酒水物料并扫描有效条码'); return }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(packageQuantity) || packageQuantity === '0') { setNotice('请填写每个条码包装包含的有效数量'); return }
    setBusy(true)
    setNotice('')
    try {
      await api.postEndpoint(`/api/inventory/items/${itemId}/barcodes`, {
        code: normalizedCode,
        codeType,
        packageQuantity,
      }, { idempotencyKey: operationIdempotency('inventory-barcode-bind') })
      setNotice('条码已绑定。以后收货人员可直接扫码建立收货单。')
    } catch (error) {
      setNotice(inventoryActionMessage(error, '条码绑定未完成'))
    } finally {
      setBusy(false)
    }
  }

  return <div className="staff-module-body">
    <div className={`staff-module-summary${view.lowStockCount > 0 ? ' has-attention' : ''}`}><span><PackageSearch size={18} /></span><div><strong>{view.lowStockCount} 项低库存 · {view.items.length} 项物料</strong><small>{view.receipts.length} 笔进货记录 · {view.storedBottles.length} 笔存酒</small></div></div>
    <section className="inventory-selling-flow" aria-label="酒水从建档到小程序可售流程"><header><div><strong>酒水从建档到小程序可售</strong><small>只按下面顺序操作；每一步都保留库存、售价与权限校验，不会因为集中操作而绕过实际库存。</small></div><em>5 步</em></header><ol><li><b>01</b><span><strong>建立物料</strong><small>新酒款先建立库存物料。</small></span>{canManage && <button type="button" onClick={() => chooseMode('create')}>开始</button>}</li><li><b>02</b><span><strong>绑定并扫码收货</strong><small>首次绑定条码；每次收货都需实物确认。</small></span>{canReceive && <button type="button" onClick={() => chooseMode('receive')}>扫码入库</button>}</li><li><b>03</b><span><strong>确认实际库存</strong><small>核对待收货单；差异走盘点，不手工放行。</small></span>{draftReceipts.length > 0 && <em>待确认 {draftReceipts.length}</em>}</li><li><b>04</b><span><strong>建立商品与售价</strong><small>默认先保存为停用，避免未配方就上架。</small></span>{canManageCatalog && <button type="button" onClick={() => setCatalogOpenRequest((current) => current + 1)}>继续</button>}</li><li><b>05</b><span><strong>配置配方并小程序上架</strong><small>系统会明确列出仍未满足的小程序可售条件。</small></span>{canManageCatalog && <button type="button" onClick={() => setCatalogOpenRequest((current) => current + 1)}>检查</button>}</li></ol></section>
    {notice !== '' && <p className="staff-module-notice" role="status">{notice}</p>}
    {(canCount || canWaste || canReceive || canManage) && <div className="staff-module-actions" aria-label="库存操作">
      {canManage && <button type="button" className={mode === 'create' ? 'is-active' : ''} aria-pressed={mode === 'create'} onClick={() => chooseMode('create')}>新建酒水物料</button>}
      {canReceive && <button type="button" className={`is-primary${mode === 'receive' ? ' is-active' : ''}`} aria-pressed={mode === 'receive'} onClick={() => chooseMode('receive')}><ScanLine size={16} />手机扫码入库</button>}
      {canManage && <button type="button" className={mode === 'bind' ? 'is-active' : ''} aria-pressed={mode === 'bind'} onClick={() => chooseMode('bind')}>首次绑定条码</button>}
      {canCount && <button type="button" className={mode === 'count' ? 'is-active' : ''} aria-pressed={mode === 'count'} onClick={() => chooseMode('count')}>单项盘点</button>}
      {canWaste && <button type="button" className={mode === 'waste' ? 'is-active' : ''} aria-pressed={mode === 'waste'} onClick={() => chooseMode('waste')}>登记损耗</button>}
    </div>}
    {mode === 'create' && <form className="staff-module-form inventory-create-form" onSubmit={(event) => void createInventoryItem(event)}>
      <header><strong>新建酒水物料</strong><small>用于新酒款、瓶装酒或配方原料。建立物料本身不增加库存；成本和数量请在后续收货单中如实登记并确认。</small></header>
      <label>物料编号<input required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={newItemSku} onChange={(event) => setNewItemSku(event.target.value)} placeholder="例如 WHISKY-SIM-700ML" /></label>
      <label>物料名称<input required maxLength={200} value={newItemName} onChange={(event) => setNewItemName(event.target.value)} placeholder="例如 演练用威士忌 700ml" /></label>
      <label>库存单位<select value={newItemBaseUnit} onChange={(event) => setNewItemBaseUnit(event.target.value as 'ml' | 'bottle' | 'piece')}><option value="bottle">瓶</option><option value="ml">毫升（ml）</option><option value="piece">件</option></select></label>
      <label>安全库存（选填）<input inputMode="decimal" value={newItemLowStockThreshold} onChange={(event) => setNewItemLowStockThreshold(event.target.value)} placeholder={newItemBaseUnit === 'ml' ? '例如 1500' : '例如 3'} /></label>
      <button type="submit" disabled={busy}>{busy ? '正在建立' : '建立物料并继续绑定条码'}</button>
    </form>}
    {canReceive && draftReceipts.length > 0 && <section className="inventory-draft-receipts" aria-label="待确认收货单">
      <header><strong>待确认收货</strong><small>刷新或退出页面后仍可在这里继续。确认实物前不会增加库存。</small></header>
      {draftReceipts.map((receipt) => <article key={receipt.id}><div><strong>{receipt.publicId}</strong><small>{receipt.lineCount} 项 · {formatDateTime(receipt.createdAt)}</small>{receipt.lines.map((line) => <span key={`${line.inventoryItemId}:${line.batchCode}`}>{line.itemName} · 批次 {line.batchCode} · {line.quantity}{line.baseUnit}</span>)}</div><button type="button" disabled={busy} onClick={() => void confirmReceipt(receipt)}>{busy ? '正在确认' : '核对并确认入库'}</button></article>)}
    </section>}
    {(mode === 'count' || mode === 'waste') && <form className="staff-module-form" onSubmit={(event) => void submitInventoryAction(event)}><header><strong>{mode === 'count' ? '单项盘点' : '登记损耗'}</strong><small>{mode === 'count' ? '提交后由有审批权限的岗位复核差异。' : '提交后立即形成库存流水，请如实填写原因。'}</small></header><label>物料<select required value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">请选择</option>{view.items.map((item) => <option value={item.id} key={item.id}>{item.name} · 当前{item.availableQuantity}{item.baseUnit}</option>)}</select></label><label>{mode === 'count' ? '实盘数量' : '损耗数量'}<input required inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><label>{mode === 'count' ? '差异说明（选填）' : '损耗原因'}<input required={mode === 'waste'} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? '提交中' : mode === 'count' ? '提交盘点复核' : '确认登记损耗'}</button></form>}
    {mode === 'receive' && pendingReceipt === null && <form className="staff-module-form inventory-receipt-form" onSubmit={(event) => void createReceipt(event)}>
      <header><strong>手机扫码建立收货单</strong><small>第一步只登记待收货，不改变库存；建立后还需核对实物并再次确认。</small></header>
      <label className="inventory-code-field">酒瓶条形码或二维码<div><input required autoComplete="off" maxLength={128} value={scanCode} onChange={(event) => setScanCode(event.target.value.replace(/\s/g, ''))} placeholder="点击右侧用手机扫描" /><button type="button" onClick={() => setScannerOpen(true)}><ScanLine size={17} />扫码</button></div></label>
      <label>批次号<input required maxLength={128} value={batchCode} onChange={(event) => setBatchCode(event.target.value)} placeholder="送货单号或当天批次" /></label>
      <label>包装数量<input required inputMode="decimal" value={packages} onChange={(event) => setPackages(event.target.value)} placeholder="1" /></label>
      <label>本行货款总额（元）<input required inputMode="decimal" value={totalCostYuan} onChange={(event) => setTotalCostYuan(event.target.value)} placeholder="0.00" /><small>服务端会按条码包装量和实际数量计算库存单位成本，避免把整瓶价格误记为每毫升价格。</small></label>
      <label>供应商（选填）<input maxLength={200} value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? '正在建立' : '第一步：建立待收货单'}</button>
    </form>}
    {mode === 'receive' && pendingReceipt !== null && <section className="inventory-receipt-confirm"><header><strong>待实物确认</strong><small>{pendingReceipt.publicId} · {pendingReceipt.lineCount} 项</small></header><p>条码 {scanCode} · 批次 {batchCode} · {packages} 个包装 · 总额 ¥{totalCostYuan}。请核对酒水、数量和送货单；点击确认后才会正式增加库存。</p><button type="button" disabled={busy} onClick={() => void confirmReceipt(pendingReceipt)}>{busy ? '正在确认' : '第二步：确认实物无误并入库'}</button></section>}
    {mode === 'bind' && <form className="staff-module-form inventory-bind-form" onSubmit={(event) => void bindCode(event)}>
      <header><strong>首次绑定酒水条码</strong><small>只在新酒款或新包装首次出现时操作。条码只能绑定一个物料，绑定后普通收货岗位可直接扫码。</small></header>
      <label>酒水原料或瓶装酒<select required value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">请选择</option>{bindableItems.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.sku} · 单位 {item.baseUnit}</option>)}</select></label>
      <label className="inventory-code-field">条形码或二维码<div><input required autoComplete="off" maxLength={128} value={scanCode} onChange={(event) => setScanCode(event.target.value.replace(/\s/g, ''))} /><button type="button" onClick={() => setScannerOpen(true)}><ScanLine size={17} />扫码</button></div></label>
      <label>码类型<select value={codeType} onChange={(event) => setCodeType(event.target.value as 'barcode' | 'qr')}><option value="barcode">商品条形码</option><option value="qr">二维码</option></select></label>
      <label>每个条码包装计入数量（{selectedBindableItem?.baseUnit ?? '库存单位'}）<input required inputMode="decimal" value={packageQuantity} onChange={(event) => setPackageQuantity(event.target.value)} /><small>例如750ml酒瓶填750；按整瓶计数的物料填1。</small></label>
      <button type="submit" disabled={busy}>{busy ? '正在绑定' : '确认绑定条码'}</button>
    </form>}
    {visibleItems.length === 0 ? <EmptyState text="当前没有库存物料" /> : <div className="staff-module-list">{visibleItems.map((item) => <article key={item.id} className={item.lowStock ? 'has-attention' : ''}><div><strong>{item.name}</strong><small>{item.sku} · 可用 {item.availableQuantity} {item.baseUnit}</small></div><em>{item.lowStock ? '需补货' : '正常'}</em></article>)}</div>}
    <p className="staff-module-footnote">酒水按配方扣减库存；小吃和水果标记为暂不管理库存时不拦截下单。盘点须复核后生效，扫码进货必须经过建立收货单和实物确认两步。</p>
    {canManageCatalog && <CatalogManagementPanel api={api} auth={auth} placement="inventory" openRequest={catalogOpenRequest} />}
    {scannerOpen && <InventoryBarcodeScanner onClose={() => setScannerOpen(false)} onDetected={acceptScan} />}
  </div>
}

function OperationsModule({ view, sales, canViewProfit }: { view: ProfitView | null; sales: EmployeeSalesView[]; canViewProfit: boolean }) {
  if (!canViewProfit) return <div className="staff-module-body">
    <div className="staff-module-summary"><span><BarChart3 size={18} /></span><div><strong>客户与销售</strong><small>仅显示当前账号权限范围内的销售归属，不展示门店利润与成本。</small></div></div>
    {sales.length === 0 ? <EmptyState text="当前范围暂无销售归属数据" /> : <div className="staff-module-list">{sales.slice(0, 30).map((item) => <article key={`${item.employeeId}:${item.productId}`}><div><strong>{item.productName}</strong><small>{item.employeeDisplayName} · {item.quantity}件</small></div><b>¥{formatAmount(item.salesAmountMinor)}</b></article>)}</div>}
  </div>
  if (view === null) return <EmptyState text="本营业日暂无经营数据" />
  return <div className="staff-module-body">
    <div className="staff-module-summary"><span><BarChart3 size={18} /></span><div><strong>{view.range.startDate} 营业概览</strong><small>{view.status === 'complete' ? '数据已完整核对' : '当日数据暂估，后补成本会自动更新'}</small></div></div>
    <div className="staff-metric-grid">
      <article><small>实收净额</small><strong>¥{formatAmount(view.revenue.cash.netReceiptsMinor)}</strong></article>
      <article><small>已付成本</small><strong>¥{formatAmount(view.costs.cashPaidMinor)}</strong></article>
      <article><small>现金利润</small><strong className={view.profit.cashBasisMinor < 0 ? 'is-negative' : ''}>¥{formatSignedAmount(view.profit.cashBasisMinor)}</strong></article>
      <article><small>权责利润</small><strong className={view.profit.accrualBasisMinor < 0 ? 'is-negative' : ''}>¥{formatSignedAmount(view.profit.accrualBasisMinor)}</strong></article>
    </div>
    {view.caveats.length > 0 && <p className="staff-module-footnote">{view.caveats[0]}</p>}
  </div>
}

function DevicesModule({ api, auth, devices, jobs, bridges, routes, onChanged }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  devices: HardwareDeviceView[]
  jobs: PrintJobView[]
  bridges: PrintBridgeView[]
  routes: PrinterRouteView[]
  onChanged(): Promise<void>
}) {
  const [reason, setReason] = useState('现场人工检查后操作')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'overview' | 'bridge' | 'printer' | 'route'>('overview')
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string } | null>(null)
  const [printerCode, setPrinterCode] = useState('')
  const [editingPrinterId, setEditingPrinterId] = useState<string | null>(null)
  const [printerName, setPrinterName] = useState('')
  const [printerStation, setPrinterStation] = useState<'bar' | 'kitchen' | 'cashier'>('cashier')
  const [printBridgeId, setPrintBridgeId] = useState('')
  const [windowsQueueName, setWindowsQueueName] = useState('')
  const [printProfile, setPrintProfile] = useState<'escpos_58' | 'escpos_80' | 'windows_text'>('escpos_80')
  const [routeCode, setRouteCode] = useState('')
  const [editingRouteCode, setEditingRouteCode] = useState<string | null>(null)
  const [routeName, setRouteName] = useState('')
  const [routeStation, setRouteStation] = useState<'bar' | 'kitchen' | 'cashier'>('cashier')
  const [routePrinterId, setRoutePrinterId] = useState('')
  const [routeCopies, setRouteCopies] = useState('1')
  const canManagePrinter = auth.permissions.includes('printer.manage')
    || auth.permissions.includes('hardware.manage')
  const canCommand = auth.permissions.includes('hardware.command') || canManagePrinter
  const canRetry = auth.permissions.includes('print.retry') || canManagePrinter
  const attention = devices.filter((device) => device.connectivityStatus === 'offline' || device.connectivityStatus === 'degraded').length
    + jobs.filter((job) => job.status === 'failed' || job.status === 'dead').length
  const reportedPrinterQueues = bridges.find((bridge) => bridge.id === printBridgeId)?.queues ?? []
  const availablePrinterQueues = windowsQueueName !== '' && !reportedPrinterQueues.includes(windowsQueueName)
    ? [windowsQueueName, ...reportedPrinterQueues] : reportedPrinterQueues

  async function run(key: string, operation: () => Promise<unknown>, success: string) {
    if (busyKey !== null) return
    if (reason.trim().length < 3) { setNotice('请填写至少3个字的操作原因'); return }
    setBusyKey(key)
    setNotice('')
    try {
      await operation()
      setNotice(success)
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '设备操作未完成')
    } finally {
      setBusyKey(null)
    }
  }

  function command(device: HardwareDeviceView, commandType: 'test_print' | 'reconnect' | 'ping') {
    void run(`device-${device.id}-${commandType}`, () => api.postEndpoint(`/api/hardware/devices/${device.id}/commands`, {
      commandType, reason: reason.trim(),
    }, { idempotencyKey: operationIdempotency(`hardware-${commandType}`) }), commandType === 'ping' ? '连通检测已提交' : commandType === 'reconnect' ? '重连指令已提交' : '测试打印已提交')
  }

  function retry(job: PrintJobView) {
    if (!window.confirm(`确认重试“${job.printerName}”的失败任务？请先检查打印机，避免重复出单。`)) return
    void run(`job-${job.id}`, () => api.postEndpoint(`/api/hardware/print-jobs/${job.id}/retry`, { reason: reason.trim() }, {
      idempotencyKey: operationIdempotency('print-retry'),
    }), '打印任务已进入重试队列')
  }

  function createPairingCode() {
    void run('bridge-pairing', async () => {
      const response = await api.postEndpoint<{ data: { pairingCode: string; expiresAt: string } }>('/api/hardware/print-bridges/pairing-code', {
        reason: reason.trim(), ttlSeconds: 600,
      })
      setPairing(response.data)
    }, '一次性配对码已生成，请在10分钟内填入门店Windows打印桥')
  }

  function clearPrinterForm() {
    setEditingPrinterId(null); setPrinterCode(''); setPrinterName(''); setPrinterStation('cashier')
    setPrintBridgeId(''); setWindowsQueueName(''); setPrintProfile('escpos_80')
  }

  function openPrinter(device?: HardwareDeviceView) {
    if (device === undefined) clearPrinterForm()
    else {
      setEditingPrinterId(device.id); setPrinterCode(device.code); setPrinterName(device.name)
      setPrinterStation(device.stationCode === 'bar' || device.stationCode === 'kitchen' ? device.stationCode : 'cashier')
      setPrintBridgeId(device.printBridgeId ?? ''); setWindowsQueueName(device.windowsQueueName ?? '')
      setPrintProfile(device.printProfile ?? 'escpos_80')
    }
    setMode('printer')
  }

  function savePrinter(event: FormEvent) {
    event.preventDefault()
    const hasAnyBridgeField = printBridgeId !== '' || windowsQueueName.trim() !== ''
    if ((editingPrinterId === null || hasAnyBridgeField) && (!printBridgeId || !windowsQueueName.trim())) {
      setNotice('Windows打印必须同时选择打印桥和打印机队列'); return
    }
    const key = editingPrinterId === null ? 'printer-create' : `printer-update-${editingPrinterId}`
    void run(key, async () => {
      const bridgeFields = printBridgeId && windowsQueueName.trim()
        ? { printBridgeId, windowsQueueName: windowsQueueName.trim(), printProfile } : {}
      if (editingPrinterId === null) {
        await api.postEndpoint('/api/hardware/devices', {
          code: printerCode.trim(), name: printerName.trim(), deviceType: 'printer', stationCode: printerStation,
          ...bridgeFields, reason: reason.trim(),
        }, { idempotencyKey: operationIdempotency('printer-create') })
      } else {
        await api.patchEndpoint(`/api/hardware/devices/${editingPrinterId}`, {
          name: printerName.trim(), stationCode: printerStation, ...bridgeFields, reason: reason.trim(),
        }, { idempotencyKey: operationIdempotency('printer-update') })
      }
      clearPrinterForm(); setMode('overview')
    }, editingPrinterId === null
      ? '打印机已保存；下一步请配置打印分流并执行测试打印'
      : '打印机配置已更新；请重新执行检测和测试打印')
  }

  function setPrinterStatus(device: HardwareDeviceView, status: 'active' | 'paused') {
    const verb = status === 'active' ? '启用' : '暂停'
    if (!window.confirm(`确认${verb}“${device.name}”？${status === 'paused' ? '暂停后新任务不会再分流到这台打印机。' : '启用前请确认驱动、队列和实体测试页正常。'}`)) return
    void run(`printer-status-${device.id}-${status}`, () => api.patchEndpoint(`/api/hardware/devices/${device.id}`, {
      status, reason: reason.trim(),
    }, { idempotencyKey: operationIdempotency(`printer-${status}`) }), `打印机已${verb}`)
  }

  function saveRoute(event: FormEvent) {
    event.preventDefault()
    const copies = Number(routeCopies)
    if (!routePrinterId || !Number.isInteger(copies) || copies < 1 || copies > 5) { setNotice('请选择打印机，份数必须为1至5'); return }
    void run('route-save', async () => {
      await api.putEndpoint(`/api/hardware/printer-routes/${encodeURIComponent(routeCode.trim())}`, {
        name: routeName.trim(), stationCode: routeStation, printerDeviceId: routePrinterId,
        copies, priority: 100, status: 'active', reason: reason.trim(),
      }, { idempotencyKey: operationIdempotency('printer-route') })
      setEditingRouteCode(null); setRouteCode(''); setRouteName(''); setRoutePrinterId(''); setRouteCopies('1'); setMode('overview')
    }, '打印分流已保存；请测试打印并核对吧台、后厨或收银票据')
  }

  function openRoute(route?: PrinterRouteView) {
    if (route === undefined) {
      setEditingRouteCode(null); setRouteCode(''); setRouteName(''); setRouteStation('cashier')
      setRoutePrinterId(''); setRouteCopies('1')
    } else {
      setEditingRouteCode(route.code); setRouteCode(route.code); setRouteName(route.name)
      setRouteStation(route.stationCode); setRoutePrinterId(route.printerDeviceId); setRouteCopies(String(route.copies))
    }
    setMode('route')
  }

  function setRouteStatus(route: PrinterRouteView, status: 'active' | 'paused') {
    const verb = status === 'active' ? '启用' : '暂停'
    if (!window.confirm(`确认${verb}“${route.name}”打印分流？`)) return
    void run(`route-status-${route.id}-${status}`, () => api.putEndpoint(`/api/hardware/printer-routes/${encodeURIComponent(route.code)}`, {
      name: route.name, stationCode: route.stationCode, productCategoryCode: route.productCategoryCode,
      printerDeviceId: route.printerDeviceId, copies: route.copies, priority: route.priority,
      status, reason: reason.trim(),
    }, { idempotencyKey: operationIdempotency(`printer-route-${status}`) }), `打印分流已${verb}`)
  }

  function revokeBridge(bridge: PrintBridgeView) {
    if (!window.confirm(`确认撤销“${bridge.name}”的打印桥凭据？该电脑将立即不能领取新任务。`)) return
    void run(`bridge-revoke-${bridge.id}`, () => api.postEndpoint(`/api/hardware/print-bridges/${bridge.id}/revoke`, {
      reason: reason.trim(),
    }), '打印桥凭据已撤销，关联打印机已标记离线')
  }

  return <div className="staff-module-body">
    <div className={`staff-module-summary${attention > 0 ? ' has-attention' : ''}`}><span><Printer size={18} /></span><div><strong>{devices.length} 台设备 · {jobs.length} 项打印待办</strong><small>{attention > 0 ? `${attention} 项需要管理员检查` : '当前没有设备或打印异常'}</small></div></div>
    {(canCommand || canRetry) && <label className="staff-device-reason">本次操作原因<input value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></label>}
    {notice !== '' && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManagePrinter && <section className="staff-print-setup-flow">
      <header><div><strong>打印机上线流程</strong><small>按顺序完成，配置、在线状态、路由和测试都集中在这里。</small></div><em>{bridges.some((bridge) => bridge.online) && routes.some((route) => route.status === 'active') ? '可联调' : '待配置'}</em></header>
      <ol>
        <li><b>1</b><span><strong>连接门店电脑</strong><small>安装Windows打印桥并用一次性码配对</small></span><button type="button" onClick={() => setMode('bridge')}>打开</button></li>
        <li><b>2</b><span><strong>登记打印机</strong><small>填写Windows队列、纸宽和所在位置</small></span><button type="button" onClick={() => openPrinter()}>打开</button></li>
        <li><b>3</b><span><strong>配置分流</strong><small>吧台、后厨、收银分别选择目标打印机</small></span><button type="button" onClick={() => openRoute()}>打开</button></li>
        <li><b>4</b><span><strong>测试并验收</strong><small>实体出纸后核对标题、桌号、订单号和备注</small></span><button type="button" onClick={() => setMode('overview')}>查看设备</button></li>
      </ol>
    </section>}
    {mode === 'bridge' && canManagePrinter && <section className="staff-module-form staff-print-config">
      <header><strong>门店Windows打印桥</strong><small>打印桥作为系统服务随电脑开机启动，不使用员工账号；门店电脑只主动通过HTTPS领取任务。</small></header>
      <button type="button" disabled={busyKey !== null} onClick={createPairingCode}>生成10分钟一次性配对码</button>
      {pairing && <div className="staff-print-pairing"><strong>{pairing.pairingCode}</strong><small>有效至 {formatDateTime(pairing.expiresAt)}。只输入到门店打印桥，不要发到群聊或截图留存。</small></div>}
      <div className="staff-print-bridge-list">{bridges.length === 0 ? <p>尚无已配对打印桥。</p> : bridges.map((bridge) => <article key={bridge.id}><div><strong>{bridge.name}</strong><small>{bridge.hostname} · 版本 {bridge.softwareVersion} · {bridge.printerCount}台打印机</small></div><em>{bridge.status === 'revoked' ? '已撤销' : bridge.online ? '在线' : '离线'}</em>{bridge.status === 'active' && <button type="button" className="is-danger" onClick={() => revokeBridge(bridge)}>撤销</button>}</article>)}</div>
    </section>}
    {mode === 'printer' && canManagePrinter && <form className="staff-module-form staff-print-config" onSubmit={savePrinter}>
      <header><strong>{editingPrinterId === null ? '登记Windows打印机' : '编辑打印机'}</strong><small>先在Windows“打印机和扫描仪”完成驱动和测试页；队列名称只从打印桥实际读取。</small></header>
      <label>设备编号<input required readOnly={editingPrinterId !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{1,63}" value={printerCode} onChange={(event) => setPrinterCode(event.target.value)} placeholder="例如 CASHIER-USB-01" /></label>
      <label>显示名称<input required maxLength={120} value={printerName} onChange={(event) => setPrinterName(event.target.value)} placeholder="例如 收银吧台USB打印机" /></label>
      <label>所在位置<select value={printerStation} onChange={(event) => setPrinterStation(event.target.value as typeof printerStation)}><option value="cashier">收银/吧台</option><option value="bar">吧台</option><option value="kitchen">后厨</option></select></label>
      <label>打印桥<select required value={printBridgeId} onChange={(event) => { setPrintBridgeId(event.target.value); setWindowsQueueName('') }}><option value="">请选择</option>{bridges.filter((bridge) => bridge.status === 'active').map((bridge) => <option key={bridge.id} value={bridge.id}>{bridge.name}（{bridge.online ? '在线' : '离线'}）</option>)}</select></label>
      <label>Windows打印机队列<select required value={windowsQueueName} onChange={(event) => setWindowsQueueName(event.target.value)}><option value="">{printBridgeId === '' ? '请先选择打印桥' : availablePrinterQueues.length === 0 ? '尚未读取到队列，请确认打印桥在线' : '请选择Windows队列'}</option>{availablePrinterQueues.map((queue) => <option value={queue} key={queue}>{queue}</option>)}</select><small>队列由门店电脑自动上报，避免手工输入错误。</small></label>
      <label>打印规格<select value={printProfile} onChange={(event) => setPrintProfile(event.target.value as typeof printProfile)}><option value="escpos_80">80毫米热敏票据</option><option value="escpos_58">58毫米热敏票据</option><option value="windows_text">Windows文本驱动</option></select></label>
      <div className="staff-inline-actions"><button type="submit" disabled={busyKey !== null}>保存打印机</button>{editingPrinterId !== null && <button type="button" onClick={() => { clearPrinterForm(); setMode('overview') }}>取消编辑</button>}</div>
    </form>}
    {mode === 'route' && canManagePrinter && <form className="staff-module-form staff-print-config" onSubmit={saveRoute}>
      <header><strong>配置打印分流</strong><small>酒水制作单去吧台，小吃制作单去后厨，支付成功后的消费凭条去收银打印机。</small></header>
      <label>分流编号<input required readOnly={editingRouteCode !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{1,63}" value={routeCode} onChange={(event) => setRouteCode(event.target.value)} placeholder="例如 CASHIER-RECEIPT" /></label>
      <label>分流名称<input required maxLength={120} value={routeName} onChange={(event) => setRouteName(event.target.value)} placeholder="例如 收银付款凭条" /></label>
      <label>业务内容<select value={routeStation} onChange={(event) => setRouteStation(event.target.value as typeof routeStation)}><option value="bar">酒水/调酒制作单</option><option value="kitchen">小吃/食品制作单</option><option value="cashier">付款凭条</option></select></label>
      <label>目标打印机<select required value={routePrinterId} onChange={(event) => setRoutePrinterId(event.target.value)}><option value="">请选择</option>{devices.filter((device) => device.deviceType === 'printer' && device.status === 'active').map((device) => <option key={device.id} value={device.id}>{device.name}（{device.windowsQueueName ?? '未配置队列'}）</option>)}</select></label>
      <label>打印份数<input required type="number" min={1} max={5} value={routeCopies} onChange={(event) => setRouteCopies(event.target.value)} /></label>
      <button type="submit" disabled={busyKey !== null}>保存打印分流</button>
    </form>}
    {routes.length > 0 && <section className="staff-song-requests"><h3>当前打印分流</h3>{routes.map((route) => <article key={route.id}><div><strong>{hardwareStationLabel(route.stationCode)} · {route.name}</strong><span>{devices.find((device) => device.id === route.printerDeviceId)?.name ?? '打印机已移除'} · {route.copies}份</span></div><div className="staff-inline-actions"><em>{route.status === 'active' ? '启用' : '暂停'}</em>{canManagePrinter && <button type="button" onClick={() => openRoute(route)}>编辑</button>}{canManagePrinter && route.status !== 'retired' && <button type="button" onClick={() => setRouteStatus(route, route.status === 'active' ? 'paused' : 'active')}>{route.status === 'active' ? '暂停' : '启用'}</button>}</div></article>)}</section>}
    {devices.length === 0 ? <EmptyState text="尚未配置真实打印或硬件设备" /> : <div className="staff-module-list">{devices.map((device) => <article key={device.id} className={device.connectivityStatus === 'offline' ? 'has-attention' : ''}><div><strong>{device.name}</strong><small>{device.stationCode ?? '全店'} · {hardwareType(device.deviceType)} · {device.status === 'active' ? '启用' : device.status === 'paused' ? '暂停' : '退役'}</small></div><div className="staff-inline-actions"><em>{connectivityLabel(device.connectivityStatus)}</em>{canManagePrinter && device.deviceType === 'printer' && <button type="button" disabled={busyKey !== null} onClick={() => openPrinter(device)}>编辑</button>}{canManagePrinter && device.deviceType === 'printer' && device.status !== 'retired' && <button type="button" disabled={busyKey !== null} onClick={() => setPrinterStatus(device, device.status === 'active' ? 'paused' : 'active')}>{device.status === 'active' ? '暂停' : '启用'}</button>}{canCommand && <button type="button" disabled={busyKey !== null || device.status !== 'active'} onClick={() => command(device, 'ping')}>检测</button>}{canCommand && device.connectivityStatus !== 'online' && <button type="button" disabled={busyKey !== null || device.status !== 'active'} onClick={() => command(device, 'reconnect')}>重连</button>}{canCommand && device.deviceType === 'printer' && <button type="button" disabled={busyKey !== null || device.status !== 'active'} onClick={() => command(device, 'test_print')}>测试打印</button>}</div></article>)}</div>}
    {jobs.some((job) => job.status === 'failed' || job.status === 'dead') && <section className="staff-song-requests"><h3>打印失败待办</h3>{jobs.filter((job) => job.status === 'failed' || job.status === 'dead').map((job) => <article key={job.id}><div><strong>{job.printerName}</strong><span>{job.stationCode} · 已尝试{job.attempts}/{job.maxAttempts}次</span></div>{canRetry ? <button type="button" disabled={busyKey !== null || job.status === 'dead'} onClick={() => retry(job)}>{job.status === 'dead' ? '已停止自动重试' : '检查后重试'}</button> : <span>需打印重试权限</span>}</article>)}</section>}
    {jobs.some((job) => job.status === 'failed' || job.status === 'dead') && <p className="staff-module-footnote">重试前必须确认设备在线并检查是否已实际出单；已停止自动重试的任务需管理员排查，不能直接重复发送。</p>}
  </div>
}

function SettingsModule({ api, auth, policy, onChanged }: { api: NormalizedApiClient; auth: StaffAuthView; policy: CommercePolicyView | null; onChanged(): Promise<void> }) {
  const [reason, setReason] = useState('')
  const [reservationMinutes, setReservationMinutes] = useState('10')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const canManagePayment = auth.permissions.includes('payment.policy.manage')
  const paymentPresentation = policy === null ? null : paymentPolicyPresentation(policy)

  useEffect(() => {
    if (policy !== null) setReservationMinutes(String(policy.paymentReservationMinutes))
  }, [policy])

  async function togglePayment() {
    if (policy === null || busy) return
    const target = !policy.policyOnlinePaymentEnabled
    if (reason.trim().length < 3) { setNotice('请填写至少3个字的调整原因'); return }
    if (!window.confirm(`确认${target ? '开放' : '关闭'}线上支付？顾客点单和员工协助收款将立即按新策略执行。`)) return
    setBusy(true)
    setNotice('')
    try {
      await api.patchEndpoint('/api/store/commerce-policy/online-payment', {
        enabled: target,
        expectedVersion: policy.policyVersion,
        reason: reason.trim(),
      }, { idempotencyKey: operationIdempotency('payment-policy') })
      setReason('')
      setNotice(`线上支付已${target ? '开放' : '关闭'}`)
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '支付策略未更新')
    } finally {
      setBusy(false)
    }
  }

  async function saveReservationPolicy() {
    if (policy === null || busy) return
    const minutes = Number(reservationMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 2 || minutes > 30) {
      setNotice('库存保留时间必须是2至30分钟的整数')
      return
    }
    if (reason.trim().length < 3) { setNotice('请填写至少3个字的调整原因'); return }
    if (!window.confirm(`确认将待付款库存保留时间调整为${minutes}分钟？新订单将立即按新策略执行。`)) return
    setBusy(true)
    setNotice('')
    try {
      await api.patchEndpoint('/api/store/commerce-policy/payment-reservation', {
        paymentReservationMinutes: minutes,
        expectedVersion: policy.policyVersion,
        reason: reason.trim(),
      }, { idempotencyKey: operationIdempotency('payment-reservation-policy') })
      setReason('')
      setNotice(`待付款库存保留时间已调整为${minutes}分钟`)
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '库存保留策略未更新')
    } finally {
      setBusy(false)
    }
  }

  return <div className="staff-module-body">
    <div className="staff-module-summary"><span><ShieldCheck size={18} /></span><div><strong>{auth.employee.roleCodes.join(' · ')}</strong><small>{auth.permissions.length} 项允许权限 · {auth.deniedPermissions.length} 项明确拒绝</small></div></div>
    <details className="staff-settings-scope">
      <summary><span><strong>查看当前可配置范围</strong><small>员工、设备、演出、支付和门店数据</small></span><ChevronRight size={17} /></summary>
      <div className="staff-settings-grid">
        <article><strong>员工与岗位</strong><span>{auth.permissions.includes('staff.access.configure') ? '可配置并留痕' : '只读'}</span></article>
        <article><strong>设备与打印</strong><span>{auth.permissions.includes('hardware.manage') || auth.permissions.includes('printer.manage') ? '可配置' : '只读'}</span></article>
        <article><strong>演员与演出</strong><span>{auth.permissions.includes('song.manage') ? '可配置' : '只读'}</span></article>
        <article><strong>线上支付开关</strong><span className={policy?.onlinePaymentEnabled === true ? '' : 'is-blocked'}>{canManagePayment ? paymentPresentation?.summary ?? '状态待读取' : '无管理权限'}</span></article>
        <article><strong>门店业务数据</strong><span>规范化数据库</span></article>
      </div>
    </details>
    {canManagePayment && policy !== null && paymentPresentation !== null && <section className={`staff-payment-policy${policy.onlinePaymentEnabled ? ' is-enabled' : ' is-disabled'}`}><header><div><small>门店经营策略 · 版本 {policy.policyVersion}</small><strong>{paymentPresentation.title}</strong></div><em>{policy.providerConfigured ? policy.provider === 'simulation' ? '模拟渠道' : '支付渠道已配置' : '支付渠道未配置'}</em></header><p>{paymentPresentation.detail}</p><label>待付款库存保留时间<div className="staff-payment-policy-inline"><input type="number" min={2} max={30} step={1} inputMode="numeric" value={reservationMinutes} onChange={(event) => setReservationMinutes(event.target.value)} /><span>分钟</span><button type="button" disabled={busy || Number(reservationMinutes) === policy.paymentReservationMinutes} onClick={() => void saveReservationPolicy()}>保存时限</button></div></label><label>调整原因<input value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="例如：高峰期调整待付款库存保留时间" /></label><button type="button" className={policy.policyOnlinePaymentEnabled ? 'is-danger' : ''} disabled={busy || (!policy.policyOnlinePaymentEnabled && !policy.providerConfigured)} onClick={() => void togglePayment()}>{busy ? '正在更新' : policy.policyOnlinePaymentEnabled ? '关闭线上支付' : '开放线上支付'}</button>{policy.reason !== null && <small>上次原因：{policy.reason}{policy.updatedAt === null ? '' : ` · ${formatDateTime(policy.updatedAt)}`}</small>}</section>}
    {notice !== '' && <p className="staff-module-notice" role="status">{notice}</p>}
    <details className="staff-module-disclosure"><summary>支付安全边界</summary><p className="staff-module-footnote">支付渠道密钥和远端连接只能由受控部署配置提供，门店开关不会读取、显示或覆盖它们。每次调整要求原因、版本校验、幂等键和审计记录；关闭只阻止新支付，不得中断在途回调、查单、退款或对账。</p></details>
    {auth.permissions.includes('table.manage') && <VenueManagementPanel api={api} />}
    {auth.permissions.includes('staff.access.configure') && <StaffAccessManagementPanel api={api} />}
  </div>
}

function EmptyState({ text }: { text: string }) {
  return <div className="staff-module-empty"><CheckCircle2 size={22} /><strong>{text}</strong><span>有新数据时刷新后会自动出现。</span></div>
}

function performanceView(value: unknown): PerformanceView | null {
  if (!isRecord(value) || typeof value.phase !== 'string' || !Array.isArray(value.schedules)) return null
  return {
    phase: value.phase,
    current: scheduleEntry(value.current),
    next: scheduleEntry(value.next),
    schedules: value.schedules.flatMap((entry) => scheduleEntry(entry) ?? []),
  }
}

function scheduleEntry(value: unknown): ScheduleEntry | null {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.performerStageName === 'string'
    && typeof value.startsAt === 'string'
    && typeof value.endsAt === 'string'
    && typeof value.status === 'string'
    ? value as ScheduleEntry : null
}

function performancePhaseEvents(value: unknown): PerformancePhaseEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): PerformancePhaseEvent[] => {
    if (!isRecord(entry)
      || typeof entry.publicId !== 'string'
      || typeof entry.scheduleId !== 'string'
      || typeof entry.performerStageName !== 'string'
      || !isPerformancePhaseCode(entry.phaseCode)
      || entry.status !== 'active'
      || typeof entry.startedAt !== 'string'
      || !(entry.endedAt === null || typeof entry.endedAt === 'string')
      || !(entry.cancelledAt === null || typeof entry.cancelledAt === 'string')) return []
    return [{
      publicId: entry.publicId,
      scheduleId: entry.scheduleId,
      performerStageName: entry.performerStageName,
      phaseCode: entry.phaseCode,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      cancelledAt: entry.cancelledAt,
    }]
  })
}

function isPerformancePhaseCode(value: unknown): value is PerformancePhaseCode {
  return value === 'before_show' || value === 'acoustic' || value === 'band_live'
    || value === 'intermission' || value === 'after_show'
}

function songRequests(value: unknown): SongRequestEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.songTitle === 'string'
    && typeof entry.status === 'string'
    && typeof entry.createdAt === 'string'
    ? [entry as SongRequestEntry] : [])
}

function performerEntries(value: unknown): PerformerEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.code === 'string'
    && typeof entry.stageName === 'string' && typeof entry.status === 'string'
    && isRecord(entry.profileSnapshot)
    ? [entry as PerformerEntry] : [])
}

function performerSongEntries(value: unknown): PerformerSongEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.performerId === 'string'
    && (typeof entry.code === 'string' || entry.code === null)
    && typeof entry.title === 'string' && Array.isArray(entry.aliases)
    && entry.aliases.every((alias) => typeof alias === 'string')
    && typeof entry.status === 'string' && typeof entry.requestCount === 'number'
    && typeof entry.performedCount === 'number'
    ? [entry as PerformerSongEntry] : [])
}

function parseSongImportRows(value: string): Array<{ code: string | null; title: string; aliases: string[] }> {
  const rows = value.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)
  if (rows.length > 5000) throw new Error('单次最多导入5000首歌曲')
  return rows.map((row, index) => {
    const columns = row.split('|').map((column) => column.trim())
    if (columns.length < 2 || columns.length > 3) throw new Error(`第${index + 1}行格式不正确`)
    const [code = '', title = '', aliasText = ''] = columns
    if (title.length < 1 || title.length > 240) throw new Error(`第${index + 1}行歌名不能为空且不能超过240字`)
    if (code.length > 64) throw new Error(`第${index + 1}行编号不能超过64字`)
    const aliases = aliasText.split(/[，,]/).map((alias) => alias.trim()).filter(Boolean)
    return { code: code || null, title, aliases }
  })
}

function inventoryView(value: unknown): InventoryView | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  return {
    items: value.items.flatMap((item) => isRecord(item)
      && typeof item.id === 'string' && typeof item.sku === 'string' && typeof item.name === 'string'
      && typeof item.itemType === 'string' && typeof item.baseUnit === 'string'
      && typeof item.categoryCode === 'string' && typeof item.availableQuantity === 'string' && typeof item.lowStock === 'boolean'
      ? [item as unknown as InventoryItemView] : []),
    lowStockCount: typeof value.lowStockCount === 'number' ? value.lowStockCount : 0,
    receipts: purchaseReceiptViews(value.receipts),
    storedBottles: Array.isArray(value.storedBottles) ? value.storedBottles : [],
  }
}

function purchaseReceiptViews(value: unknown): PurchaseReceiptView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): PurchaseReceiptView[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.publicId !== 'string'
      || typeof entry.status !== 'string' || typeof entry.lineCount !== 'number'
      || !Array.isArray(entry.lines)
      || typeof entry.createdAt !== 'string'
      || !(entry.receivedAt === null || typeof entry.receivedAt === 'string')) return []
    const lines = entry.lines.flatMap((line) => isRecord(line)
      && typeof line.inventoryItemId === 'string' && typeof line.itemName === 'string'
      && typeof line.batchCode === 'string' && typeof line.quantity === 'string' && typeof line.baseUnit === 'string'
      ? [{ inventoryItemId: line.inventoryItemId, itemName: line.itemName, batchCode: line.batchCode, quantity: line.quantity, baseUnit: line.baseUnit }] : [])
    return [{ id: entry.id, publicId: entry.publicId, status: entry.status, lineCount: entry.lineCount, lines, createdAt: entry.createdAt, receivedAt: entry.receivedAt }]
  })
}

function profitView(value: unknown): ProfitView | null {
  if (!isRecord(value) || !isRecord(value.range) || !isRecord(value.revenue) || !isRecord(value.costs) || !isRecord(value.profit)) return null
  const cash = isRecord(value.revenue.cash) ? value.revenue.cash : null
  if (cash === null || typeof cash.netReceiptsMinor !== 'number'
    || typeof value.costs.cashPaidMinor !== 'number' || typeof value.costs.accrualAllocatedMinor !== 'number'
    || typeof value.profit.cashBasisMinor !== 'number' || typeof value.profit.accrualBasisMinor !== 'number'
    || typeof value.range.startDate !== 'string' || typeof value.range.endDate !== 'string') return null
  return value as unknown as ProfitView
}

function hardwareDevices(value: unknown): HardwareDeviceView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.deviceType === 'string' && typeof item.status === 'string' && typeof item.connectivityStatus === 'string'
    ? [item as unknown as HardwareDeviceView] : [])
}

function printJobs(value: unknown): PrintJobView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item) && typeof item.id === 'string' && typeof item.printerName === 'string'
    && typeof item.stationCode === 'string' && typeof item.status === 'string'
    && typeof item.attempts === 'number' && typeof item.maxAttempts === 'number'
    ? [item as unknown as PrintJobView] : [])
}

function printBridges(value: unknown): PrintBridgeView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.publicId === 'string' && typeof item.name === 'string'
    && (item.status === 'active' || item.status === 'revoked') && typeof item.hostname === 'string'
    && typeof item.softwareVersion === 'string' && (typeof item.lastSeenAt === 'string' || item.lastSeenAt === null)
    && typeof item.printerCount === 'number' && typeof item.online === 'boolean'
    && Array.isArray(item.queues) && item.queues.every((queue) => typeof queue === 'string')
    ? [item as unknown as PrintBridgeView] : [])
}

function printerRoutes(value: unknown): PrinterRouteView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.code === 'string' && typeof item.name === 'string'
    && (item.stationCode === 'bar' || item.stationCode === 'kitchen' || item.stationCode === 'cashier')
    && (typeof item.productCategoryCode === 'string' || item.productCategoryCode === null)
    && typeof item.printerDeviceId === 'string' && typeof item.copies === 'number'
    && typeof item.priority === 'number' && typeof item.status === 'string'
    ? [item as unknown as PrinterRouteView] : [])
}

function employeeSales(value: unknown): EmployeeSalesView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.employeeId === 'string' && typeof item.employeeDisplayName === 'string'
    && typeof item.productId === 'string' && typeof item.productName === 'string'
    && typeof item.quantity === 'string' && typeof item.salesAmountMinor === 'number'
    && (typeof item.contributionProfitMinor === 'number' || item.contributionProfitMinor === null)
    && typeof item.currency === 'string' ? [item as unknown as EmployeeSalesView] : [])
}

function commercePolicyView(value: unknown): CommercePolicyView | null {
  if (!isRecord(value)
    || typeof value.configured !== 'boolean'
    || typeof value.policyOnlinePaymentEnabled !== 'boolean'
    || typeof value.onlinePaymentEnabled !== 'boolean'
    || typeof value.providerConfigured !== 'boolean'
    || !(value.provider === 'postar' || value.provider === 'simulation' || value.provider === null)
    || typeof value.paymentReservationMinutes !== 'number'
    || !Number.isSafeInteger(value.paymentReservationMinutes)
    || value.paymentReservationMinutes < 2
    || value.paymentReservationMinutes > 30
    || typeof value.policyVersion !== 'number'
    || !(typeof value.reason === 'string' || value.reason === null)
    || !(typeof value.updatedAt === 'string' || value.updatedAt === null)) return null
  return value as CommercePolicyView
}

function formatAmount(value: number): string { return (Math.abs(value) / 100).toFixed(2) }

function yuanInputToMinor(value: string): string | null {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null
  const [yuan = '0', fen = ''] = normalized.split('.')
  return (BigInt(yuan) * 100n + BigInt(`${fen}00`.slice(0, 2))).toString()
}

function inventoryActionMessage(error: unknown, fallback: string): string {
  if (error instanceof NormalizedApiError && error.message.trim() !== '') return error.message
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}
function formatSignedAmount(value: number): string { return `${value < 0 ? '-' : ''}${formatAmount(value)}` }
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}
function performancePhase(value: string | undefined): string {
  return ({ no_schedule: '今日暂无演出', upcoming: '演出尚未开始', live: '正在演出', between: '演出换场中', ended: '今日演出已结束' } as Record<string, string>)[value ?? ''] ?? '演出状态待确认'
}
function performancePhaseCodeLabel(value: PerformancePhaseCode): string {
  return ({
    before_show: '演出前', acoustic: '不插电', band_live: '乐队现场',
    intermission: '中场', after_show: '演出后',
  } as Record<PerformancePhaseCode, string>)[value]
}
function scheduleStatus(value: string): string { return ({ scheduled: '待演出', performing: '演出中', completed: '已结束', cancelled: '已取消' } as Record<string, string>)[value] ?? '状态待确认' }
function songStatus(value: string): string { return ({ requested: '待确认', accepted: '已接受', rejected: '未接受', paid: '已收费', performed: '已演唱', cancelled: '已取消' } as Record<string, string>)[value] ?? '状态待确认' }
function hardwareType(value: string): string { return ({ printer: '打印机', kds_display: '出品屏', cash_drawer: '钱箱', headset: '耳机', controller: '控制器' } as Record<string, string>)[value] ?? '其他设备' }
function hardwareStationLabel(value: string): string { return ({ bar: '吧台', kitchen: '后厨', cashier: '收银台' } as Record<string, string>)[value] ?? value }
function connectivityLabel(value: string): string { return ({ online: '在线', offline: '离线', degraded: '需检查', unknown: '未检测' } as Record<string, string>)[value] ?? '未检测' }
function operationIdempotency(scope: string): string { return `${scope}-${crypto.randomUUID()}` }
function localDateTimeIso(value: string): string {
  const instant = new Date(value)
  if (value.trim() === '' || !Number.isFinite(instant.getTime())) throw new TypeError('请填写有效的演出时间')
  return instant.toISOString()
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
