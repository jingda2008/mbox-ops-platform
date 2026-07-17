import {
  Banknote,
  BellRing,
  CalendarDays,
  CircleAlert,
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
import { lazy, Suspense, useEffect, useState } from 'react'
import {
  actOnTask,
  assignTableSessionSales,
  closeTableSession,
  getCurrentActorId,
  getTableSessionSummary,
  openWalkInTable,
  operateTableCombination,
  publishConfig,
  resetDemo,
  rollbackConfig,
  saveConfigDraft,
  startAwaitingOrder,
  stopAwaitingOrder,
  transferTableSession,
  updateTableOperationsConfig,
} from '../api'
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
import { effectiveDataScopeForEmployee, effectiveRoleIdsForEmployee } from '../shared/staff-access'
import { TaskQueue } from './TaskQueue'
import { getFulfillmentAccess, kdsTaskOperationallyActive, taskVisibleToAccess } from './commerce-workspace'
import { RoleHomeView } from './RoleHomeView'
import { getRoleHomeAccess, type RoleHomeNavigationId } from './role-access'
import './OperationsConsole.css'

const MasterDataView = lazy(() => import('./MasterDataView').then((module) => ({ default: module.MasterDataView })))
const CommerceView = lazy(() => import('./CommerceView').then((module) => ({ default: module.CommerceView })))
const PaymentView = lazy(() => import('./PaymentView').then((module) => ({ default: module.PaymentView })))
const BenefitCenterView = lazy(() => import('./BenefitCenterView').then((module) => ({ default: module.BenefitCenterView })))
const SongCenterView = lazy(() => import('./SongCenterView').then((module) => ({ default: module.SongCenterView })))
const ReservationView = lazy(() => import('./ReservationView').then((module) => ({ default: module.ReservationView })))
const InventoryView = lazy(() => import('./InventoryView').then((module) => ({ default: module.InventoryView })))

type View = 'home' | RoleHomeNavigationId

interface OperationsConsoleProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
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
  songs: '演出与点歌',
  layout: '桌台布局',
  master: '门店主数据',
  config: '运营配置',
}

const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六']

function cloneConfig(config: StoreConfig) {
  return structuredClone(config)
}

function tableOperationsConfig(config?: TableOperationsConfig): TableOperationsConfig {
  return structuredClone(config ?? {
    version: 1,
    updatedAt: '1970-01-01T00:00:00.000Z',
    reminder: { enabled: true, firstReminderMinutes: 60, repeatMinutes: 30, thresholdPercent: 80 },
    minimumSpendRules: [],
  })
}

