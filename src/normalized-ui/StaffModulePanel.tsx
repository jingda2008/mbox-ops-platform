import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  LoaderCircle,
  Music2,
  PackageSearch,
  Printer,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { NormalizedApiClient, NormalizedApiError, type StaffAuthView } from '../normalized-api'
import { StaffAccessManagementPanel } from './StaffAccessManagementPanel'
import './staff-module-panel.css'

export type StaffModule = 'payments' | 'performance' | 'inventory' | 'operations' | 'devices' | 'settings'

interface ReconciliationEntry extends Record<string, unknown> {
  id: string
  entryType: string
  amountMinor: number
  currency: string
  provider: string
  occurredAt: string
}

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

interface PerformanceView {
  phase: string
  current: ScheduleEntry | null
  next: ScheduleEntry | null
  schedules: ScheduleEntry[]
}

interface InventoryItemView {
  id: string
  sku: string
  name: string
  baseUnit: string
  availableQuantity: string
  lowStock: boolean
}

interface InventoryView {
  items: InventoryItemView[]
  lowStockCount: number
  receipts: unknown[]
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
  name: string
  deviceType: string
  stationCode: string | null
  status: string
  connectivityStatus: string
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

interface ModuleData {
  reconciliation: ReconciliationEntry[]
  pendingPayments: number
  performance: PerformanceView | null
  songRequests: SongRequestEntry[]
  inventory: InventoryView | null
  profit: ProfitView | null
  devices: HardwareDeviceView[]
  printJobs: PrintJobView[]
  employeeSales: EmployeeSalesView[]
}

const emptyData: ModuleData = {
  reconciliation: [],
  pendingPayments: 0,
  performance: null,
  songRequests: [],
  inventory: null,
  profit: null,
  devices: [],
  printJobs: [],
  employeeSales: [],
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

  const load = useCallback(async () => {
    setPhase('loading')
    setMessage(null)
    try {
      if (module === 'payments') {
        const [response, bootstrap] = await Promise.all([
          api.getEndpoint<{ data: unknown }>('/api/reconciliation?limit=50'),
          api.getStaffBootstrap(),
        ])
        setData({
          ...emptyData,
          reconciliation: reconciliationEntries(response.data),
          pendingPayments: bootstrap.data?.domainSummaries.find((summary) => summary.key === 'payments')?.activeCount ?? 0,
        })
      } else if (module === 'performance') {
        const [performance, requests] = await Promise.all([
          api.getEndpoint<{ data: unknown }>('/api/staff/performances/today'),
          api.getEndpoint<{ data: unknown }>('/api/staff/song-requests'),
        ])
        setData({
          ...emptyData,
          performance: performanceView(performance.data),
          songRequests: songRequests(requests.data),
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
      } else if (module === 'devices') {
        const [devices, jobs] = await Promise.all([
          api.getEndpoint<{ data: unknown }>('/api/hardware/devices'),
          api.getEndpoint<{ data: unknown }>('/api/hardware/print-jobs?status=pending,printing,failed,dead&limit=50'),
        ])
        setData({ ...emptyData, devices: hardwareDevices(devices.data), printJobs: printJobs(jobs.data) })
      } else {
        setData(emptyData)
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

  useEffect(() => { void load() }, [load])

  const content = useMemo(() => {
    if (module === 'payments') {
      return <PaymentsModule entries={data.reconciliation} pendingPayments={data.pendingPayments} />
    }
    if (module === 'performance') return <PerformanceModule view={data.performance} requests={data.songRequests} />
    if (module === 'inventory') return <InventoryModule view={data.inventory} />
    if (module === 'operations') return <OperationsModule view={data.profit} sales={data.employeeSales} canViewProfit={auth.permissions.includes('commercial.profit.view')} />
    if (module === 'devices') return <DevicesModule devices={data.devices} jobs={data.printJobs} />
    return <SettingsModule api={api} auth={auth} />
  }, [api, auth, data, module])

  const modulePresentation = {
    payments: { title: '收银与退款', icon: CircleDollarSign },
    performance: { title: '演出与点歌', icon: Music2 },
    inventory: { title: '库存与存酒', icon: PackageSearch },
    operations: { title: '经营数据', icon: BarChart3 },
    devices: { title: '设备与打印', icon: Printer },
    settings: { title: '系统配置状态', icon: Settings2 },
  } satisfies Record<StaffModule, { title: string; icon: typeof Settings2 }>
  const { title, icon: Icon } = modulePresentation[module]

  return <section className="staff-module-panel" aria-label={title} data-action-reveal>
    <header>
      <span><Icon size={20} /></span>
      <div><small>岗位工作面</small><h2>{title}</h2></div>
      <button type="button" aria-label={`刷新${title}`} onClick={() => void load()} disabled={phase === 'loading'}>
        <RefreshCw size={18} className={phase === 'loading' ? 'is-spinning' : ''} />
      </button>
    </header>
    {phase === 'loading' && <div className="staff-module-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在读取最新状态</strong></div>}
    {phase === 'error' && <div className="staff-module-state is-error" role="alert"><strong>暂时没有接上</strong><p>{message}</p><button type="button" onClick={() => void load()}>重试</button></div>}
    {phase === 'ready' && content}
  </section>
}

function PaymentsModule({ entries, pendingPayments }: {
  entries: ReconciliationEntry[]
  pendingPayments: number
}) {
  return <div className="staff-module-body">
    <div className={`staff-module-summary${pendingPayments > 0 ? ' has-attention' : ''}`}>
      <span><CheckCircle2 size={18} /></span>
      <div>
        <strong>{pendingPayments} 笔待确认支付 · {entries.length} 笔已确认流水</strong>
        <small>{pendingPayments > 0 ? '测试支付、未回调支付或待人工报送款项尚未入账' : '当前没有等待确认的支付'}</small>
      </div>
    </div>
    {entries.length === 0 ? <EmptyState text="本营业日暂无已确认收款或退款" /> : <div className="staff-module-list">
      {entries.map((entry) => <article key={entry.id}>
        <div><strong>{entry.entryType === 'refund' ? '退款' : entry.entryType === 'payment' ? '收款' : '账务调整'}</strong><small>{entry.provider} · {formatTime(entry.occurredAt)}</small></div>
        <b className={entry.entryType === 'refund' ? 'is-negative' : ''}>{entry.entryType === 'refund' ? '-' : '+'}¥{formatAmount(entry.amountMinor)}</b>
      </article>)}
    </div>}
    <p className="staff-module-footnote">退款仍需按权限完成申请、审批和人工执行；本页不会自动越权退款。</p>
  </div>
}

function PerformanceModule({ view, requests }: { view: PerformanceView | null; requests: SongRequestEntry[] }) {
  const schedules = view?.schedules ?? []
  return <div className="staff-module-body">
    <div className="staff-module-summary"><span><CalendarClock size={18} /></span><div><strong>{performancePhase(view?.phase)}</strong><small>{schedules.length} 个演出时段 · {requests.length} 条点歌需求</small></div></div>
    {schedules.length === 0 ? <EmptyState text="今日暂无已发布演出安排" /> : <div className="staff-module-list">
      {schedules.map((schedule) => <article key={schedule.id}>
        <div><strong>{schedule.performerStageName}</strong><small>{formatTime(schedule.startsAt)} - {formatTime(schedule.endsAt)}</small></div>
        <em>{scheduleStatus(schedule.status)}</em>
      </article>)}
    </div>}
    {requests.length > 0 && <section className="staff-song-requests"><h3>点歌待办</h3>{requests.slice(0, 8).map((request) => <article key={request.id}><strong>{request.songTitle}</strong><span>{songStatus(request.status)}</span></article>)}</section>}
  </div>
}

function InventoryModule({ view }: { view: InventoryView | null }) {
  if (view === null) return <EmptyState text="库存数据暂时为空" />
  const lowStock = view.items.filter((item) => item.lowStock)
  const visibleItems = [...lowStock, ...view.items.filter((item) => !item.lowStock)].slice(0, 20)
  return <div className="staff-module-body">
    <div className={`staff-module-summary${view.lowStockCount > 0 ? ' has-attention' : ''}`}><span><PackageSearch size={18} /></span><div><strong>{view.lowStockCount} 项低库存 · {view.items.length} 项物料</strong><small>{view.receipts.length} 笔进货记录 · {view.storedBottles.length} 笔存酒</small></div></div>
    {visibleItems.length === 0 ? <EmptyState text="当前没有库存物料" /> : <div className="staff-module-list">{visibleItems.map((item) => <article key={item.id} className={item.lowStock ? 'has-attention' : ''}><div><strong>{item.name}</strong><small>{item.sku} · 可用 {item.availableQuantity} {item.baseUnit}</small></div><em>{item.lowStock ? '需补货' : '正常'}</em></article>)}</div>}
    <p className="staff-module-footnote">订单完成后按配方扣减库存；低库存优先展示。入库、盘点和损耗登记仍按岗位权限留痕。</p>
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

function DevicesModule({ devices, jobs }: { devices: HardwareDeviceView[]; jobs: PrintJobView[] }) {
  const attention = devices.filter((device) => device.connectivityStatus === 'offline' || device.connectivityStatus === 'degraded').length
    + jobs.filter((job) => job.status === 'failed' || job.status === 'dead').length
  return <div className="staff-module-body">
    <div className={`staff-module-summary${attention > 0 ? ' has-attention' : ''}`}><span><Printer size={18} /></span><div><strong>{devices.length} 台设备 · {jobs.length} 项打印待办</strong><small>{attention > 0 ? `${attention} 项需要管理员检查` : '当前没有设备或打印异常'}</small></div></div>
    {devices.length === 0 ? <EmptyState text="尚未配置真实打印或硬件设备" /> : <div className="staff-module-list">{devices.map((device) => <article key={device.id} className={device.connectivityStatus === 'offline' ? 'has-attention' : ''}><div><strong>{device.name}</strong><small>{device.stationCode ?? '全店'} · {hardwareType(device.deviceType)}</small></div><em>{connectivityLabel(device.connectivityStatus)}</em></article>)}</div>}
    {jobs.some((job) => job.status === 'failed' || job.status === 'dead') && <p className="staff-module-footnote">存在打印失败任务。重试前先确认打印机在线，避免重复出单。</p>}
  </div>
}

function SettingsModule({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  if (auth.permissions.includes('staff.access.configure')) return <StaffAccessManagementPanel api={api} />
  return <div className="staff-module-body">
    <div className="staff-module-summary"><span><ShieldCheck size={18} /></span><div><strong>{auth.employee.roleCodes.join(' · ')}</strong><small>{auth.permissions.length} 项允许权限 · {auth.deniedPermissions.length} 项明确拒绝</small></div></div>
    <div className="staff-settings-grid">
      <article><strong>员工与岗位</strong><span>只读</span></article>
      <article><strong>设备与打印</strong><span>{auth.permissions.includes('hardware.manage') ? '可配置' : '只读'}</span></article>
      <article><strong>AI执行策略</strong><span>{auth.permissions.includes('ai.schedule') ? '可配置' : '只读'}</span></article>
      <article><strong>门店业务数据</strong><span>规范化数据库</span></article>
    </div>
    <p className="staff-module-footnote">这里先核对当前账号生效权限和配置状态。涉及权限、支付或库存的修改必须保留审计记录。</p>
  </div>
}

function EmptyState({ text }: { text: string }) {
  return <div className="staff-module-empty"><CheckCircle2 size={22} /><strong>{text}</strong><span>有新数据时刷新后会自动出现。</span></div>
}

function reconciliationEntries(value: unknown): ReconciliationEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.entryType === 'string'
    && typeof entry.amountMinor === 'number'
    && typeof entry.currency === 'string'
    && typeof entry.provider === 'string'
    && typeof entry.occurredAt === 'string'
    ? [entry as ReconciliationEntry] : [])
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

function songRequests(value: unknown): SongRequestEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.songTitle === 'string'
    && typeof entry.status === 'string'
    && typeof entry.createdAt === 'string'
    ? [entry as SongRequestEntry] : [])
}

function inventoryView(value: unknown): InventoryView | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  return {
    items: value.items.flatMap((item) => isRecord(item)
      && typeof item.id === 'string' && typeof item.sku === 'string' && typeof item.name === 'string'
      && typeof item.baseUnit === 'string' && typeof item.availableQuantity === 'string' && typeof item.lowStock === 'boolean'
      ? [item as unknown as InventoryItemView] : []),
    lowStockCount: typeof value.lowStockCount === 'number' ? value.lowStockCount : 0,
    receipts: Array.isArray(value.receipts) ? value.receipts : [],
    storedBottles: Array.isArray(value.storedBottles) ? value.storedBottles : [],
  }
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

function employeeSales(value: unknown): EmployeeSalesView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.employeeId === 'string' && typeof item.employeeDisplayName === 'string'
    && typeof item.productId === 'string' && typeof item.productName === 'string'
    && typeof item.quantity === 'string' && typeof item.salesAmountMinor === 'number'
    && (typeof item.contributionProfitMinor === 'number' || item.contributionProfitMinor === null)
    && typeof item.currency === 'string' ? [item as unknown as EmployeeSalesView] : [])
}

function formatAmount(value: number): string { return (Math.abs(value) / 100).toFixed(2) }
function formatSignedAmount(value: number): string { return `${value < 0 ? '-' : ''}${formatAmount(value)}` }
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
function performancePhase(value: string | undefined): string {
  return ({ no_schedule: '今日暂无演出', upcoming: '演出尚未开始', live: '正在演出', between: '演出换场中', ended: '今日演出已结束' } as Record<string, string>)[value ?? ''] ?? '演出状态待确认'
}
function scheduleStatus(value: string): string { return ({ scheduled: '待演出', performing: '演出中', completed: '已结束', cancelled: '已取消' } as Record<string, string>)[value] ?? '状态待确认' }
function songStatus(value: string): string { return ({ requested: '待确认', accepted: '已接受', rejected: '未接受', paid: '已收费', performed: '已演唱', cancelled: '已取消' } as Record<string, string>)[value] ?? '状态待确认' }
function hardwareType(value: string): string { return ({ printer: '打印机', kds_display: '出品屏', cash_drawer: '钱箱', headset: '耳机', controller: '控制器' } as Record<string, string>)[value] ?? '其他设备' }
function connectivityLabel(value: string): string { return ({ online: '在线', offline: '离线', degraded: '需检查', unknown: '未检测' } as Record<string, string>)[value] ?? '未检测' }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
