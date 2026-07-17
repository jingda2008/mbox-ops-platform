import type { BootstrapResponse, Employee, StaffPermissionId } from '../shared/contracts'
import { kdsTaskOperationallyActive } from './commerce-workspace'

export const roleHomeNavigation = [
  { id: 'live', label: '现场' },
  { id: 'tasks', label: '任务' },
  { id: 'reservations', label: '预约' },
  { id: 'commerce', label: '订单/KDS' },
  { id: 'inventory', label: '库存/存酒' },
  { id: 'payments', label: '收银/支付' },
  { id: 'benefits', label: '会员权益' },
  { id: 'songs', label: '演出/点歌' },
  { id: 'layout', label: '布局' },
  { id: 'master', label: '主数据' },
  { id: 'config', label: '配置' },
] as const

export type RoleHomeNavigationId = (typeof roleHomeNavigation)[number]['id']
export type RoleHomeKind = 'owner' | 'operations_director' | 'admin' | 'manager' | 'server' | 'bartender' | 'kitchen' | 'cashier' | 'host' | 'runner' | 'custom'
export type RoleHomeIndicator = 'tables' | 'tasks' | 'risk' | 'kds' | 'people' | 'config' | 'payments' | 'reservations'
export type RoleHomeTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

export interface RoleHomeAccess {
  kind: RoleHomeKind
  title: string
  focusLabel: string
  roleLabel: string
  allowedNavigationIds: readonly RoleHomeNavigationId[]
  isFallback: boolean
}

export interface RoleHomeMetric {
  id: string
  label: string
  value: number | string
  indicator: RoleHomeIndicator
  tone: RoleHomeTone
  navigationId: RoleHomeNavigationId
}

export interface RoleHomeTodo {
  id: string
  label: string
  detail: string
  count: number
  tone: RoleHomeTone
  navigationId: RoleHomeNavigationId
}

export interface RoleHomeModel {
  employee: Employee | undefined
  access: RoleHomeAccess
  metrics: RoleHomeMetric[]
  todos: RoleHomeTodo[]
  navigation: Array<{ id: RoleHomeNavigationId; label: string }>
}

interface RoleProfile {
  title: string
  focusLabel: string
  navigation: readonly RoleHomeNavigationId[]
}

const allNavigation = roleHomeNavigation.map((item) => item.id)

const roleProfiles: Record<RoleHomeKind, RoleProfile> = {
  owner: { title: '老板工作台', focusLabel: '全店经营与风险', navigation: allNavigation },
  operations_director: { title: '运营负责人工作台', focusLabel: '经营执行与风险闭环', navigation: allNavigation },
  admin: { title: '管理员工作台', focusLabel: '系统运行与配置', navigation: allNavigation },
  manager: {
    title: '店长工作台',
    focusLabel: '现场调度与异常接管',
    navigation: ['live', 'tasks', 'reservations', 'commerce', 'inventory', 'payments', 'benefits', 'songs', 'layout'],
  },
  server: {
    title: '服务员工作台',
    focusLabel: '责任桌台与服务响应',
    navigation: ['live', 'tasks', 'commerce', 'benefits', 'songs'],
  },
  bartender: {
    title: '调酒师工作台',
    focusLabel: '吧台制作与交付',
    navigation: ['tasks', 'commerce', 'inventory'],
  },
  kitchen: {
    title: '厨房工作台',
    focusLabel: '厨房出品与交付',
    navigation: ['tasks', 'commerce', 'inventory'],
  },
  cashier: {
    title: '收银员工作台',
    focusLabel: '收款、对账与退款',
    navigation: ['reservations', 'tasks', 'payments', 'inventory'],
  },
  host: {
    title: '门迎工作台',
    focusLabel: '预约到店与迎宾',
    navigation: ['live', 'tasks', 'reservations', 'benefits'],
  },
  runner: {
    title: '传菜员工作台',
    focusLabel: '取货、配送与送达',
    navigation: ['live', 'tasks', 'commerce'],
  },
  custom: {
    title: '岗位工作台',
    focusLabel: '已分配任务与 KDS',
    navigation: ['tasks', 'commerce'],
  },
}

