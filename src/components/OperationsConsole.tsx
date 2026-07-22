import {
  Banknote,
  BellRing,
  CalendarDays,
  CircleAlert,
  CircleCheckBig,
  CircleDot,
  ContactRound,
  CookingPot,
  ExternalLink,
  LayoutDashboard,
  House,
  ListTodo,
  Map as MapIcon,
  Menu,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Timer,
  Upload,
  UtensilsCrossed,
  UsersRound,
  Wifi,
  X,
  Gift,
  History,
  Heart,
  Music2,
  PackageSearch,
  Cpu,
  ChartNoAxesCombined,
  ArrowRightLeft,
  CircleDollarSign,
  DoorOpen,
  Link2,
  Minus,
  Plus,
  Trash2,
  Unlink,
  UserPlus,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  actOnTask,
  assignTableSessionSales,
  closeTableSession,
  createComplimentaryOrder,
  getCurrentActorId,
  getTableSessionSummary,
  handoverLegacyTableSession,
  managerCancelKdsTask,
  openWalkInTable,
  operateTableCombination,
  publishConfig,
  resetDemo,
  rollbackConfig,
  saveConfigDraft,
  snoozeAwaitingOrder,
  startAwaitingOrder,
  stopAwaitingOrder,
  transferTableSession,
  updateTableOperationsConfig,
} from '../api'
import type { ManagerKdsCancellationInput, ManagerKdsCancellationResult } from '../shared/commerce-api'
import type {
  BootstrapResponse,
  ConfigDraftInput,
  MinimumSpendRule,
  ServiceTask,
  StoreConfig,
  TableOperationsConfig,
  TableSessionSummary,
  TaskActionInput,
} from '../shared/contracts'
import { assistantHumanWorkflowIds, type AssistantCapabilityId } from '../shared/assistant-tool-contracts'
import { effectiveDataScopeForEmployee, effectiveRoleIdsForEmployee } from '../shared/staff-access'
import { formatChinaDateTime, formatChinaTime } from '../shared/china-time'
import { TaskQueue } from './TaskQueue'
import { getFulfillmentAccess, kdsTaskOperationallyActive, taskVisibleToAccess } from './commerce-workspace'
import { RoleHomeView } from './RoleHomeView'
import { buildRoleHomeModel, type RoleHomeNavigationId } from './role-access'
import { salesAttributionEmployees } from './sales-attribution'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import { SopVerificationInbox } from './SopVerificationInbox'
import { BeijingClock } from './live-time'
import { runOptimisticAction } from '../optimistic-action'
import { projectServiceTask } from '../optimistic-projections'
import './OperationsConsole.css'

const MasterDataView = lazy(() => import('./MasterDataView').then((module) => ({ default: module.MasterDataView })))
const CommerceView = lazy(() => import('./CommerceView').then((module) => ({ default: module.CommerceView })))
const PaymentView = lazy(() => import('./PaymentView').then((module) => ({ default: module.PaymentView })))
const BenefitCenterView = lazy(() => import('./BenefitCenterView').then((module) => ({ default: module.BenefitCenterView })))
const SongCenterView = lazy(() => import('./SongCenterView').then((module) => ({ default: module.SongCenterView })))
const ReservationView = lazy(() => import('./ReservationView').then((module) => ({ default: module.ReservationView })))
const InventoryView = lazy(() => import('./InventoryView').then((module) => ({ default: module.InventoryView })))
const CommercialOpsView = lazy(() => import('./CommercialOpsView').then((module) => ({ default: module.CommercialOpsView })))
const HardwareCenterView = lazy(() => import('./HardwareCenterView').then((module) => ({ default: module.HardwareCenterView })))
const SopRulesEditor = lazy(() => import('./SopRulesEditor').then((module) => ({ default: module.SopRulesEditor })))

export type OperationsConsoleView = 'home' | RoleHomeNavigationId
export interface OperationsConsoleFocus {
  objectId: string
  query?: string | null
  tableCode?: string | null
}
export interface OperationsConsoleNavigationRequest {
  id: number
  target: OperationsConsoleView
  focus?: OperationsConsoleFocus
}
type View = OperationsConsoleView

interface OperationsConsoleProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onOptimisticUpdate: (update: (current: BootstrapResponse) => BootstrapResponse) => void
  navigationRequest?: OperationsConsoleNavigationRequest | null
}

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'home', label: '首页', icon: House },
  { id: 'live', label: '现场', icon: LayoutDashboard },
  { id: 'tasks', label: '任务', icon: ListTodo },
  { id: 'reservations', label: '预约', icon: CalendarDays },
  { id: 'commerce', label: '订单/KDS', icon: CookingPot },
  { id: 'inventory', label: '库存/存酒', icon: PackageSearch },
  { id: 'payments', label: '收银/支付', icon: Banknote },
  { id: 'benefits', label: '会员权益', icon: Gift },
  { id: 'operations', label: '经营工具', icon: ChartNoAxesCombined },
  { id: 'devices', label: '设备中心', icon: Cpu },
  { id: 'songs', label: '演出/点歌', icon: Music2 },
  { id: 'layout', label: '布局', icon: MapIcon },
  { id: 'master', label: '主数据', icon: ContactRound },
  { id: 'config', label: '配置', icon: Settings2 },
]

const viewTitles: Record<View, string> = {
  home: '岗位工作台',
  live: '全店现场',
  tasks: '服务任务',
  reservations: '预约与订金',
  commerce: '订单与出品',
  inventory: '库存与存酒',
  payments: '收银与支付',
  benefits: '会员与权益',
  operations: '经营工具',
  devices: '设备与边缘',
  songs: '演出与点歌',
  layout: '桌台布局',
  master: '门店主数据',
  config: '运营配置',
}

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六']

const assistantCapabilityNames: Record<AssistantCapabilityId, string> = {
  'table.open': '开台',
  'service.task.create': '创建服务任务',
  'service.task.schedule': '定时指派服务',
  'service.task.accept': '接单',
  'service.task.arrive': '确认到桌',
  'service.task.complete': '完成服务',
  'payment.refund.request': '人工申请退款',
  'payment.refund.approve': '人工审批并执行退款',
  'payment.pos.report': '人工报送POS收款',
  'payment.cash.confirm': '人工确认现金实收',
  'business_day.close': '人工营业日关账',
  'config.publish': '人工发布配置',
  'inventory.approve': '人工审批库存差异',
  'benefit.approve': '人工审批超额权益',
  'commerce.authorization.approve': '人工审批折扣赠送',
  'table.close': '人工结台',
  'table.transfer': '人工转桌',
}

const assistantHumanWorkflowIdSet = new Set<AssistantCapabilityId>(assistantHumanWorkflowIds)

function cloneConfig(config: StoreConfig) {
  return structuredClone(config)
}

function tableOperationsConfig(config?: TableOperationsConfig): TableOperationsConfig {
  return structuredClone(config ?? {
    version: 1,
    updatedAt: '1970-01-01T00:00:00.000Z',
    automaticBusinessDayRollover: true,
    businessDayRolloverHour: 6,
    maximumOpenHours: 12,
    reminder: { enabled: true, firstReminderMinutes: 60, repeatMinutes: 30, thresholdPercent: 80 },
    minimumSpendRules: [],
  }) as TableOperationsConfig
}