export function OperationsConsole({ data, onRefresh }: OperationsConsoleProps) {
  const fulfillmentAccess = getFulfillmentAccess(data, getCurrentActorId())
  const roleHomeAccess = getRoleHomeAccess(data, fulfillmentAccess.employee?.roleId ?? '')
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
    && !['confirmed', 'cancelled'].includes(task.status)
  ))
  const availableNavigation = navigation.filter((item) => {
    if (item.id === 'home') return true
    return roleHomeAccess.allowedNavigationIds.includes(item.id)
  })
  const [view, setView] = useState<View>('home')
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [draft, setDraft] = useState(() => cloneConfig(data.draftConfig ?? data.config))
  const [configDirty, setConfigDirty] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
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

  useEffect(() => {
    if (!configDirty) setDraft(cloneConfig(data.draftConfig ?? data.config))
  }, [data.config, data.draftConfig, configDirty])

  useEffect(() => {
    if (!tableOpsDirty) setTableOpsDraft(tableOperationsConfig(data.tableOperationsConfig))
  }, [data.tableOperationsConfig, tableOpsDirty])

  const openTasks = fulfillmentAccess.mode === 'oversight'
    ? data.tasks.filter((task) => !['confirmed', 'cancelled'].includes(task.status))
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
  const currentRole = data.config.roles.find((role) => role.id === fulfillmentAccess.employee?.roleId)
  const canTransferTable = currentRole?.permissionIds?.includes('table.manage') ?? false
  const canOpenWalkIn = currentRole?.permissionIds?.includes('reservation.manage') ?? false
  const canWaiveMinimumSpend = ['manager', 'owner'].includes(fulfillmentAccess.employee?.roleId ?? '')
  const salesEmployees = data.employees.filter((employee) => employee.status === 'active' && employee.online)
  const selectedSession = selectedTable
    ? data.songState.tableSessions.find((session) => session.tableId === selectedTable.id && session.status === 'open') ?? null
    : null
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
    setSessionSummary(null)
  }, [selectedTableId])

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
    setBusy(true)
    try {
      await actOnTask(task.id, { action, actorId, note: action === 'complete' ? '现场服务完成' : '' })
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '任务操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleAwaitingOrder(action: 'start' | 'stop') {
    if (!selectedTable) return
    setBusy(true)
    try {
      if (action === 'start') {
        await startAwaitingOrder(selectedTable.id, selectedTable.primaryEmployeeId)
        setNotice(`${selectedTable.code}已标记暂未点单，系统将在合适时间提醒服务`)
      } else {
        await stopAwaitingOrder(selectedTable.id, selectedTable.primaryEmployeeId, '客人暂不需要点单服务')
        setNotice(`${selectedTable.code}待点单提醒已结束`)
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
        reminder: tableOpsDraft.reminder,
        minimumSpendRules: tableOpsDraft.minimumSpendRules,
        reason: tableOpsReason.trim(),
      })
      setTableOpsDraft(saved)
      setTableOpsDirty(false)
      setTableOpsReason('')
      setNotice(`桌台经营配置V${saved.version}已生效；已开桌次继续使用原快照`)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '桌台经营配置保存失败')
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
    }
  }

  async function saveDraft() {
    setBusy(true)
    try {
      await saveConfigDraft(configPayload())
      setConfigDirty(false)
      setNotice('配置草稿已保存')
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '草稿保存失败')
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
      setNotice(`配置V${published.version}已发布`)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '配置发布失败')
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
      setNotice(`已按V${version}快照生成并发布V${published.version}`)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '配置回滚失败')
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
                onClick={() => { setView(item.id); setMobileNavOpen(false) }}
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
            <span className="eyebrow">{data.store.businessDate} · 营业中 · {fulfillmentAccess.roleLabel}</span>
            <h1>{viewTitles[view]}</h1>
          </div>
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

        {notice && <div className="notice-bar" role="status">{notice}<button onClick={() => setNotice('')}><X size={16} /></button></div>}

        <main className="main-content" aria-busy={busy}>
          <Suspense fallback={<div className="empty-state" role="status">正在载入当前工作台</div>}>
          {view === 'home' && (
            <RoleHomeView
              data={data}
              employeeId={fulfillmentAccess.employee?.id ?? ''}
              onNavigate={(nextView) => setView(nextView)}
            />
          )}
          {view === 'live' && (
            <>
              <section className="metrics-grid">
                <Metric icon={CircleDot} label="营业桌台" value={data.metrics.occupiedTables} tone="neutral" />
                <Metric icon={BellRing} label="待处理任务" value={data.metrics.openTasks} tone="blue" />
                <Metric icon={CircleAlert} label="SLA风险" value={data.metrics.atRiskTasks} tone="yellow" />
                <Metric icon={ShieldCheck} label="投诉接管" value={data.metrics.complaints} tone="red" />
              </section>

              <div className="live-grid">
                <section className="floor-operations">
                  <div className="section-heading">
                    <div><span className="eyebrow">桌台责任区</span><h2>现场桌台</h2></div>
                    <div className="legend"><span><i className="dot occupied" />营业</span><span><i className="dot reserved" />预订</span><span><i className="dot available" />空台</span></div>
                  </div>
                  {selectedTable && selectedTable.status === 'available' && canOpenWalkIn && (
                    <div className="table-walkin-toolbar">
                      <div className="table-business-heading"><DoorOpen size={19} /><div><strong>{selectedTable.code} 临客开台</strong><span>确认人数与销售后一次完成入座</span></div></div>
                      <label><span>人数</span><div className="party-stepper"><button title="减少人数" disabled={walkInPartySize <= 1} onClick={() => setWalkInPartySize((value) => Math.max(1, value - 1))}><Minus size={15} /></button><b>{walkInPartySize}</b><button title="增加人数" disabled={walkInPartySize >= selectedTable.capacity} onClick={() => setWalkInPartySize((value) => Math.min(selectedTable.capacity, value + 1))}><Plus size={15} /></button></div></label>
                      <label><span>销售归属</span><select value={walkInSalesEmployeeId} onChange={(event) => setWalkInSalesEmployeeId(event.target.value)}><option value="">请选择销售</option>{salesEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
                      <button className="primary-button" disabled={busy || !walkInSalesEmployeeId} onClick={() => void handleWalkInOpen()}><DoorOpen size={17} />确认开台</button>
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
                      {selectedAwaitingOrder ? (
                        <>
                          <div className="next-care"><Timer size={17} /><span>下次检查</span><strong>{formatNextReminder(selectedAwaitingOrder.nextReminderAt)}</strong></div>
                          <button className="secondary-button" disabled={busy} onClick={() => void handleAwaitingOrder('stop')}>结束提醒</button>
                        </>
                      ) : (
                        <button className="primary-button" disabled={busy || selectedTableHasOrder} onClick={() => void handleAwaitingOrder('start')}><UtensilsCrossed size={17} />暂未点单</button>
                      )}
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && sessionSummary && (
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
                      {sessionSummary.reminderRequired && <div className="minimum-spend-reminder"><BellRing size={16} /><span>低消进度低于提醒阈值</span><small>{sessionSummary.nextReminderAt ? `${new Date(sessionSummary.nextReminderAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}再次检查` : ''}</small></div>}
                      {canWaiveMinimumSpend && sessionSummary.differenceAmount > 0 && <div className="minimum-spend-waiver"><input maxLength={300} placeholder="经理豁免原因（至少5字）" value={minimumSpendWaiverReason} onChange={(event) => setMinimumSpendWaiverReason(event.target.value)} /><button className="secondary-button" disabled={busy || minimumSpendWaiverReason.trim().length < 5} onClick={() => void handleMinimumSpendWaiver()}><ShieldCheck size={15} />豁免并结台</button></div>}
                    </div>
                  )}
                  {selectedTable && selectedTable.status === 'occupied' && canTransferTable && selectedCombinationLinks.length === 0 && (
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
                  {selectedTable && selectedTable.status === 'occupied' && canTransferTable && (
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
                                className={`table-tile status-${table.status} ${awaitingOrder ? 'is-awaiting-order' : ''} ${selectedTableId === table.id ? 'is-selected' : ''}`}
                                onClick={() => setSelectedTableId(selectedTableId === table.id ? null : table.id)}
                              >
                                <span className="table-code">{table.code}</span>
                                <strong>{table.displayName}</strong>
                                <small>{awaitingOrder
                                  ? `待点单 ${elapsedMinutes(awaitingOrder.startedAt)}分钟 · ${owner?.displayName}`
                                  : table.status === 'occupied' ? `${table.guestCount}位 · ${owner?.displayName}` : table.status === 'reserved' ? '待到店' : '可开台'}</small>
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
                  currentEmployeeId={fulfillmentAccess.employee?.id ?? ''}
                  claimableTaskIds={claimableTaskIds}
                />
              </div>
            </>
          )}

          {view === 'tasks' && (
            <TaskQueue
              tasks={visibleServiceTasks}
              tables={data.tables}
              employees={data.employees}
              serviceTypes={data.config.serviceTypes}
              selectedTableId={selectedTableId}
              onClearTable={() => setSelectedTableId(null)}
              onAction={handleTaskAction}
              currentEmployeeId={fulfillmentAccess.employee?.id ?? ''}
              claimableTaskIds={claimableTaskIds}
            />
          )}

          {view === 'commerce' && (
            <CommerceView data={data} onRefresh={onRefresh} onNotice={setNotice} />
          )}

          {view === 'reservations' && <ReservationView data={data} />}

          {view === 'inventory' && <InventoryView />}

          {view === 'payments' && <PaymentView data={data} onRefresh={onRefresh} />}

          {view === 'benefits' && <BenefitCenterView data={data} onRefresh={onRefresh} onNotice={setNotice} />}

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
                      <time>{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
                      {record.version === data.config.version
                        ? <b>当前版本</b>
                        : <button className="secondary-button" disabled={busy || Boolean(data.draftConfig)} onClick={() => void rollbackVersion(record.version)}><RefreshCw size={14} />回滚</button>}
                    </div>
                  ))}
                </div>
                {data.draftConfig && <p className="config-history-warning">存在未发布草稿，发布后才能回滚。</p>}
              </div>

              <div className="config-section table-operations-config">
                <div className="config-section-title table-ops-config-title">
                  <CircleDollarSign size={19} />
                  <div><strong>桌台低消与提醒</strong><span>区域/桌台、星期、跨午夜时段；入座后按版本快照执行</span></div>
                  <b>当前 V{tableOpsDraft.version}</b>
                  <button className="secondary-button" disabled={busy || tableOpsDraft.minimumSpendRules.length >= 500} onClick={addMinimumSpendRule}><Plus size={15} />新增规则</button>
                </div>
                <div className="minimum-reminder-config">
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

function Metric({ icon: Icon, label, value, tone }: { icon: typeof LayoutDashboard; label: string; value: number; tone: string }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span className="metric-icon"><Icon size={19} /></span>
      <div><strong>{value}</strong><span>{label}</span></div>
    </div>
  )
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

function configOperationLabel(operation: BootstrapResponse['configVersions'][number]['operation']) {
  return operation === 'rollback' ? '回滚发布' : operation === 'publish' ? '正常发布' : '初始基线'
}