const roleNavigationLabels: Partial<Record<RoleHomeKind, Partial<Record<RoleHomeNavigationId, string>>>> = {
  owner: { live: '全店现场', commerce: '订单与出品', payments: '收银与账务', master: '人员与岗位' },
  operations_director: { live: '全店现场', commerce: '订单与出品', master: '人员与岗位', config: '运营规则' },
  admin: { live: '运行状态', master: '人员与权限', config: '系统配置' },
  manager: { live: '现场调度', commerce: '订单与出品', payments: '收银与退款', songs: '演出与点歌' },
  server: { live: '我的桌台', tasks: '服务提醒', commerce: '点单与送餐', benefits: '赠送权益', songs: '协助点歌' },
  bartender: { tasks: '服务提醒', commerce: '酒水制作', inventory: '吧台库存' },
  kitchen: { tasks: '服务提醒', commerce: '餐品制作', inventory: '后厨库存' },
  cashier: { reservations: '预约订金', tasks: '收银提醒', payments: '收银与退款', inventory: '盘点交接' },
  host: { live: '桌台状态', tasks: '接待提醒', reservations: '预约与入座', benefits: '客户权益' },
  runner: { live: '桌台位置', tasks: '配送提醒', commerce: '取货与送达' },
  custom: { tasks: '我的任务', commerce: '我的出品' },
}

const roleAliases: Record<Exclude<RoleHomeKind, 'custom'>, readonly string[]> = {
  owner: ['owner', 'boss', 'proprietor', 'store-owner', '老板', '店主'],
  operations_director: ['operations-director', '运营负责人'],
  admin: ['admin', 'administrator', 'system-admin', 'super-admin', '管理员', '系统管理员'],
  manager: ['manager', 'store-manager', 'shift-manager', 'general-manager', 'supervisor', '店长', '值班经理', '领班'],
  server: ['server', 'backup', 'specialist', 'waiter', 'waitstaff', 'service', '服务员', '主服务员', '区域候补', '服务专员'],
  bartender: ['bartender', 'bar', 'bar-staff', '调酒师', '鸡尾酒调酒师', '吧台'],
  kitchen: ['kitchen', 'cook', 'chef', 'kitchen-staff', '厨房', '厨师', '厨房出品'],
  cashier: ['cashier', 'checkout', '收银', '收银员'],
  host: ['host', 'reception', 'receptionist', 'greeter', '门迎', '迎宾'],
  runner: ['runner', 'food-runner', '传菜员', '传菜', '传菜取送'],
}

const openServiceStatuses = new Set(['pending', 'accepted', 'arrived', 'reopened', 'escalated'])
const openKdsStatuses = new Set(['queued', 'preparing', 'completed', 'picked_up'])

export function getRoleHomeAccess(data: BootstrapResponse, roleId: string): RoleHomeAccess {
  const configuredRole = data.config.roles.find((role) => role.id === roleId)
  const kind = resolveRoleHomeKind(roleId, configuredRole?.name)
  const profile = roleProfiles[kind]
  const configuredNavigation = configuredRole?.permissionIds
    ? navigationForPermissions(configuredRole.permissionIds)
    : null
  return {
    kind,
    title: profile.title,
    focusLabel: profile.focusLabel,
    roleLabel: configuredRole?.name ?? (roleId || '身份未识别'),
    allowedNavigationIds: configuredNavigation ?? profile.navigation,
    isFallback: kind === 'custom',
  }
}