export function OperationsConsole({ data, onRefresh, onOptimisticUpdate, navigationRequest = null }: OperationsConsoleProps) {
  const fulfillmentAccess = getFulfillmentAccess(data, getCurrentActorId())
  const roleHomeModel = buildRoleHomeModel(data, fulfillmentAccess.employee?.id ?? '')
  const roleHomeAccess = roleHomeModel.access
  const roleNavigationLabels = new Map(roleHomeModel.navigation.map((item) => [item.id, item.label]))
  const currentEmployee = fulfillmentAccess.employee
  const claimableTaskIds = new Set(data.tasks.filter((task) => {
    if (!currentEmployee || currentEmployee.status !== 'active' || !currentEmployee.online || currentEmployee.paused) return false
    if (task.ownerId !== null || !['pending', 'escalated', 'reopened'].includes(task.status)) return false
    if (!data.viewer?.permissionIds.includes('service.execute')) return false
    const serviceType = data.config.serviceTypes.find((item) => item.id === task.serviceTypeId && item.enabled)
    if (!serviceType || !effectiveRoleIdsForEmployee(data, currentEmployee.id).some((roleId) => serviceType.dispatchRoleIds.includes(roleId))) return false
    if (task.notifiedEmployeeIds.includes(currentEmployee.id)) return true
    const table = data.tables.find((item) => item.id === task.tableId)
    if (!table) return false
    const scope = effectiveDataScopeForEmployee(data, currentEmployee.id)
    if (scope === 'all_stores' || scope === 'store') return true
    if (scope === 'assigned_areas') return currentEmployee.areaIds.includes(table.areaId)
    return table.primaryEmployeeId === currentEmployee.id || table.backupEmployeeIds.includes(currentEmployee.id)
  }).map((task) => task.id))
  const ownOpenTasks = data.tasks.filter((task) => (
    (task.ownerId === currentEmployee?.id || claimableTaskIds.has(task.id))
    && !task.archivedAt
    && !['completed', 'confirmed', 'cancelled'].includes(task.status)
  ))
  const availableNavigation = navigation
    .filter((item) => item.id === 'home' || roleHomeAccess.allowedNavigationIds.includes(item.id))
    .map((item) => item.id === 'home' ? item : { ...item, label: roleNavigationLabels.get(item.id) ?? item.label })
  const [view, setView] = useState<View>('home')
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [draft, setDraft] = useState(() => cloneConfig(data.draftConfig ?? data.config))
  const [configDirty, setConfigDirty] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set())
  const [transferTargetId, setTransferTargetId] = useState('')
  const [transferKind, setTransferKind] = useState<'relocate' | 'temporary_to_final'>('relocate')
  const [sessionSummary, setSessionSummary] = useState<TableSessionSummary | null>(null)
  const [walkInPartySize, setWalkInPartySize] = useState(2)
  const [walkInSalesEmployeeId, setWalkInSalesEmployeeId] = useState('')
  const [salesEmployeeId, setSalesEmployeeId] = useState('')
  const [salesChangeReason, setSalesChangeReason] = useState('现场确认销售归属')
  const [combinationAction, setCombinationAction] = useState<'merge' | 'add_table'>('add_table')
  const [combinationTargetId, setCombinationTargetId] = useState('')
  const [minimumSpendWaiverReason, setMinimumSpendWaiverReason] = useState('')
  const [tableOpsDraft, setTableOpsDraft] = useState(() => tableOperationsConfig(data.tableOperationsConfig))
  const [tableOpsDirty, setTableOpsDirty] = useState(false)
  const [tableOpsReason, setTableOpsReason] = useState('')
  const [legacyHandoverReason, setLegacyHandoverReason] = useState('经理已核对客人离店，旧账转交后台处理')
  const [turnoverReviewOpen, setTurnoverReviewOpen] = useState(false)
  const [turnoverReasonCode, setTurnoverReasonCode] = useState<ManagerKdsCancellationInput['reasonCode']>('manager_cancelled')
  const [turnoverReasonNote, setTurnoverReasonNote] = useState('翻台检查发现商品尚未送达')
  const [turnoverAccounting, setTurnoverAccounting] = useState<ManagerKdsCancellationResult | null>(null)
  const [giftProductId, setGiftProductId] = useState('')
  const [giftQuantity, setGiftQuantity] = useState(1)
  const [giftReason, setGiftReason] = useState('未上菜服务补偿')
  const allowedNavigationKey = roleHomeAccess.allowedNavigationIds.join(',')
  const handledNavigationRequestId = useRef<number | null>(null)
  const internalNavigationRequestId = useRef(0)
  const [activeNavigationRequest, setActiveNavigationRequest] = useState<OperationsConsoleNavigationRequest | null>(null)
  const tablePanelRef = useRevealPanelScroll<HTMLDivElement>(view === 'live' ? selectedTableId : '')

  function navigateTo(target: View, focus?: OperationsConsoleFocus) {
    setView(target)
    setMobileNavOpen(false)
    if (target === 'live' || target === 'tasks') {
      const targetTable = focus?.tableCode
        ? data.tables.find((table) => table.code.toLocaleLowerCase('zh-CN') === focus.tableCode?.toLocaleLowerCase('zh-CN'))
        : null
      setSelectedTableId(targetTable?.id ?? null)
    }
    if (focus) {
      internalNavigationRequestId.current -= 1
      setActiveNavigationRequest({ id: internalNavigationRequestId.current, target, focus })
    } else {
      setActiveNavigationRequest(null)
    }
  }

  useEffect(() => {
    if (!navigationRequest || handledNavigationRequestId.current === navigationRequest.id) return
    handledNavigationRequestId.current = navigationRequest.id
    if (navigationRequest.target !== 'home' && !allowedNavigationKey.split(',').includes(navigationRequest.target)) return
    setView(navigationRequest.target)
    setActiveNavigationRequest(navigationRequest)
    if (['live', 'tasks'].includes(navigationRequest.target)) {
      const targetTable = navigationRequest.focus?.tableCode
        ? data.tables.find((table) => table.code.toLocaleLowerCase('zh-CN') === navigationRequest.focus?.tableCode?.toLocaleLowerCase('zh-CN'))
        : null
      setSelectedTableId(targetTable?.id ?? null)
    }
    setMobileNavOpen(false)
  }, [allowedNavigationKey, data.tables, navigationRequest])

  useEffect(() => {
    if (!configDirty) setDraft(cloneConfig(data.draftConfig ?? data.config))
  }, [data.config, data.draftConfig, configDirty])

  useEffect(() => {
    if (!tableOpsDirty) setTableOpsDraft(tableOperationsConfig(data.tableOperationsConfig))
  }, [data.tableOperationsConfig, tableOpsDirty])

  const openTasks = fulfillmentAccess.mode === 'oversight'
    ? data.tasks.filter((task) => !task.archivedAt && !['completed', 'confirmed', 'cancelled'].includes(task.status))
    : ownOpenTasks
  const visibleServiceTasks = fulfillmentAccess.mode === 'oversight'
    ? data.tasks
    : data.tasks.filter((task) => task.ownerId === currentEmployee?.id || claimableTaskIds.has(task.id))
  const roleKdsCount = data.orderDomain.kdsTasks.filter((task) => (
    kdsTaskOperationallyActive(task) && taskVisibleToAccess(task, fulfillmentAccess)
  )).length
  const selectedTable = data.tables.find((table) => table.id === selectedTableId) ?? null
  const selectedAwaitingOrder = data.awaitingOrderIntents.find(
    (intent) => intent.tableId === selectedTableId && intent.status === 'active',
  ) ?? null
  const selectedTableHasOrder = selectedTable
    ? data.orderDomain.orders.some((order) => {
        const session = data.songState.tableSessions.find((item) => item.tableId === selectedTable.id && item.status === 'open')
        return session && order.tableSessionId === session.id && order.status !== 'draft'
      })
    : false
  const effectivePermissions = new Set(data.viewer?.permissionIds ?? [])
  const effectiveRoleIds = fulfillmentAccess.employee
    ? effectiveRoleIdsForEmployee(data, fulfillmentAccess.employee.id)
    : []
  const canTransferTable = effectivePermissions.has('table.manage')
  const canOpenWalkIn = effectivePermissions.has('table.open')
  const canCloseTable = effectivePermissions.has('table.close')
  const canHandoverLegacyTable = effectivePermissions.has('business_day.close')
  const canWaiveMinimumSpend = effectiveRoleIds.some((roleId) => ['manager', 'operations_director', 'owner'].includes(roleId))
  const salesEmployees = salesAttributionEmployees(data.employees)
  const selectedSession = selectedTable
    ? data.songState.tableSessions.find((session) => session.tableId === selectedTable.id && session.status === 'open') ?? null
    : null
  const selectedOpenKds = selectedSession
    ? data.orderDomain.kdsTasks.filter((task) => task.tableSessionId === selectedSession.id && kdsTaskOperationallyActive(task))
    : []
  const canCancelTurnoverItem = canCloseTable && effectiveRoleIds.some((roleId) => (
    ['supervisor', 'manager', 'operations_director', 'owner'].includes(roleId)
  ))
  const giftLimit = Math.max(0, ...effectiveRoleIds.map((roleId) => (
    data.config.roles.find((role) => role.id === roleId)?.approvalLimits?.giftAmount ?? 0
  )))
  const canGiftAtTable = giftLimit > 0
    && effectivePermissions.has('order.create')
    && effectivePermissions.has('commerce.authorization.request')
  const giftProducts = data.products.filter((product) => product.enabled)
  const selectedGiftProduct = giftProducts.find((product) => product.id === giftProductId)
  const giftRequestAmount = (selectedGiftProduct?.listPriceAmount ?? 0) * giftQuantity
  const selectedSessionBusinessDate = selectedSession?.id.match(/:(\d{4}-\d{2}-\d{2})(?::|$)/)?.[1]
  const selectedSessionOpenedAt = selectedSession ? Date.parse(selectedSession.openedAt) : Number.NaN
  const selectedSessionNeedsHandover = Boolean(selectedSession && (
    (selectedSessionBusinessDate && selectedSessionBusinessDate !== data.store.businessDate)
    || !Number.isFinite(selectedSessionOpenedAt)
    || Date.parse(data.serverNow) - selectedSessionOpenedAt > (tableOpsDraft.maximumOpenHours ?? 12) * 60 * 60_000
  ))
  const activeCombinationLinks = (() => {
    const latest = new Map<string, NonNullable<BootstrapResponse['tableCombinationRecords']>[number]>()
    for (const record of data.tableCombinationRecords ?? []) latest.set(record.linkId, record)
    return [...latest.values()].filter((record) => record.action !== 'split_back')
  })()
  const selectedCombinationLinks = selectedTable
    ? activeCombinationLinks.filter((record) => record.primaryTableId === selectedTable.id || record.relatedTableId === selectedTable.id)
    : []
  const groupedTableIds = new Set(activeCombinationLinks.flatMap((record) => [record.primaryTableId, record.relatedTableId]))
  const transferTargets = selectedTable
    ? data.tables.filter((table) => table.status === 'available' && table.capacity >= selectedTable.guestCount)
      .toSorted((left, right) => Number(left.areaId !== selectedTable.areaId) - Number(right.areaId !== selectedTable.areaId) || left.code.localeCompare(right.code))
    : []
  const combinationTargets = selectedTable
    ? data.tables.filter((table) => table.id !== selectedTable.id && !groupedTableIds.has(table.id))
      .filter((table) => combinationAction === 'merge' ? table.status === 'occupied' : table.status === 'available')
      .toSorted((left, right) => Number(left.areaId !== selectedTable.areaId) - Number(right.areaId !== selectedTable.areaId) || left.code.localeCompare(right.code))
    : []

  useEffect(() => {
    setTransferTargetId('')
    setTransferKind('relocate')
    setCombinationTargetId('')
    setCombinationAction('add_table')
    setMinimumSpendWaiverReason('')
    setLegacyHandoverReason('经理已核对客人离店，旧账转交后台处理')
    setTurnoverReviewOpen(false)
    setTurnoverAccounting(null)
    setGiftProductId('')
    setGiftQuantity(1)
    setGiftReason('未上菜服务补偿')
    setSessionSummary(null)
  }, [selectedTableId])

  async function handleLegacyHandover() {
    if (!selectedSession || legacyHandoverReason.trim().length < 5) return
    setBusy(true)
    try {
      const result = await handoverLegacyTableSession(selectedSession.id, legacyHandoverReason.trim())
      const unresolved = result.unresolvedOrderIds.length + result.unresolvedPaymentIntentIds.length
      setNotice(`${result.tableCode}旧桌已释放${unresolved > 0 ? `，${unresolved}项遗留账务已留存待核对` : ''}`)
      setSelectedTableId(null)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '旧桌交接失败')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!selectedTable || selectedTable.status !== 'occupied') return
    let cancelled = false
    void getTableSessionSummary(selectedTable.id)
      .then((summary) => {
        if (cancelled) return
        setSessionSummary(summary)
        setSalesEmployeeId(summary.salesEmployeeId ?? '')
      })
      .catch(() => { if (!cancelled) setSessionSummary(null) })
    return () => { cancelled = true }
  }, [data.revision, selectedTable])

  useEffect(() => {
    if (!walkInSalesEmployeeId && salesEmployees.length > 0) {
      setWalkInSalesEmployeeId(salesEmployees.find((employee) => employee.id === fulfillmentAccess.employee?.id)?.id ?? salesEmployees[0]!.id)
    }
  }, [fulfillmentAccess.employee?.id, salesEmployees, walkInSalesEmployeeId])

  async function handleTaskAction(task: ServiceTask, action: TaskActionInput['action']) {
    const actorId = fulfillmentAccess.employee?.id
    if (!actorId || (task.ownerId !== null && task.ownerId !== actorId)) {
      setNotice('该任务当前不由您负责，请联系领班重新派单')
      return
    }
    const optimisticTask = projectServiceTask(task, action, actorId, new Date().toISOString())
    const replaceTask = (replacement: ServiceTask) => onOptimisticUpdate((current) => ({
      ...current,
      tasks: current.tasks.map((item) => item.id === task.id ? replacement : item),
    }))
    setBusyTaskIds((current) => new Set(current).add(task.id))
    try {
      const result = await runOptimisticAction({
        key: `service-task:${task.id}`,
        apply: () => { replaceTask(optimisticTask); return task },
        commit: () => actOnTask(task.id, { action, actorId, note: action === 'complete' ? '现场服务完成' : '' }),
        reconcile: (authoritativeTask) => { if (authoritativeTask) replaceTask(authoritativeTask) },
        rollback: (snapshot) => replaceTask(snapshot),
      })
      setNotice(result ? '服务状态已同步' : '服务状态已记录，网络恢复后自动同步')
      void onRefresh()
    } catch (error) {
      setNotice(`${error instanceof Error ? error.message : '任务操作失败'}；页面已恢复，可以重试`)
    } finally {
      setBusyTaskIds((current) => {
        const next = new Set(current)
        next.delete(task.id)
        return next
      })
    }
  }

  async function handleAwaitingOrder(action: 'start' | 'stop' | 'snooze', snoozeMinutes = 30) {
    if (!selectedTable) return
    setBusy(true)
    try {
      if (action === 'start') {
        await startAwaitingOrder(selectedTable.id, selectedTable.primaryEmployeeId)
        setNotice(`${selectedTable.code}已标记暂未点单，系统将在合适时间提醒服务`)
      } else if (action === 'stop') {
        await stopAwaitingOrder(selectedTable.id, selectedTable.primaryEmployeeId, '客人暂不需要点单服务')
        setNotice(`${selectedTable.code}待点单提醒已结束`)
      } else {
        const intent = await snoozeAwaitingOrder(selectedTable.id, selectedTable.primaryEmployeeId, snoozeMinutes)
        setNotice(`${selectedTable.code}已尊重客人选择，${snoozeMinutes}分钟内不再打扰；北京时间${formatChinaTime(intent.nextReminderAt!)}再关注一次`)
      }
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '待点单状态操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleTableTransfer() {
    if (!selectedTable || !transferTargetId) return
    const target = data.tables.find((table) => table.id === transferTargetId)
    if (!target) return
    setBusy(true)
    try {
      await transferTableSession(selectedTable.id, {
        targetTableId: target.id,
        kind: transferKind,
        reason: transferKind === 'temporary_to_final' ? '临时候客位转正式桌' : '顾客现场申请换位',
      })
      setNotice(`${selectedTable.code}已整体转至${target.code}，订单、账务、出品和服务任务保持同一桌次`)
      setSelectedTableId(target.id)
      setTransferTargetId('')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '转桌失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleWalkInOpen() {
    if (!selectedTable || selectedTable.status !== 'available' || !walkInSalesEmployeeId) return
    setBusy(true)
    try {
      const result = await openWalkInTable(selectedTable.id, {
        partySize: walkInPartySize,
        salesEmployeeId: walkInSalesEmployeeId,
        customerName: '现场客人',
      })
      setSessionSummary(result.summary)
      setSalesEmployeeId(result.summary.salesEmployeeId ?? '')
      setNotice(`${selectedTable.code}临客已开台，低消V${result.summary.configVersion}与销售归属已固化`)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '临客开台失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSalesChange() {
    if (!selectedSession || !salesEmployeeId || !salesChangeReason.trim()) return
    setBusy(true)
    try {
      await assignTableSessionSales(selectedSession.id, {
        salesEmployeeId,
        reason: salesChangeReason.trim(),
      })
      setNotice('桌次销售归属已更新并写入审计')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '销售归属更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCombination() {
    if (!selectedTable || !combinationTargetId) return
    const target = data.tables.find((table) => table.id === combinationTargetId)
    if (!target) return
    setBusy(true)
    try {
      await operateTableCombination(selectedTable.id, {
        action: combinationAction,
        targetTableId: target.id,
        reason: combinationAction === 'merge' ? '现场确认两桌合并接待' : '现场确认主桌增加物理桌位',
      })
      setNotice(combinationAction === 'merge'
        ? `${selectedTable.code}与${target.code}已建立合台关系，各自订单、支付和KDS保持独立`
        : `${target.code}已作为${selectedTable.code}加桌，订单、支付和KDS未迁移`)
      setCombinationTargetId('')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '桌组操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSplitBack(linkId: string) {
    if (!selectedTable) return
    setBusy(true)
    try {
      await operateTableCombination(selectedTable.id, {
        action: 'split_back',
        linkId,
        reason: '现场确认结束合台/加桌关系',
      })
      setNotice('桌组关系已拆回并写入审计')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '拆回失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleMinimumSpendWaiver() {
    if (!selectedTable || !minimumSpendWaiverReason.trim()) return
    setBusy(true)
    try {
      await closeTableSession(selectedTable.id, '经理核对后豁免低消差额并结台', minimumSpendWaiverReason.trim())
      setNotice(`${selectedTable.code}低消差额已由经理豁免并完成结台`)
      setSelectedTableId(null)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '低消豁免结台失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCloseTable() {
    if (!selectedTable || !canCloseTable) return
    if (selectedOpenKds.length > 0) {
      setTurnoverReviewOpen(true)
      setTurnoverAccounting(null)
      setNotice(`结台前发现${selectedOpenKds.length}项商品尚未送达，请先核对出品；系统不会自动改账`)
      return
    }
    if (!window.confirm(`确认${selectedTable.code}客人已经离店并结台翻台？`)) return
    setBusy(true)
    try {
      await closeTableSession(selectedTable.id, '服务员工确认客人离店并完成结台翻台')
      setNotice(`操作成功：${selectedTable.code}已结台并释放，可接待下一桌客人`)
      setSelectedTableId(null)
      setSessionSummary(null)
      await onRefresh()
    } catch (error) {
      const reason = error instanceof Error ? error.message : '请稍后重试'
      setNotice(`结台未完成：${reason}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleManagerCancelKds(taskId: string) {
    if (!canCancelTurnoverItem || turnoverReasonNote.trim().length < 2) return
    setBusy(true)
    try {
      const sourceTask = data.orderDomain.kdsTasks.find((task) => task.id === taskId)
      const sourceItem = sourceTask
        ? data.orderDomain.orders.find((order) => order.id === sourceTask.orderId)?.items.find((item) => item.id === sourceTask.orderItemId)
        : undefined
      const result = await managerCancelKdsTask(taskId, {
        reasonCode: turnoverReasonCode,
        reasonNote: turnoverReasonNote.trim(),
        idempotencyKey: `turnover-kds-cancel-${crypto.randomUUID()}`,
      })
      setTurnoverAccounting(result)
      setGiftProductId(sourceItem?.skuId ?? data.products.find((product) => product.enabled)?.id ?? '')
      setNotice(`${result.itemName}已停止制作；订单、收款和退款均未自动变更`)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '取消出品失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleGiftReplacement() {
    if (!selectedTable || !turnoverAccounting || !giftProductId || !canGiftAtTable) return
    setBusy(true)
    try {
      const order = await createComplimentaryOrder({
        tableId: selectedTable.id,
        items: [{ productId: giftProductId, quantity: giftQuantity }],
        reason: giftReason.trim(),
        sourceKdsTaskId: turnoverAccounting.taskId,
        idempotencyKey: `turnover-gift-${crypto.randomUUID()}`,
      })
      const product = data.products.find((candidate) => candidate.id === giftProductId)
      setNotice(`${product?.name ?? '赠品'}已按权限赠送并进入出品，赠送金额${money(order.amounts.giftAmount)}已留痕`)
      setTurnoverAccounting(null)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '赠送失败')
    } finally {
      setBusy(false)
    }
  }

  function addMinimumSpendRule() {
    const target = data.areas[0]
    if (!target) return
    const rule: MinimumSpendRule = {
      id: `minimum-${crypto.randomUUID()}`,
      name: `${target.shortName}常规低消`,
      enabled: true,
      targetType: 'area',
      targetId: target.id,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startTime: '20:00',
      endTime: '02:00',
      amount: 0,
      currency: 'CNY',
    }
    setTableOpsDraft({ ...tableOpsDraft, minimumSpendRules: [...tableOpsDraft.minimumSpendRules, rule] })
    setTableOpsDirty(true)
  }

  function updateMinimumSpendRule(index: number, patch: Partial<MinimumSpendRule>) {
    setTableOpsDraft({
      ...tableOpsDraft,
      minimumSpendRules: tableOpsDraft.minimumSpendRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule),
    })
    setTableOpsDirty(true)
  }

  async function saveTableOperationsConfig() {
    if (!tableOpsReason.trim()) {
      setNotice('请填写低消规则配置变更原因')
      return
    }
    setBusy(true)
    try {
      const saved = await updateTableOperationsConfig({
        automaticBusinessDayRollover: tableOpsDraft.automaticBusinessDayRollover ?? true,
        businessDayRolloverHour: tableOpsDraft.businessDayRolloverHour ?? 6,
        maximumOpenHours: tableOpsDraft.maximumOpenHours ?? 12,
        reminder: tableOpsDraft.reminder,
        minimumSpendRules: tableOpsDraft.minimumSpendRules,
        reason: tableOpsReason.trim(),
      })
      setTableOpsDraft(saved)
      setTableOpsDirty(false)
      setTableOpsReason('')
      setNotice(`保存成功：桌台经营配置V${saved.version}已生效；已开桌次继续使用原快照`)
      await onRefresh()
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : '桌台经营配置未保存'}`)
    } finally {
      setBusy(false)
    }
  }

  function configPayload(): ConfigDraftInput {
    return {
      serviceTypes: draft.serviceTypes.map((type) => ({
        id: type.id,
        enabled: type.enabled,
        priority: type.priority,
        dispatchRoleIds: type.dispatchRoleIds,
        customerReply: type.customerReply,
        actionScript: type.actionScript,
        sla: type.sla,
      })),
      roles: draft.roles.map((role) => ({
        id: role.id,
        name: role.name,
        maxConcurrentTasks: role.maxConcurrentTasks,
        canReceiveTasks: role.canReceiveTasks,
        permissionIds: role.permissionIds,
        dataScope: role.dataScope,
        approvalLimits: role.approvalLimits,
      })),
      proactiveOrderCare: { ...draft.proactiveOrderCare },
      guestServiceLimits: { ...draft.guestServiceLimits },
      communityBrand: structuredClone(draft.communityBrand),
      assistantCapabilities: structuredClone(draft.assistantCapabilities ?? []),
      sopRules: structuredClone(draft.sopRules ?? []),
    }
  }

  async function saveDraft() {
    setBusy(true)
    try {
      await saveConfigDraft(configPayload())
      setConfigDirty(false)
      setNotice('保存成功：配置草稿已保存，可以继续检查或发布')
      await onRefresh()
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : '配置草稿未保存'}`)
    } finally {
      setBusy(false)
    }
  }

  async function publishDraft() {
    setBusy(true)
    try {
      if (configDirty) await saveConfigDraft(configPayload())
      const published = await publishConfig()
      setConfigDirty(false)
      setNotice(`发布成功：配置V${published.version}已生效`)
      await onRefresh()
    } catch (error) {
      setNotice(`发布失败：${error instanceof Error ? error.message : '配置未生效'}`)
    } finally {
      setBusy(false)
    }
  }

  async function rollbackVersion(version: number) {
    setBusy(true)
    try {
      const published = await rollbackConfig(version, `回滚到V${version}的营业配置`)
      setConfigDirty(false)
      setDraft(cloneConfig(published))
      setNotice(`发布成功：已按V${version}快照生成并生效为V${published.version}`)
      await onRefresh()
    } catch (error) {
      setNotice(`发布失败：${error instanceof Error ? error.message : '回滚配置未生效'}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    setBusy(true)
    try {
      await resetDemo()
      setSelectedTableId(null)
      setConfigDirty(false)
      setNotice('开发数据已重置')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '开发数据重置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className={mobileNavOpen ? 'sidebar is-open' : 'sidebar'}>
        <div className="brand-lockup"><span>M</span><div><strong>M-BOX</strong><small>现场运营</small>{data.config.communityBrand.enabled && <em>{data.config.communityBrand.name}旗下空间</em>}</div></div>
        <button className="sidebar-close" title="关闭导航" onClick={() => setMobileNavOpen(false)}><X size={20} /></button>
        <nav>
          {availableNavigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={view === item.id ? 'nav-item is-active' : 'nav-item'}
                onClick={() => navigateTo(item.id)}
              >
                <Icon size={19} /><span>{item.label}</span>
                {item.id === 'tasks' && openTasks.length > 0 && <b>{openTasks.length}</b>}
                {item.id === 'commerce' && roleKdsCount > 0 && <b>{roleKdsCount}</b>}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-status">
          <span><Wifi size={16} />系统在线</span>
          {data.config.communityBrand.enabled && <span className="sidebar-culture-mark" title={data.config.communityBrand.tagline}><Heart size={12} />SUPERHIGH CULTURE</span>}
          <small>配置 V{data.config.version}</small>
        </div>
      </aside>

      {mobileNavOpen && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}

      <div className="workspace">
        <header className="topbar">
          <button className="menu-button" title="打开导航" onClick={() => setMobileNavOpen(true)}><Menu size={21} /></button>
          <div>
            <span className="eyebrow">营业日 {data.store.businessDate} · 营业中 · {fulfillmentAccess.roleLabel}</span>
            <h1>{viewTitles[view]}</h1>
          </div>
          <BeijingClock serverNow={data.serverNow} />
          <div className="workstation-badge"><span>{fulfillmentAccess.employee?.displayName ?? '身份失效'}</span><strong>{roleHomeAccess.focusLabel}</strong></div>
          <div className="topbar-actions">
            {roleHomeAccess.allowedNavigationIds.includes('config') && (
              <button className="secondary-button reset-button" disabled={busy} onClick={() => void handleReset()}>
                <RefreshCw size={17} />重置数据
              </button>
            )}
            {import.meta.env.DEV && (
              <a className="primary-button" href="/guest?table=L01" target="_blank" rel="noreferrer">
                <ExternalLink size={17} />顾客端
              </a>
            )}
          </div>
        </header>

        {notice && <div className={`notice-bar ${/失败|错误|无效|不能|不可|拒绝|未保存|未完成|尚未|请先/.test(notice) ? 'is-error' : 'is-success'}`} role="status" aria-live="polite">{notice}<button title="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}

        {turnoverReviewOpen && selectedTable && (
          <div className="turnover-review-backdrop" role="presentation">
            <section className="turnover-review-dialog" role="dialog" aria-modal="true" aria-label={`${selectedTable.code}结台前出品核对`}>
              <header>
                <div><span>结台前核对</span><strong>{selectedTable.code} · 未送达商品处理</strong></div>
                <button className="icon-button" title="关闭核对窗口" onClick={() => setTurnoverReviewOpen(false)}><X size={20} /></button>
              </header>
              <div className="turnover-accounting-boundary"><ShieldCheck size={18} /><span><strong>系统只停止制作，不自动退款、改单或冲销。</strong>账务处理由有权限人员另行确认。</span></div>
              {selectedOpenKds.length > 0 ? (
                <div className="turnover-kds-list">
                  {selectedOpenKds.map((task) => (
                    <div className="turnover-kds-row" key={task.id}>
                      <div><strong>{task.itemName} × {task.quantity}</strong><span>{task.specification} · {turnoverKdsStatus(task.status)}</span></div>
                      {canCancelTurnoverItem
                        ? <button className="danger-button" disabled={busy || turnoverReasonNote.trim().length < 2} onClick={() => void handleManagerCancelKds(task.id)}>取消制作</button>
                        : <span className="turnover-permission-note">请店长或授权主管处理</span>}
                    </div>
                  ))}
                </div>
              ) : <div className="turnover-clear-state"><CircleCheckBig size={22} /><span>未送达出品阻断已处理，可以重新检查结台条件。</span></div>}
              {selectedOpenKds.length > 0 && canCancelTurnoverItem && (
                <div className="turnover-reason-fields">
                  <label><span>取消原因</span><select value={turnoverReasonCode} onChange={(event) => setTurnoverReasonCode(event.target.value as ManagerKdsCancellationInput['reasonCode'])}><option value="manager_cancelled">店长现场取消</option><option value="guest_cancelled">客人取消</option><option value="unavailable_confirmed">确认无法制作</option><option value="other">其他</option></select></label>
                  <label><span>情况说明</span><input maxLength={200} value={turnoverReasonNote} onChange={(event) => setTurnoverReasonNote(event.target.value)} /></label>
                </div>
              )}
              {turnoverAccounting && (
                <div className="turnover-accounting-review">
                  <div className="turnover-accounting-title"><Banknote size={18} /><div><strong>账务建议 · 仅供确认</strong><span>{accountingRecommendation(turnoverAccounting)}</span></div></div>
                  <dl><div><dt>商品应付</dt><dd>{money(turnoverAccounting.accounting.payableAmount)}</dd></div><div><dt>已收金额</dt><dd>{money(turnoverAccounting.accounting.paidAmount)}</dd></div><div><dt>已退金额</dt><dd>{money(turnoverAccounting.accounting.refundedAmount)}</dd></div></dl>
                  {canGiftAtTable && (
                    <div className="turnover-gift-form">
                      <div className="turnover-accounting-title"><Gift size={18} /><div><strong>赠送同品或替代品</strong><span>独立零应付订单，正常扣库存并进入出品</span></div></div>
                      <label><span>赠送商品</span><select value={giftProductId} onChange={(event) => setGiftProductId(event.target.value)}>{giftProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {money(product.listPriceAmount)}</option>)}</select></label>
                      <label><span>数量</span><input type="number" min={1} max={50} value={giftQuantity} onChange={(event) => setGiftQuantity(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /></label>
                      <label><span>赠送原因</span><input maxLength={200} value={giftReason} onChange={(event) => setGiftReason(event.target.value)} /></label>
                      <button className="secondary-button" disabled={busy || !selectedGiftProduct || giftReason.trim().length < 2 || giftRequestAmount > giftLimit} onClick={() => void handleGiftReplacement()}><Gift size={16} />确认赠送</button>
                      <small>本次 {money(giftRequestAmount)} / 当前岗位单次额度 {money(giftLimit)}</small>
                    </div>
                  )}
                </div>
              )}
              <footer>
                <button className="secondary-button" onClick={() => { setTurnoverReviewOpen(false); setNotice('账务保持原状，取消记录已留存，可稍后由店长或收银处理') }}>否，暂不处理</button>
                {roleHomeAccess.allowedNavigationIds.includes('payments') && <button className="secondary-button" onClick={() => { setTurnoverReviewOpen(false); navigateTo('payments'); setNotice('已进入收银工作台，请根据现场情况决定是否退款或调整应收') }}><Banknote size={16} />是，去收银处理</button>}
                {selectedOpenKds.length === 0 && <button className="primary-button" disabled={busy} onClick={() => { setTurnoverReviewOpen(false); void handleCloseTable() }}><CircleCheckBig size={16} />重新检查并结台</button>}
              </footer>
            </section>
          </div>
        )}

        <main className="main-content" aria-busy={busy}>
          <Suspense fallback={<div className="empty-state" role="status">正在载入当前工作台</div>}>
          {view === 'home' && (
            <RoleHomeView
              data={data}
              employeeId={fulfillmentAccess.employee?.id ?? ''}
              onNavigate={(nextView, focusQuery) => navigateTo(nextView, focusQuery ? { objectId: focusQuery, query: focusQuery } : undefined)}
            />
          )}
          {view === 'live' && (
            <>
              <section className="metrics-grid">
                <Metric icon={CircleDot} label="营业桌台" value={data.metrics.occupiedTables} tone="neutral" />
                <Metric icon={BellRing} label="待处理任务" value={data.metrics.openTasks} tone="blue" onClick={() => navigateTo('tasks', { objectId: 'service-open', query: 'service-open' })} />
                <Metric icon={CircleAlert} label="SLA风险" value={data.metrics.atRiskTasks} tone="yellow" onClick={() => navigateTo('tasks', { objectId: 'service-sla-risk', query: 'service-sla-risk' })} />
                <Metric icon={ShieldCheck} label="投诉接管" value={data.metrics.complaints} tone="red" onClick={() => navigateTo('tasks', { objectId: 'service-complaints', query: 'service-complaints' })} />
              </section>

              <div className="live-grid">
                <section className="floor-operations">
                  <div className="section-heading">
                    <div><span className="eyebrow">桌台责任区</span><h2>现场桌台</h2></div>
                    <div className="legend"><span><i className="dot occupied" />营业</span><span><i className="dot reserved" />预订</span><span><i className="dot available" />空台</span></div>
                  </div>
                  {selectedTable && <div className="reveal-panel-target" ref={tablePanelRef} aria-hidden="true" />}
                  {selectedTable && selectedTable.status === 'available' && canOpenWalkIn && (
                    <div className="table-walkin-toolbar">
                      <div className="table-business-heading"><DoorOpen size={19} /><div><strong>{selectedTable.code} 临客开台</strong><span>员工选择人数与销售后直接开台，客户无需确认</span></div></div>
                      <label><span>人数</span><div className="party-stepper"><button title="减少人数" disabled={walkInPartySize <= 1} onClick={() => setWalkInPartySize((value) => Math.max(1, value - 1))}><Minus size={15} /></button><input aria-label="客人人数" type="number" inputMode="numeric" min={1} max={selectedTable.capacity} value={walkInPartySize} onChange={(event) => setWalkInPartySize(Math.min(selectedTable.capacity, Math.max(1, Number(event.target.value) || 1)))} /><button title="增加人数" disabled={walkInPartySize >= selectedTable.capacity} onClick={() => setWalkInPartySize((value) => Math.min(selectedTable.capacity, value + 1))}><Plus size={15} /></button></div></label>
                      <label><span>销售归属</span><select value={walkInSalesEmployeeId} onChange={(event) => setWalkInSalesEmployeeId(event.target.value)}><option value="">请选择销售</option>{salesEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
                      <button className="primary-button" disabled={busy || !walkInSalesEmployeeId} onClick={() => void handleWalkInOpen()}><DoorOpen size={17} />立即开台</button>
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && (
                    <div className="table-service-toolbar">
                      <div className="table-service-context">
                        <span>{selectedTable.code}</span>
                        <strong>{selectedTable.displayName}</strong>
                        {selectedAwaitingOrder
                          ? <small>等待点单 {elapsedMinutes(selectedAwaitingOrder.startedAt)}分钟 · 已提醒{selectedAwaitingOrder.reminderCount}次</small>
                          : <small>{selectedTableHasOrder ? '当前桌次已产生订单' : '服务员可标记客人暂未点单'}</small>}
                      </div>
                      {selectedSessionNeedsHandover ? <strong className="stale-table-label">已冻结，等待经理交接</strong> : selectedAwaitingOrder ? (
                        <>
                          <div className="next-care"><Timer size={17} /><span>下次检查</span><strong>{formatNextReminder(selectedAwaitingOrder.nextReminderAt)}</strong></div>
                          <div className="awaiting-order-snooze" aria-label="延后点单提醒"><button disabled={busy} onClick={() => void handleAwaitingOrder('snooze', 15)}>15分钟</button><button disabled={busy} onClick={() => void handleAwaitingOrder('snooze', 30)}>30分钟</button><button disabled={busy} onClick={() => void handleAwaitingOrder('snooze', 60)}>60分钟</button></div>
                          <button className="secondary-button" disabled={busy} onClick={() => void handleAwaitingOrder('stop')}>结束提醒</button>
                        </>
                      ) : (
                        <button className="primary-button" disabled={busy || selectedTableHasOrder} onClick={() => void handleAwaitingOrder('start')}><UtensilsCrossed size={17} />暂未点单</button>
                      )}
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && selectedSessionNeedsHandover && (
                    <div className="legacy-handover-toolbar">
                      <div className="table-business-heading"><History size={19} /><div><strong>旧桌安全交接</strong><span>客人端旧订单和支付已隐藏，交接不会删除历史记录</span></div></div>
                      <input aria-label="旧桌交接原因" maxLength={300} value={legacyHandoverReason} onChange={(event) => setLegacyHandoverReason(event.target.value)} />
                      {canHandoverLegacyTable
                        ? <button className="primary-button" disabled={busy || legacyHandoverReason.trim().length < 5} onClick={() => void handleLegacyHandover()}><ShieldCheck size={16} />核对并释放桌台</button>
                        : <span className="handover-permission-note">请通知店长或老板处理</span>}
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && !selectedSessionNeedsHandover && sessionSummary && (
                    <div className={`table-business-toolbar ${sessionSummary.reminderRequired ? 'is-warning' : ''}`}>
                      <div className="minimum-spend-status">
                        <CircleDollarSign size={20} />
                        <span><small>{sessionSummary.ruleName} · 快照V{sessionSummary.configVersion}</small><strong>{money(sessionSummary.spendAmount)} / {money(sessionSummary.minimumSpendAmount)}</strong></span>
                        <b>{sessionSummary.differenceAmount > 0 ? `差 ${money(sessionSummary.differenceAmount)}` : '低消已达成'}</b>
                      </div>
                      <div className="minimum-spend-progress"><span style={{ width: `${sessionSummary.progressPercent}%` }} /></div>
                      <div className="sales-attribution-control">
                        <label><span>桌次销售</span><select disabled={!canTransferTable} value={salesEmployeeId} onChange={(event) => setSalesEmployeeId(event.target.value)}><option value="">未指定</option>{salesEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
                        {canTransferTable && <><input aria-label="销售归属变更原因" maxLength={300} value={salesChangeReason} onChange={(event) => setSalesChangeReason(event.target.value)} /><button className="secondary-button" disabled={busy || !salesEmployeeId || salesEmployeeId === sessionSummary.salesEmployeeId} onClick={() => void handleSalesChange()}><UserPlus size={15} />变更</button></>}
                      </div>
                      {sessionSummary.reminderRequired && <div className="minimum-spend-reminder"><BellRing size={16} /><span>低消进度低于提醒阈值</span><small>{sessionSummary.nextReminderAt ? `北京时间 ${formatChinaTime(sessionSummary.nextReminderAt)} 再次检查` : ''}</small></div>}
                      {canWaiveMinimumSpend && sessionSummary.differenceAmount > 0 && <div className="minimum-spend-waiver"><input maxLength={300} placeholder="经理豁免原因（至少5字）" value={minimumSpendWaiverReason} onChange={(event) => setMinimumSpendWaiverReason(event.target.value)} /><button className="secondary-button" disabled={busy || minimumSpendWaiverReason.trim().length < 5} onClick={() => void handleMinimumSpendWaiver()}><ShieldCheck size={15} />豁免并结台</button></div>}
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && !selectedSessionNeedsHandover && sessionSummary && canCloseTable && sessionSummary.differenceAmount === 0 && (
                    <div className="table-close-toolbar">
                      <div className="table-business-heading"><CircleCheckBig size={19} /><div><strong>客人离店 · 结台翻台</strong><span>系统会先检查未支付、未出品、退款、点歌和桌组关系</span></div></div>
                      <button className="primary-button" disabled={busy || selectedCombinationLinks.length > 0} onClick={() => void handleCloseTable()}><CircleCheckBig size={16} />确认结台</button>
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && !selectedSessionNeedsHandover && canTransferTable && selectedCombinationLinks.length === 0 && (
                    <div className="table-transfer-toolbar">
                      <div className="table-transfer-heading"><ArrowRightLeft size={18} /><div><strong>整桌换位</strong><span>选择目标桌，确认后立即迁移全部现场责任</span></div></div>
                      <div className="transfer-kind-control" aria-label="转桌类型">
                        <button className={transferKind === 'relocate' ? 'is-active' : ''} onClick={() => setTransferKind('relocate')}>普通换位</button>
                        <button className={transferKind === 'temporary_to_final' ? 'is-active' : ''} onClick={() => setTransferKind('temporary_to_final')}>临时转正式</button>
                      </div>
                      <div className="transfer-targets">
                        {transferTargets.length === 0 && <span>当前没有容量合适的空桌</span>}
                        {transferTargets.map((table) => (
                          <button key={table.id} className={transferTargetId === table.id ? 'is-selected' : ''} onClick={() => setTransferTargetId(table.id)}>
                            <strong>{table.code}</strong><small>{table.capacity}人 · {data.areas.find((area) => area.id === table.areaId)?.shortName}</small>
                          </button>
                        ))}
                      </div>
                      <button className="primary-button transfer-confirm" disabled={busy || !transferTargetId} onClick={() => void handleTableTransfer()}><ArrowRightLeft size={17} />确认转桌</button>
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && !selectedSessionNeedsHandover && canTransferTable && (
                    <div className="table-combination-toolbar">
                      <div className="table-business-heading"><Link2 size={18} /><div><strong>专用合台 / 加桌</strong><span>仅建立现场桌组关系，不迁移订单、支付或KDS</span></div></div>
                      {!selectedCombinationLinks.some((record) => record.relatedTableId === selectedTable.id) && <>
                        <div className="transfer-kind-control" aria-label="桌组操作类型"><button className={combinationAction === 'add_table' ? 'is-active' : ''} onClick={() => { setCombinationAction('add_table'); setCombinationTargetId('') }}>加空桌</button><button className={combinationAction === 'merge' ? 'is-active' : ''} onClick={() => { setCombinationAction('merge'); setCombinationTargetId('') }}>合营业桌</button></div>
                        <div className="transfer-targets">
                          {combinationTargets.length === 0 && <span>{combinationAction === 'merge' ? '没有可合并的营业桌' : '没有可增加的空桌'}</span>}
                          {combinationTargets.map((table) => <button key={table.id} className={combinationTargetId === table.id ? 'is-selected' : ''} onClick={() => setCombinationTargetId(table.id)}><strong>{table.code}</strong><small>{table.capacity}人 · {data.areas.find((area) => area.id === table.areaId)?.shortName}</small></button>)}
                        </div>
                        <button className="primary-button" disabled={busy || !combinationTargetId} onClick={() => void handleCombination()}><Link2 size={16} />确认{combinationAction === 'merge' ? '合台' : '加桌'}</button>
                      </>}
                      {selectedCombinationLinks.length > 0 && <div className="active-table-links">{selectedCombinationLinks.map((record) => <div key={record.linkId}><span><strong>{record.primaryTableCode}</strong><Link2 size={13} /><strong>{record.relatedTableCode}</strong><small>{record.kind === 'merge' ? '合台' : '加桌'}</small></span><button className="secondary-button" disabled={busy} onClick={() => void handleSplitBack(record.linkId)}><Unlink size={14} />拆回</button></div>)}</div>}
                    </div>
                  )}
                  <div className="area-list">
                    {data.areas.toSorted((a, b) => a.sortOrder - b.sortOrder).map((area) => (
                      <div className="area-row" key={area.id}>
                        <div className="area-label" style={{ borderColor: area.color }}><strong>{area.shortName}</strong><span>{area.name}</span></div>
                        <div className="table-grid">
                          {data.tables.filter((table) => table.areaId === area.id).map((table) => {
                            const owner = data.employees.find((employee) => employee.id === table.primaryEmployeeId)
                            const taskCount = openTasks.filter((task) => task.tableId === table.id).length
                            const awaitingOrder = data.awaitingOrderIntents.find(
                              (intent) => intent.tableId === table.id && intent.status === 'active',
                            )
                            return (
                              <button
                                key={table.id}
                                aria-label={table.status === 'available' ? `开台桌台 ${table.code}` : undefined}
                                className={`table-tile status-${table.status} ${awaitingOrder ? 'is-awaiting-order' : ''} ${selectedTableId === table.id ? 'is-selected' : ''}`}
                                onClick={() => setSelectedTableId(selectedTableId === table.id ? null : table.id)}
                              >
                                <span className="table-code">{table.code}</span>
                                <strong>{table.displayName}</strong>
                                <small>{awaitingOrder
                                  ? `营业中 · 待点单 ${elapsedMinutes(awaitingOrder.startedAt)}分钟 · ${owner?.displayName}`
                                  : table.status === 'occupied' ? `营业中 · ${table.guestCount}位 · ${owner?.displayName}` : table.status === 'reserved' ? '已预留 · 待到店' : '未开台 · 点击开台'}</small>
                                {taskCount > 0 && <b className="table-task-count">{taskCount}</b>}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <TaskQueue
                  compact
                  tasks={visibleServiceTasks}
                  tables={data.tables}
                  employees={data.employees}
                  serviceTypes={data.config.serviceTypes}
                  selectedTableId={selectedTableId}
                  onClearTable={() => setSelectedTableId(null)}
                  onAction={handleTaskAction}
                  busyTaskIds={busyTaskIds}
                  currentEmployeeId={fulfillmentAccess.employee?.id ?? ''}
                  claimableTaskIds={claimableTaskIds}
                  focusTaskId={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.focus?.objectId : null}
                  focusQuery={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.focus?.query : null}
                  focusRequestId={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.id : null}
                  onClearFocus={() => setActiveNavigationRequest(null)}
                />
              </div>
            </>
          )}

          {view === 'tasks' && (
            <>
              <SopVerificationInbox data={data} employee={currentEmployee ?? null} onRefresh={onRefresh} onNotice={setNotice} />
              <TaskQueue
                tasks={visibleServiceTasks}
                tables={data.tables}
                employees={data.employees}
                serviceTypes={data.config.serviceTypes}
                selectedTableId={selectedTableId}
                onClearTable={() => setSelectedTableId(null)}
                onAction={handleTaskAction}
                busyTaskIds={busyTaskIds}
                currentEmployeeId={fulfillmentAccess.employee?.id ?? ''}
                claimableTaskIds={claimableTaskIds}
                focusTaskId={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.focus?.objectId : null}
                focusQuery={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.focus?.query : null}
                focusRequestId={activeNavigationRequest?.target === 'tasks' ? activeNavigationRequest.id : null}
                onClearFocus={() => setActiveNavigationRequest(null)}
              />
            </>
          )}

          {view === 'commerce' && (
            <CommerceView data={data} onRefresh={onRefresh} onOptimisticUpdate={onOptimisticUpdate} onNotice={setNotice} focusRequest={activeNavigationRequest?.target === 'commerce' ? activeNavigationRequest : null} />
          )}

          {view === 'reservations' && <ReservationView data={data} focusRequest={activeNavigationRequest?.target === 'reservations' ? activeNavigationRequest : null} />}

          {view === 'inventory' && <InventoryView />}

          {view === 'payments' && <PaymentView data={data} onRefresh={onRefresh} />}

          {view === 'benefits' && <BenefitCenterView data={data} onRefresh={onRefresh} onNotice={setNotice} />}

          {view === 'operations' && <CommercialOpsView data={data} onRefresh={onRefresh} />}

          {view === 'devices' && <HardwareCenterView data={data} onRefresh={onRefresh} />}

          {view === 'songs' && <SongCenterView data={data} onRefresh={onRefresh} onNotice={setNotice} />}

          {view === 'layout' && (
            <section className="layout-view">
              <div className="section-heading">
                <div><span className="eyebrow">输入资料 · 2026-07-13</span><h2>门店分区参考</h2></div>
                <span className="count-chip">{data.tables.length}桌已配置</span>
              </div>
              <div className="layout-content">
                <figure><img src="/assets/mbox-floorplan.png" alt="M-Box陆家嘴店座位功能分区图" /></figure>
                <div className="layout-area-list">
                  {data.areas.map((area) => (
                    <div className="layout-area" key={area.id}>
                      <i style={{ background: area.color }} />
                      <div><strong>{area.name}</strong><span>{data.tables.filter((table) => table.areaId === area.id).length}桌</span></div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {view === 'master' && (
            <MasterDataView data={data} onRefresh={onRefresh} onNotice={setNotice} />
          )}

          {view === 'config' && (
            <section className="config-view">
              <div className="section-heading">
                <div><span className="eyebrow">已发布 V{data.config.version}</span><h2>服务与调度</h2></div>
                <div className="config-actions">
                  <button className="secondary-button" disabled={busy || !configDirty} onClick={() => void saveDraft()}><Save size={17} />保存草稿</button>
                  <button className="primary-button" disabled={busy || (!configDirty && !data.draftConfig)} onClick={() => void publishDraft()}><Upload size={17} />发布配置</button>
                </div>
              </div>

              <div className="config-section config-history-section">
                <div className="config-section-title"><History size={19} /><div><strong>版本历史与回滚</strong><span>回滚会生成新版本，不覆盖旧记录</span></div></div>
                <div className="config-version-list">
                  {data.configVersions.toSorted((left, right) => right.version - left.version).slice(0, 8).map((record) => (
                    <div className={record.version === data.config.version ? 'config-version-row is-current' : 'config-version-row'} key={record.id}>
                      <span><strong>V{record.version}</strong><small>{configOperationLabel(record.operation)} · {record.reason}</small></span>
                      <time>{formatChinaDateTime(record.createdAt)}</time>
                      {record.version === data.config.version
                        ? <b>当前版本</b>
                        : <button className="secondary-button" disabled={busy || Boolean(data.draftConfig)} onClick={() => void rollbackVersion(record.version)}><RefreshCw size={14} />回滚</button>}
                    </div>
                  ))}
                </div>
                {data.draftConfig && <p className="config-history-warning">存在未发布草稿，发布后才能回滚。</p>}
              </div>

              <div className="config-section assistant-capability-center">
                <div className="config-section-title"><Cpu size={19} /><div><strong>AI可执行能力中心</strong><span>自然语言别名可配置；人工风控能力不能改成AI自动执行</span></div></div>
                <div className="config-table-wrap">
                  <table className="config-table">
                    <thead><tr><th>能力</th><th>启用</th><th>执行方式</th><th>自然语言别名</th></tr></thead>
                    <tbody>
                      {(draft.assistantCapabilities ?? []).map((capability, index) => {
                        const isHumanWorkflow = assistantHumanWorkflowIdSet.has(capability.id)
                        return (
                          <tr key={capability.id}>
                            <td><strong>{assistantCapabilityNames[capability.id]}</strong><small>{capability.id}</small></td>
                            <td><label className="switch"><input type="checkbox" checked={capability.enabled} onChange={(event) => { const next = cloneConfig(draft); next.assistantCapabilities![index]!.enabled = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></td>
                            <td><b className={isHumanWorkflow ? 'assistant-mode-human' : 'assistant-mode-server'}>{isHumanWorkflow ? '人工操作·全程审计' : '确认后服务端执行'}</b></td>
                            <td><input aria-label={`${assistantCapabilityNames[capability.id]}自然语言别名`} value={capability.aliases.join('、')} onChange={(event) => { const next = cloneConfig(draft); next.assistantCapabilities![index]!.aliases = event.target.value.split(/[、,，]/u).map((item) => item.trim()).filter(Boolean).slice(0, 20); setDraft(next); setConfigDirty(true) }} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <SopRulesEditor
                rules={draft.sopRules ?? []}
                executions={data.sopExecutions ?? []}
                actionRecords={data.sopActionRecords ?? []}
                serviceTypes={draft.serviceTypes}
                roles={draft.roles}
                areas={data.areas}
                tables={data.tables}
                products={data.products}
                employees={data.employees}
                workstations={draft.workstations}
                onChange={(sopRules) => {
                  const next = cloneConfig(draft)
                  next.sopRules = sopRules
                  setDraft(next)
                  setConfigDirty(true)
                }}
              />

              <div className="config-section table-operations-config">
                <div className="config-section-title table-ops-config-title">
                  <CircleDollarSign size={19} />
                  <div><strong>桌台低消与提醒</strong><span>区域/桌台、星期、跨午夜时段；入座后按版本快照执行</span></div>
                  <b>当前 V{tableOpsDraft.version}</b>
                  <button className="secondary-button" disabled={busy || tableOpsDraft.minimumSpendRules.length >= 500} onClick={addMinimumSpendRule}><Plus size={15} />新增规则</button>
                </div>
                <div className="minimum-reminder-config">
                  <div className="switch-field"><span>营业日自动切换</span><label className="switch"><input type="checkbox" checked={tableOpsDraft.automaticBusinessDayRollover ?? true} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, automaticBusinessDayRollover: event.target.checked }); setTableOpsDirty(true) }} /><span /></label></div>
                  <label><span>切换时间（北京时间整点）</span><input type="number" min={0} max={23} value={tableOpsDraft.businessDayRolloverHour ?? 6} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, businessDayRolloverHour: Number(event.target.value) }); setTableOpsDirty(true) }} /></label>
                  <label><span>最长开台（小时）</span><input type="number" min={6} max={48} value={tableOpsDraft.maximumOpenHours ?? 12} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, maximumOpenHours: Number(event.target.value) }); setTableOpsDirty(true) }} /></label>
                  <div className="switch-field"><span>启用提醒</span><label className="switch"><input type="checkbox" checked={tableOpsDraft.reminder.enabled} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, reminder: { ...tableOpsDraft.reminder, enabled: event.target.checked } }); setTableOpsDirty(true) }} /><span /></label></div>
                  <label><span>首次提醒（分钟）</span><input type="number" min={1} max={720} value={tableOpsDraft.reminder.firstReminderMinutes} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, reminder: { ...tableOpsDraft.reminder, firstReminderMinutes: Number(event.target.value) } }); setTableOpsDirty(true) }} /></label>
                  <label><span>重复间隔（分钟）</span><input type="number" min={1} max={720} value={tableOpsDraft.reminder.repeatMinutes} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, reminder: { ...tableOpsDraft.reminder, repeatMinutes: Number(event.target.value) } }); setTableOpsDirty(true) }} /></label>
                  <label><span>进度阈值（%）</span><input type="number" min={1} max={100} value={tableOpsDraft.reminder.thresholdPercent} onChange={(event) => { setTableOpsDraft({ ...tableOpsDraft, reminder: { ...tableOpsDraft.reminder, thresholdPercent: Number(event.target.value) } }); setTableOpsDirty(true) }} /></label>
                </div>
                <div className="minimum-rule-list">
                  {tableOpsDraft.minimumSpendRules.length === 0 && <div className="minimum-rule-empty">尚未配置低消规则，新开桌次低消为0元。</div>}
                  {tableOpsDraft.minimumSpendRules.map((rule, index) => {
                    const targets = rule.targetType === 'table' ? data.tables : data.areas
                    return <div className="minimum-rule-row" key={rule.id}>
                      <div className="minimum-rule-enabled"><span>启用规则</span><label className="switch"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateMinimumSpendRule(index, { enabled: event.target.checked })} /><span /></label></div>
                      <label><span>规则名称</span><input maxLength={80} value={rule.name} onChange={(event) => updateMinimumSpendRule(index, { name: event.target.value })} /></label>
                      <label><span>作用范围</span><select value={rule.targetType} onChange={(event) => { const targetType = event.target.value as MinimumSpendRule['targetType']; const targetId = targetType === 'table' ? data.tables[0]?.id : data.areas[0]?.id; if (targetId) updateMinimumSpendRule(index, { targetType, targetId }) }}><option value="area">区域</option><option value="table">桌台</option></select></label>
                      <label><span>{rule.targetType === 'table' ? '桌台' : '区域'}</span><select value={rule.targetId} onChange={(event) => updateMinimumSpendRule(index, { targetId: event.target.value })}>{targets.map((target) => <option key={target.id} value={target.id}>{'code' in target ? `${target.code} · ${target.displayName}` : target.name}</option>)}</select></label>
                      <div className="weekday-control"><span>星期</span><div>{weekdayLabels.map((label, weekday) => <label key={label}><input type="checkbox" checked={rule.weekdays.includes(weekday)} onChange={(event) => updateMinimumSpendRule(index, { weekdays: event.target.checked ? [...rule.weekdays, weekday].toSorted() : rule.weekdays.filter((value) => value !== weekday) })} />{label}</label>)}</div></div>
                      <label><span>开始</span><input type="time" value={rule.startTime} onChange={(event) => updateMinimumSpendRule(index, { startTime: event.target.value })} /></label>
                      <label><span>结束</span><input type="time" value={rule.endTime} onChange={(event) => updateMinimumSpendRule(index, { endTime: event.target.value })} /></label>
                      <label><span>低消（元）</span><input type="number" min={0} step="1" value={rule.amount / 100} onChange={(event) => updateMinimumSpendRule(index, { amount: Math.round(Number(event.target.value) * 100) })} /></label>
                      <button className="icon-button" title="删除规则" onClick={() => { setTableOpsDraft({ ...tableOpsDraft, minimumSpendRules: tableOpsDraft.minimumSpendRules.filter((_, ruleIndex) => ruleIndex !== index) }); setTableOpsDirty(true) }}><Trash2 size={16} /></button>
                    </div>
                  })}
                </div>
                <div className="table-ops-save">
                  <label><span>变更原因</span><input maxLength={300} placeholder="例如：周末卡座低消调整" value={tableOpsReason} onChange={(event) => setTableOpsReason(event.target.value)} /></label>
                  <button className="primary-button" disabled={busy || !tableOpsDirty || tableOpsReason.trim().length < 2} onClick={() => void saveTableOperationsConfig()}><Save size={16} />保存并生效</button>
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><BellRing size={19} /><div><strong>服务SLA</strong><span>秒</span></div></div>
                <div className="config-table-wrap">
                  <table className="config-table">
                    <thead><tr><th>服务</th><th>启用</th><th>预警</th><th>首次升级</th><th>经理接管</th></tr></thead>
                    <tbody>
                      {draft.serviceTypes.map((serviceType, index) => (
                        <tr key={serviceType.id}>
                          <td><strong>{serviceType.name}</strong></td>
                          <td><label className="switch"><input type="checkbox" checked={serviceType.enabled} onChange={(event) => { const next = cloneConfig(draft); next.serviceTypes[index]!.enabled = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></td>
                          {(['warningSeconds', 'escalateSeconds', 'managerSeconds'] as const).map((field) => (
                            <td key={field}><input className="number-input" type="number" min={5} max={3600} value={serviceType.sla[field]} onChange={(event) => { const next = cloneConfig(draft); next.serviceTypes[index]!.sla[field] = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><ShieldCheck size={19} /><div><strong>客户连续呼叫保护</strong><span>相同需求自动合并，不重复派单</span></div></div>
                <div className="proactive-config-grid">
                  <label><span>统计窗口（秒）</span><input className="number-input" type="number" min={10} max={600} value={draft.guestServiceLimits.windowSeconds} onChange={(event) => { const next = cloneConfig(draft); next.guestServiceLimits.windowSeconds = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                  <label><span>窗口内最多提交</span><input className="number-input" type="number" min={1} max={30} value={draft.guestServiceLimits.maxRequests} onChange={(event) => { const next = cloneConfig(draft); next.guestServiceLimits.maxRequests = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                  <label><span>相同需求合并（秒）</span><input className="number-input" type="number" min={5} max={600} value={draft.guestServiceLimits.duplicateSeconds} onChange={(event) => { const next = cloneConfig(draft); next.guestServiceLimits.duplicateSeconds = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><Sparkles size={19} /><div><strong>超嗨部落母品牌</strong><span>M-Box 是旗下现场空间，母品牌元素以轻量方式进入客人与员工触点</span></div></div>
                <div className="community-brand-config">
                  <div className="community-brand-switches">
                    <div className="switch-field"><span>启用品牌</span><label className="switch"><input type="checkbox" checked={draft.communityBrand.enabled} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.enabled = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></div>
                    <div className="switch-field"><span>订单页露出</span><label className="switch"><input type="checkbox" checked={draft.communityBrand.guestOrderVisible} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.guestOrderVisible = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></div>
                    <div className="switch-field"><span>会员中心露出</span><label className="switch"><input type="checkbox" checked={draft.communityBrand.memberPortalVisible} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.memberPortalVisible = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></div>
                  </div>
                  <div className="community-brand-fields">
                    <label><span>品牌名称</span><input maxLength={40} value={draft.communityBrand.name} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.name = event.target.value; setDraft(next); setConfigDirty(true) }} /></label>
                    <label><span>英文标识</span><input maxLength={60} value={draft.communityBrand.eyebrow} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.eyebrow = event.target.value; setDraft(next); setConfigDirty(true) }} /></label>
                    <label className="wide"><span>品牌口号</span><input maxLength={120} value={draft.communityBrand.tagline} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.tagline = event.target.value; setDraft(next); setConfigDirty(true) }} /></label>
                    <label className="wide"><span>品牌标识图片</span><input maxLength={240} value={draft.communityBrand.markUrl} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.markUrl = event.target.value; setDraft(next); setConfigDirty(true) }} /></label>
                  </div>
                  <div className="community-brand-highlights">
                    <div><strong>活动关键词</strong><button className="secondary-button" disabled={draft.communityBrand.highlights.length >= 6} onClick={() => { const next = cloneConfig(draft); next.communityBrand.highlights.push('新关键词'); setDraft(next); setConfigDirty(true) }}><Plus size={14} />添加</button></div>
                    <div>{draft.communityBrand.highlights.map((highlight, index) => <label key={index}><input maxLength={20} value={highlight} onChange={(event) => { const next = cloneConfig(draft); next.communityBrand.highlights[index] = event.target.value; setDraft(next); setConfigDirty(true) }} /><button className="icon-button" title="删除关键词" disabled={draft.communityBrand.highlights.length <= 1} onClick={() => { const next = cloneConfig(draft); next.communityBrand.highlights.splice(index, 1); setDraft(next); setConfigDirty(true) }}><Trash2 size={14} /></button></label>)}</div>
                  </div>
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><UsersRound size={19} /><div><strong>岗位负荷</strong><span>每人进行中任务上限</span></div></div>
                <div className="role-config-grid">
                  {draft.roles.map((role, index) => (
                    <div className="role-config-row" key={role.id}>
                      <div><strong>{role.name}</strong><span>{role.canReceiveTasks ? '参与自动调度' : '暂停自动调度'}</span></div>
                      <label className="switch"><input type="checkbox" checked={role.canReceiveTasks} onChange={(event) => { const next = cloneConfig(draft); next.roles[index]!.canReceiveTasks = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label>
                      <input className="number-input" type="number" min={1} max={20} value={role.maxConcurrentTasks} onChange={(event) => { const next = cloneConfig(draft); next.roles[index]!.maxConcurrentTasks = Number(event.target.value); setDraft(next); setConfigDirty(true) }} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><Timer size={19} /><div><strong>待点单主动服务</strong><span>员工标记后按时间触发协助点单任务</span></div></div>
                <div className="proactive-config-grid">
                  <div className="switch-field"><span>启用</span><label className="switch"><input type="checkbox" checked={draft.proactiveOrderCare.enabled} onChange={(event) => { const next = cloneConfig(draft); next.proactiveOrderCare.enabled = event.target.checked; setDraft(next); setConfigDirty(true) }} /><span /></label></div>
                  <label><span>首次提醒（秒）</span><input className="number-input" type="number" min={30} max={3600} value={draft.proactiveOrderCare.firstReminderSeconds} onChange={(event) => { const next = cloneConfig(draft); next.proactiveOrderCare.firstReminderSeconds = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                  <label><span>再次提醒（秒）</span><input className="number-input" type="number" min={30} max={3600} value={draft.proactiveOrderCare.repeatReminderSeconds} onChange={(event) => { const next = cloneConfig(draft); next.proactiveOrderCare.repeatReminderSeconds = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                  <label><span>最多提醒次数</span><input className="number-input" type="number" min={1} max={10} value={draft.proactiveOrderCare.maxReminders} onChange={(event) => { const next = cloneConfig(draft); next.proactiveOrderCare.maxReminders = Number(event.target.value); setDraft(next); setConfigDirty(true) }} /></label>
                  <label><span>使用服务剧本</span><select value={draft.proactiveOrderCare.serviceTypeId} onChange={(event) => { const next = cloneConfig(draft); next.proactiveOrderCare.serviceTypeId = event.target.value; setDraft(next); setConfigDirty(true) }}>{draft.serviceTypes.map((serviceType) => <option key={serviceType.id} value={serviceType.id}>{serviceType.name}</option>)}</select></label>
                </div>
              </div>

              <div className="config-section">
                <div className="config-section-title"><Settings2 size={19} /><div><strong>服务剧本</strong><span>客户回复、优先级、接单岗位和动作步骤</span></div></div>
                <div className="script-config-list">
                  {draft.serviceTypes.map((serviceType, index) => (
                    <div className="script-config-row" key={serviceType.id}>
                      <div className="script-config-name"><strong>{serviceType.name}</strong><span>{serviceType.code}</span></div>
                      <label><span>优先级</span><select value={serviceType.priority} onChange={(event) => { const next = cloneConfig(draft); next.serviceTypes[index]!.priority = event.target.value as ServiceTask['priority']; setDraft(next); setConfigDirty(true) }}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label>
                      <label className="reply-field"><span>客户即时回复</span><input value={serviceType.customerReply} onChange={(event) => { const next = cloneConfig(draft); next.serviceTypes[index]!.customerReply = event.target.value; setDraft(next); setConfigDirty(true) }} /></label>
                      <div className="dispatch-role-field"><span>接单岗位</span><div>{draft.roles.map((role) => <label key={role.id}><input type="checkbox" checked={serviceType.dispatchRoleIds.includes(role.id)} onChange={(event) => { const next = cloneConfig(draft); const ids = next.serviceTypes[index]!.dispatchRoleIds; next.serviceTypes[index]!.dispatchRoleIds = event.target.checked ? [...ids, role.id] : ids.filter((id) => id !== role.id); setDraft(next); setConfigDirty(true) }} />{role.name}</label>)}</div></div>
                      <label className="script-steps-field"><span>AI动作步骤（每行一步）</span><textarea rows={3} value={serviceType.actionScript.join('\n')} onChange={(event) => { const next = cloneConfig(draft); next.serviceTypes[index]!.actionScript = event.target.value.split('\n').map((step) => step.trim()).filter(Boolean); setDraft(next); setConfigDirty(true) }} /></label>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          </Suspense>
        </main>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, tone, onClick }: { icon: typeof LayoutDashboard; label: string; value: number; tone: string; onClick?: () => void }) {
  const content = <>
      <span className="metric-icon"><Icon size={19} /></span>
      <div><strong>{value}</strong><span>{label}</span></div>
    </>
  return onClick
    ? <button type="button" className={`metric metric-${tone} is-actionable`} onClick={onClick} aria-label={`查看${label}${value}项`}>{content}</button>
    : <div className={`metric metric-${tone}`}>{content}</div>
}

function elapsedMinutes(startedAt: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000))
}

function formatNextReminder(nextReminderAt: string | null) {
  if (!nextReminderAt) return '等待本轮处理'
  const seconds = Math.max(0, Math.ceil((new Date(nextReminderAt).getTime() - Date.now()) / 1000))
  if (seconds < 60) return `${seconds}秒后`
  return `${Math.ceil(seconds / 60)}分钟后`
}

function money(amount: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(amount / 100)
}

function turnoverKdsStatus(status: BootstrapResponse['orderDomain']['kdsTasks'][number]['status']) {
  return ({ queued: '待制作', preparing: '制作中', completed: '待取走', picked_up: '配送中', delivered: '已送达' })[status]
}

function accountingRecommendation(result: ManagerKdsCancellationResult) {
  if (result.accounting.recommendation === 'no_financial_action') return '该商品为赠品，建议核对后不做金额处理。'
  if (result.accounting.recommendation === 'review_refund') {
    return `已收款，建议核对后决定是否申请部分退款 ${money(result.accounting.suggestedAmount)}。`
  }
  return `尚未收款，建议核对后决定是否调整应收 ${money(result.accounting.suggestedAmount)}。`
}

function configOperationLabel(operation: BootstrapResponse['configVersions'][number]['operation']) {
  return operation === 'rollback' ? '回滚发布' : operation === 'publish' ? '正常发布' : '初始基线'
}