const navigationPermissions: Record<RoleHomeNavigationId, readonly StaffPermissionId[]> = {
  live: ['dashboard.view'],
  tasks: ['service.execute', 'complaint.handle'],
  reservations: ['reservation.view', 'reservation.manage', 'reservation.config.manage'],
  commerce: ['order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'commerce.authorization.request', 'commerce.authorization.approve'],
  inventory: ['inventory.view', 'inventory.manage', 'inventory.approve'],
  payments: ['finance.view', 'payment.collect', 'payment.pos_report', 'payment.refund.request', 'payment.refund.approve'],
  benefits: ['benefit.view', 'benefit.grant', 'benefit.approve', 'benefit.manage'],
  songs: ['song.view', 'song.manage'],
  layout: ['table.manage'],
  master: ['identity.manage', 'master_data.manage', 'shift.manage'],
  config: ['config.manage'],
}

function navigationForPermissions(permissionIds: readonly StaffPermissionId[]) {
  return roleHomeNavigation
    .filter((item) => navigationPermissions[item.id].some((permissionId) => permissionIds.includes(permissionId)))
    .map((item) => item.id)
}

export function resolveRoleHomeKind(roleId: string, roleName?: string): RoleHomeKind {
  const normalizedRoleId = normalizeRoleToken(roleId)
  const candidates = normalizedRoleId ? [normalizedRoleId] : [normalizeRoleToken(roleName ?? '')].filter(Boolean)
  for (const [kind, aliases] of Object.entries(roleAliases) as Array<[Exclude<RoleHomeKind, 'custom'>, readonly string[]]>) {
    if (candidates.some((candidate) => aliases.includes(candidate))) return kind
  }
  return 'custom'
}

export function isRoleNavigationAllowed(access: RoleHomeAccess, navigationId: RoleHomeNavigationId) {
  return access.allowedNavigationIds.includes(navigationId)
}

export function buildRoleHomeModel(data: BootstrapResponse, employeeId: string): RoleHomeModel {
  const employee = data.employees.find((item) => item.id === employeeId && item.status === 'active')
  const baseAccess = getRoleHomeAccess(data, employee?.roleId ?? '')
  const activeShifts = data.shiftAssignments.filter((shift) => (
    shift.employeeId === employee?.id
    && shift.businessDate === data.store.businessDate
    && shift.status === 'active'
  ))
  const roleIds = [...new Set((activeShifts.length > 0
    ? [...activeShifts.flatMap((shift) => [shift.roleId, ...(shift.roleIds ?? [])]), ...(employee?.roleIds ?? [])]
    : [employee?.roleId, ...(employee?.roleIds ?? [])]
  ).filter((roleId): roleId is string => Boolean(roleId)))]
  const permissionIds = [...new Set([
    ...(employee?.permissionIds ?? []),
    ...data.config.roles.filter((role) => roleIds.includes(role.id)).flatMap((role) => role.permissionIds ?? []),
  ])]
  const configuredNavigation = navigationForPermissions(permissionIds)
  const access = {
    ...baseAccess,
    roleLabel: data.config.roles.filter((role) => roleIds.includes(role.id)).map((role) => role.name).join(' / ') || baseAccess.roleLabel,
    allowedNavigationIds: configuredNavigation.length > 0 ? configuredNavigation : baseAccess.allowedNavigationIds,
  }
  const hasFullKdsAccess = roleIds.some((roleId) => {
    const role = data.config.roles.find((item) => item.id === roleId)
    return ['owner', 'operations_director', 'admin', 'manager'].includes(resolveRoleHomeKind(roleId, role?.name))
  })
  const counts = buildCounts(data, employee, roleIds, hasFullKdsAccess)
  const { metrics, todos } = buildRoleContent(access.kind, counts)

  return {
    employee,
    access,
    metrics,
    todos,
    navigation: roleHomeNavigation
      .filter((item) => access.allowedNavigationIds.includes(item.id))
      .map((item) => ({ ...item, label: roleNavigationLabels[access.kind]?.[item.id] ?? item.label })),
  }
}

interface RoleCounts {
  occupiedTables: number
  openTasks: number
  ownTasks: number
  atRiskTasks: number
  escalatedTasks: number
  assignedTables: number
  awaitingOrders: number
  visibleKds: number
  productionKds: number
  overdueKds: number
  readyForPickup: number
  inDelivery: number
  onlineEmployees: number
  pendingApprovals: number
  paymentActions: number
  paymentReconciliation: number
  refundActions: number
  unsettledTables: number
  reservations: number
  requestedReservations: number
  arrivals: number
  configVersion: number
}

function buildCounts(
  data: BootstrapResponse,
  employee: Employee | undefined,
  roleIds: string[],
  hasFullKdsAccess: boolean,
): RoleCounts {
  const openTasks = data.tasks.filter((task) => openServiceStatuses.has(task.status))
  const ownTasks = openTasks.filter((task) => task.ownerId === employee?.id)
  const now = new Date(data.serverNow).getTime()
  const visibleKdsTasks = kdsTasksForRole(data, employee, roleIds, hasFullKdsAccess)
  const productionKds = visibleKdsTasks.filter((task) => ['queued', 'preparing'].includes(task.status))
  const visibleKdsIds = new Set(visibleKdsTasks.map((task) => task.id))
  const readyForPickup = data.orderDomain.kdsTasks.filter((task) => (
    task.status === 'completed'
    && kdsTaskOperationallyActive(task)
    && (
      hasFullKdsAccess
      || visibleKdsIds.has(task.id)
      || productionTaskMatchesEmployee(data, task, employee, roleIds)
    )
  ))
  const pendingAuthorizations = data.orderDomain.authorizations.filter((item) => item.status === 'pending').length
  const pendingStockCounts = data.inventoryDomain?.stockCounts.filter((item) => item.status === 'pending_confirmation').length ?? 0
  const refundActions = data.paymentDomain.refunds.filter((item) => ['requested', 'approved', 'processing', 'failed'].includes(item.status)).length
  const paymentActions = data.paymentDomain.paymentIntents.filter((item) => ['pending', 'processing', 'failed'].includes(item.status)).length
  const paymentReconciliation = data.paymentDomain.paymentIntents.filter((item) => item.status === 'reported_pending_reconciliation').length
  const reservations = data.reservationState?.reservations ?? []

  return {
    occupiedTables: data.metrics.occupiedTables,
    openTasks: openTasks.length,
    ownTasks: ownTasks.length,
    atRiskTasks: data.metrics.atRiskTasks,
    escalatedTasks: data.metrics.escalatedTasks,
    assignedTables: data.tables.filter((table) => table.primaryEmployeeId === employee?.id || table.backupEmployeeIds.includes(employee?.id ?? '')).length,
    awaitingOrders: data.awaitingOrderIntents.filter((intent) => intent.status === 'active' && data.tables.some((table) => table.id === intent.tableId && table.primaryEmployeeId === employee?.id)).length,
    visibleKds: visibleKdsTasks.length,
    productionKds: productionKds.length,
    overdueKds: productionKds.filter((task) => task.productionSla?.dueAt && new Date(task.productionSla.dueAt).getTime() <= now).length,
    readyForPickup: readyForPickup.length,
    inDelivery: visibleKdsTasks.filter((task) => task.status === 'picked_up').length,
    onlineEmployees: data.employees.filter((item) => item.status === 'active' && item.online && !item.paused).length,
    pendingApprovals: pendingAuthorizations + pendingStockCounts + data.paymentDomain.refunds.filter((item) => item.status === 'requested').length,
    paymentActions,
    paymentReconciliation,
    refundActions,
    unsettledTables: unsettledTableCount(data),
    reservations: reservations.filter((item) => !['cancelled', 'no_show', 'seated'].includes(item.status)).length,
    requestedReservations: reservations.filter((item) => item.status === 'requested').length,
    arrivals: reservations.filter((item) => ['confirmed', 'arrived'].includes(item.status)).length,
    configVersion: data.config.version,
  }
}

function kdsTasksForRole(
  data: BootstrapResponse,
  employee: Employee | undefined,
  roleIds: string[],
  hasFullKdsAccess: boolean,
) {
  const activeTasks = data.orderDomain.kdsTasks.filter((task) => (
    openKdsStatuses.has(task.status) && kdsTaskOperationallyActive(task)
  ))
  if (hasFullKdsAccess) return activeTasks
  if (!employee) return []

  const activeShiftStations = new Set(data.shiftAssignments
    .filter((shift) => shift.employeeId === employee.id && shift.businessDate === data.store.businessDate && shift.status === 'active')
    .flatMap((shift) => shift.stationIds ?? []))

  return activeTasks.filter((task) => {
    const workstation = task.workstation
    const stationAllowed = activeShiftStations.size === 0 || activeShiftStations.has(task.stationId)
    if (!stationAllowed) return false
    const matchesProductionRole = workstation?.productionRoleIds.some((roleId) => roleIds.includes(roleId)) ?? false
    const matchesDeliveryRole = workstation?.deliveryRoleIds.some((roleId) => roleIds.includes(roleId)) ?? false
    return (
      ['queued', 'preparing'].includes(task.status) && matchesProductionRole
    ) || (
      ['completed', 'picked_up'].includes(task.status)
      && matchesDeliveryRole
      && (!task.deliveryServiceTask?.ownerId || task.deliveryServiceTask.ownerId === employee.id)
    )
  })
}

function productionTaskMatchesEmployee(
  data: BootstrapResponse,
  task: BootstrapResponse['orderDomain']['kdsTasks'][number],
  employee: Employee | undefined,
  roleIds: string[],
) {
  if (!employee || !task.workstation?.productionRoleIds.some((roleId) => roleIds.includes(roleId))) return false
  const activeShifts = data.shiftAssignments.filter((shift) => (
    shift.employeeId === employee.id
    && shift.businessDate === data.store.businessDate
    && shift.status === 'active'
  ))
  return activeShifts.length === 0 || activeShifts.some((shift) => (shift.stationIds ?? []).includes(task.stationId))
}

function unsettledTableCount(data: BootstrapResponse) {
  const latestBalances = new Map<string, { sequence: number; balance: number }>()
  for (const entry of data.orderDomain.tableLedgerEntries) {
    const current = latestBalances.get(entry.tableSessionId)
    if (!current || current.sequence < entry.sequence) {
      latestBalances.set(entry.tableSessionId, { sequence: entry.sequence, balance: entry.balanceAfter })
    }
  }
  return [...latestBalances.values()].filter((entry) => entry.balance > 0).length
}

function buildRoleContent(kind: RoleHomeKind, counts: RoleCounts): Pick<RoleHomeModel, 'metrics' | 'todos'> {
  if (kind === 'owner') return managementContent(counts, '营业桌台', '待经营复核')
  if (kind === 'operations_director') return managementContent(counts, '营业桌台', '待运营接管')
  if (kind === 'admin') {
    return {
      metrics: [
        metric('online', '在线员工', counts.onlineEmployees, 'people', 'neutral', 'master'),
        metric('version', '当前配置', `V${counts.configVersion}`, 'config', 'info', 'config'),
        metric('exceptions', '升级任务', counts.escalatedTasks, 'risk', counts.escalatedTasks ? 'danger' : 'success', 'tasks'),
        metric('approvals', '待处理审批', counts.pendingApprovals, 'tasks', counts.pendingApprovals ? 'warning' : 'success', 'master'),
      ],
      todos: [
        todo('approvals', '处理待审批事项', '订单、退款与库存审批', counts.pendingApprovals, 'warning', 'master'),
        todo('escalated', '复核升级任务', '检查责任人和处理进度', counts.escalatedTasks, 'danger', 'tasks'),
        todo('payment-reconcile', '核对支付上报', '处理待对账支付记录', counts.paymentReconciliation, 'warning', 'payments'),
      ],
    }
  }
  if (kind === 'manager') return managementContent(counts, '营业桌台', '现场待接管')
  if (kind === 'server') {
    return {
      metrics: [
        metric('tables', '责任桌台', counts.assignedTables, 'tables', 'neutral', 'live'),
        metric('own-tasks', '我的任务', counts.ownTasks, 'tasks', counts.ownTasks ? 'info' : 'success', 'tasks'),
        metric('delivery', '待送出品', counts.visibleKds, 'kds', counts.visibleKds ? 'warning' : 'success', 'commerce'),
        metric('awaiting', '待点单桌台', counts.awaitingOrders, 'tables', counts.awaitingOrders ? 'warning' : 'success', 'live'),
      ],
      todos: [
        todo('service', '处理服务任务', '按优先级完成责任任务', counts.ownTasks, 'info', 'tasks'),
        todo('delivery', '取送已完成出品', '从 KDS 确认取货并送达', counts.visibleKds, 'warning', 'commerce'),
        todo('order-care', '跟进待点单桌台', '确认客人当前点单需求', counts.awaitingOrders, 'warning', 'live'),
      ],
    }
  }
  if (kind === 'bartender' || kind === 'kitchen') return productionContent(counts, kind === 'bartender' ? '吧台制作' : '厨房制作')
  if (kind === 'cashier') {
    return {
      metrics: [
        metric('payments', '待收款', counts.paymentActions, 'payments', counts.paymentActions ? 'warning' : 'success', 'payments'),
        metric('reconcile', '待对账', counts.paymentReconciliation, 'payments', counts.paymentReconciliation ? 'warning' : 'success', 'payments'),
        metric('refunds', '退款待办', counts.refundActions, 'risk', counts.refundActions ? 'danger' : 'success', 'payments'),
        metric('unsettled', '未结桌账', counts.unsettledTables, 'tables', counts.unsettledTables ? 'info' : 'success', 'payments'),
      ],
      todos: [
        todo('collect', '处理待收款桌账', '逐笔确认支付结果', counts.paymentActions, 'warning', 'payments'),
        todo('reconcile', '核对 POS 上报', '完成待对账支付记录', counts.paymentReconciliation, 'warning', 'payments'),
        todo('refund', '处理退款队列', '按状态继续退款流程', counts.refundActions, 'danger', 'payments'),
      ],
    }
  }
  if (kind === 'host') {
    return {
      metrics: [
        metric('reservations', '今日待到店', counts.reservations, 'reservations', 'neutral', 'reservations'),
        metric('requested', '待确认预约', counts.requestedReservations, 'reservations', counts.requestedReservations ? 'warning' : 'success', 'reservations'),
        metric('arrivals', '待迎宾入座', counts.arrivals, 'tables', counts.arrivals ? 'info' : 'success', 'reservations'),
        metric('tasks', '接待任务', counts.ownTasks, 'tasks', counts.ownTasks ? 'info' : 'success', 'tasks'),
      ],
      todos: [
        todo('confirm', '确认预约信息', '核对到店时间、人数和区域', counts.requestedReservations, 'warning', 'reservations'),
        todo('seat', '安排到店入座', '完成迎宾和桌台交接', counts.arrivals, 'info', 'reservations'),
        todo('host-tasks', '处理接待任务', '跟进当前分配事项', counts.ownTasks, 'info', 'tasks'),
      ],
    }
  }
  if (kind === 'runner') {
    return {
      metrics: [
        metric('pickup', '待取货', counts.readyForPickup, 'kds', counts.readyForPickup ? 'warning' : 'success', 'commerce'),
        metric('delivery', '配送中', counts.inDelivery, 'kds', counts.inDelivery ? 'info' : 'success', 'commerce'),
        metric('tasks', '我的任务', counts.ownTasks, 'tasks', counts.ownTasks ? 'info' : 'success', 'tasks'),
        metric('risk', 'SLA 风险', counts.atRiskTasks, 'risk', counts.atRiskTasks ? 'danger' : 'success', 'tasks'),
      ],
      todos: [
        todo('pickup', '领取已完成出品', '按桌台和出品站取货', counts.readyForPickup, 'warning', 'commerce'),
        todo('deliver', '完成配送确认', '送达后及时更新 KDS', counts.inDelivery, 'info', 'commerce'),
        todo('runner-tasks', '处理取送任务', '按责任队列继续执行', counts.ownTasks, 'info', 'tasks'),
      ],
    }
  }
  return {
    metrics: [
      metric('tasks', '我的任务', counts.ownTasks, 'tasks', counts.ownTasks ? 'info' : 'success', 'tasks'),
      metric('kds', 'KDS 任务', counts.visibleKds, 'kds', counts.visibleKds ? 'warning' : 'success', 'commerce'),
    ],
    todos: [
      todo('tasks', '处理已分配任务', '仅显示本人责任任务', counts.ownTasks, 'info', 'tasks'),
      todo('kds', '处理岗位 KDS', '仅显示岗位和工位匹配任务', counts.visibleKds, 'warning', 'commerce'),
    ],
  }
}

function managementContent(counts: RoleCounts, tableLabel: string, taskLabel: string): Pick<RoleHomeModel, 'metrics' | 'todos'> {
  return {
    metrics: [
      metric('tables', tableLabel, counts.occupiedTables, 'tables', 'neutral', 'live'),
      metric('tasks', '待处理任务', counts.openTasks, 'tasks', counts.openTasks ? 'info' : 'success', 'tasks'),
      metric('risk', 'SLA 风险', counts.atRiskTasks, 'risk', counts.atRiskTasks ? 'danger' : 'success', 'tasks'),
      metric('kds', 'KDS 待办', counts.visibleKds, 'kds', counts.visibleKds ? 'warning' : 'success', 'commerce'),
    ],
    todos: [
      todo('risk', '接管 SLA 风险', '优先处理即将或已经超时任务', counts.atRiskTasks, 'danger', 'tasks'),
      todo('escalated', taskLabel, '检查升级任务和责任分配', counts.escalatedTasks, 'warning', 'tasks'),
      todo('approvals', '处理运营审批', '复核订单、退款与库存事项', counts.pendingApprovals, 'warning', 'payments'),
    ],
  }
}

function productionContent(counts: RoleCounts, label: string): Pick<RoleHomeModel, 'metrics' | 'todos'> {
  return {
    metrics: [
      metric('production', label, counts.productionKds, 'kds', counts.productionKds ? 'info' : 'success', 'commerce'),
      metric('overdue', '制作超时', counts.overdueKds, 'risk', counts.overdueKds ? 'danger' : 'success', 'commerce'),
      metric('pickup', '待取走', counts.readyForPickup, 'kds', counts.readyForPickup ? 'warning' : 'success', 'commerce'),
      metric('tasks', '我的任务', counts.ownTasks, 'tasks', counts.ownTasks ? 'info' : 'success', 'tasks'),
    ],
    todos: [
      todo('overdue', '优先处理超时出品', '按制作 SLA 排序处理', counts.overdueKds, 'danger', 'commerce'),
      todo('production', '继续制作队列', '及时更新开始和完成状态', counts.productionKds, 'info', 'commerce'),
      todo('handoff', '确认待取走出品', '核对桌台并完成交接', counts.readyForPickup, 'warning', 'commerce'),
    ],
  }
}

function metric(id: string, label: string, value: number | string, indicator: RoleHomeIndicator, tone: RoleHomeTone, navigationId: RoleHomeNavigationId): RoleHomeMetric {
  return { id, label, value, indicator, tone, navigationId }
}

function todo(id: string, label: string, detail: string, count: number, tone: RoleHomeTone, navigationId: RoleHomeNavigationId): RoleHomeTodo {
  return { id, label, detail, count, tone: count > 0 ? tone : 'success', navigationId }
}

function normalizeRoleToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}
