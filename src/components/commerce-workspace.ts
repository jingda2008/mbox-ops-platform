import type { BootstrapResponse, Employee, RoleConfig } from '../shared/contracts'
import type { KdsExceptionEvent, KdsTask, KdsTaskStatus } from '../shared/order-contracts'

export type FulfillmentMode = 'production' | 'delivery' | 'oversight'

export interface FulfillmentAccess {
  employee: Employee | undefined
  role: RoleConfig | undefined
  mode: FulfillmentMode
  canPrepare: boolean
  canDeliver: boolean
  canOrder: boolean
  canViewLedger: boolean
  stationIds: string[]
  stationScoped: boolean
  roleLabel: string
  scopeLabel: string
}

const productionStatuses = new Set<KdsTaskStatus>(['queued', 'preparing'])
const deliveryStatuses = new Set<KdsTaskStatus>(['completed', 'picked_up'])
const managerTerms = ['manager', 'supervisor', '经理', '主管', '领班']
const productionTerms = ['specialist', 'bartender', 'bar', 'maker', 'production', 'kitchen', 'cook', '调酒', '出品', '吧台', '厨']
const deliveryTerms = ['server', 'waiter', 'runner', 'backup', 'service', '服务员', '传菜', '候补', '取送']

export function getFulfillmentAccess(data: BootstrapResponse, actorId: string): FulfillmentAccess {
  const employee = data.employees.find((item) => item.id === actorId && item.status === 'active')
  const role = employee ? data.config.roles.find((item) => item.id === employee.roleId) : undefined
  const roleIds = effectiveEmployeeRoleIds(data, employee)
  const roles = data.config.roles.filter((item) => roleIds.includes(item.id))
  const roleKey = roles.flatMap((item) => [item.id, item.name]).join(' ').toLowerCase()
  const configuredPermissions = [...new Set([
    ...(employee?.permissionIds ?? []),
    ...roles.flatMap((item) => item.permissionIds ?? []),
  ])]
  const configuredCanPrepare = configuredPermissions?.includes('kds.prepare') ?? false
  const configuredCanDeliver = configuredPermissions?.includes('kds.deliver') ?? false
  const configuredOversight = Boolean(
    configuredPermissions?.includes('dashboard.view')
    && roles.some((item) => ['store', 'all_stores'].includes(item.dataScope ?? '')),
  )
  const capabilities = readStringArray(employee, ['capabilities', 'commerceCapabilities', 'kdsCapabilities'])
    .concat(readStringArray(role, ['capabilities', 'commerceCapabilities', 'kdsCapabilities']))
    .map((item) => item.toLowerCase())
  const explicitMode = readMode(employee) ?? readMode(role)
  const configuredWorkstations = readRecordArray((data.config as unknown as Record<string, unknown>).workstations)
  const configuredForProduction = configuredWorkstations.some((item) => item.enabled !== false && readStringArray(item, ['productionRoleIds']).some((id) => roleIds.includes(id)))
  const configuredForDelivery = configuredWorkstations.some((item) => item.enabled !== false && readStringArray(item, ['deliveryRoleIds']).some((id) => roleIds.includes(id)))
  const mode = explicitMode
    ?? (configuredOversight ? 'oversight'
      : configuredPermissions && configuredCanPrepare && !configuredCanDeliver ? 'production'
        : configuredPermissions && configuredCanDeliver && !configuredCanPrepare ? 'delivery'
      : matchesAny(roleKey, managerTerms) ? 'oversight'
      : configuredForProduction && !configuredForDelivery ? 'production'
        : configuredForDelivery && !configuredForProduction ? 'delivery'
          : matchesAny(roleKey, productionTerms) ? 'production'
            : matchesAny(roleKey, deliveryTerms) ? 'delivery'
          : 'delivery')
  const canPrepare = configuredPermissions
    ? configuredCanPrepare
    : mode === 'oversight' || mode === 'production' || capabilities.some((item) => ['prepare', 'production', 'kds.prepare'].includes(item))
  const canDeliver = configuredPermissions
    ? configuredCanDeliver
    : mode === 'oversight' || mode === 'delivery' || capabilities.some((item) => ['deliver', 'delivery', 'kds.deliver'].includes(item))
  const stationScoped = mode !== 'oversight' && configuredWorkstations.length > 0
  const stationIds = assignedStationIds(data, employee, role, mode, stationScoped)

  return {
    employee,
    role,
    mode,
    canPrepare,
    canDeliver,
    canOrder: configuredPermissions?.includes('order.create') ?? mode !== 'production',
    canViewLedger: configuredPermissions?.includes('order.view') ?? mode !== 'production',
    stationIds,
    stationScoped,
    roleLabel: roles.map((item) => item.name).join(' / ') || employee?.roleId || '身份未识别',
    scopeLabel: mode === 'oversight'
      ? '全流程监管'
      : mode === 'production'
        ? stationIds.length > 0 ? `制作任务 · ${stationIds.map(stationLabel).join('、')}` : stationScoped ? '未分配制作工位' : '全部制作工位'
        : stationIds.length > 0 ? `待取送 · ${stationIds.map(stationLabel).join('、')}` : stationScoped ? '未分配取送工位' : '待取送任务',
  }
}

export function taskVisibleToAccess(task: KdsTask, access: FulfillmentAccess) {
  const employeeRoleIds = [access.employee?.roleId, ...(access.employee?.roleIds ?? [])].filter(Boolean)
  if (task.status === 'delivered') return false
  if (access.mode === 'production') {
    const configuredRoles = readStringArray(task.workstation, ['productionRoleIds'])
    return productionStatuses.has(task.status)
      && (configuredRoles.length === 0 || configuredRoles.some((roleId) => employeeRoleIds.includes(roleId)))
      && (access.stationScoped ? access.stationIds.includes(task.stationId) : access.stationIds.length === 0 || access.stationIds.includes(task.stationId))
  }
  if (access.mode === 'delivery') {
    const configuredRoles = readStringArray(task.workstation, ['deliveryRoleIds'])
    const assignedOwnerId = task.deliveryServiceTask?.ownerId
    return deliveryStatuses.has(task.status)
      && (configuredRoles.length === 0 || configuredRoles.some((roleId) => employeeRoleIds.includes(roleId)))
      && (!assignedOwnerId || assignedOwnerId === access.employee?.id)
      && (access.stationScoped ? access.stationIds.includes(task.stationId) : access.stationIds.length === 0 || access.stationIds.includes(task.stationId))
  }
  return true
}

export function actionAllowedForAccess(status: KdsTaskStatus, access: FulfillmentAccess) {
  return productionStatuses.has(status) ? access.canPrepare : deliveryStatuses.has(status) ? access.canDeliver : false
}

export function openKdsException(task: KdsTask): KdsExceptionEvent | undefined {
  const events = task.exceptionEvents ?? []
  return events.find((event) => (
    event.type === 'reported'
    && !events.some((candidate) => (
      candidate.type === 'manager_disposition' && candidate.exceptionId === event.exceptionId
    ))
  ))
}

export function kdsTaskClosedByException(task: KdsTask) {
  return (task.exceptionEvents ?? []).some((event) => event.type === 'manager_disposition')
}

export function kdsTaskOperationallyActive(task: KdsTask) {
  if (openKdsException(task)) return true
  if (kdsTaskClosedByException(task)) return false
  return task.status !== 'delivered'
}

export function canResolveKdsException(access: FulfillmentAccess) {
  const roleIds = [access.employee?.roleId, ...(access.employee?.roleIds ?? [])]
    .filter((roleId): roleId is string => typeof roleId === 'string')
  return access.mode === 'oversight' && roleIds.some((roleId) => ['supervisor', 'manager'].includes(roleId))
}

export function stationLabel(stationId: string) {
  const labels: Record<string, string> = {
    'bar-main': '主吧台',
    'kitchen-cold': '冷菜间',
    'kitchen-hot': '热厨',
  }
  return labels[stationId] ?? stationId
}

function assignedStationIds(data: BootstrapResponse, employee: Employee | undefined, role: RoleConfig | undefined, mode: FulfillmentMode, stationScoped: boolean) {
  const explicitlyAssignedIds = new Set<string>([
    ...readStationIds(employee),
    ...readStationIds(role),
  ])
  const activeShifts = data.shiftAssignments.filter((shift) => (
    shift.employeeId === employee?.id
    && shift.businessDate === data.store.businessDate
    && shift.status === 'active'
  ))
  const activeShiftStationIds = new Set(activeShifts.flatMap((shift) => readStationIds(shift)))
  const configuredIds = new Set<string>()
  const root = data as unknown as Record<string, unknown>
  const config = data.config as unknown as Record<string, unknown>
  const assignmentLists = [root.workstations, root.stationAssignments, config.workstations, config.fulfillmentWorkstations]
  for (const list of assignmentLists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!isRecord(item) || item.enabled === false) continue
      const explicitlyAssigned = assignmentMatches(item, employee, role)
      const roleIds = readStringArray(item, [mode === 'production' ? 'productionRoleIds' : 'deliveryRoleIds'])
      const employeeRoleIds = employee ? [employee.roleId, ...(employee.roleIds ?? [])] : []
      const roleAssigned = mode !== 'oversight' && roleIds.some((roleId) => employeeRoleIds.includes(roleId))
      const requiredSkills = readStringArray(item, ['requiredSkillIds'])
      const employeeSkills = readStringArray(employee, ['skillIds'])
      const hasSkills = mode !== 'production' || requiredSkills.every((skillId) => employeeSkills.includes(skillId))
      if (!explicitlyAssigned && !(roleAssigned && hasSkills)) continue
      const stationIds = readStationIds(item)
      if (stationIds.length > 0) stationIds.forEach((id) => configuredIds.add(id))
      else if (typeof item.id === 'string' && item.id.trim()) configuredIds.add(item.id.trim())
    }
  }
  const eligibleIds = configuredIds.size > 0 ? configuredIds : explicitlyAssignedIds
  if (activeShiftStationIds.size === 0) return stationScoped ? [] : [...eligibleIds]
  if (eligibleIds.size === 0) return [...activeShiftStationIds]
  return [...activeShiftStationIds].filter((id) => eligibleIds.has(id))
}

function effectiveEmployeeRoleIds(data: BootstrapResponse, employee: Employee | undefined) {
  if (!employee) return []
  const activeShifts = data.shiftAssignments.filter((shift) => (
    shift.employeeId === employee.id
    && shift.businessDate === data.store.businessDate
    && shift.status === 'active'
  ))
  if (activeShifts.length > 0) return [...new Set([
    ...activeShifts.flatMap((shift) => [shift.roleId, ...(shift.roleIds ?? [])]),
    ...(employee.roleIds ?? []),
  ])]
  return [...new Set([employee.roleId, ...(employee.roleIds ?? [])])]
}

function assignmentMatches(record: Record<string, unknown>, employee: Employee | undefined, role: RoleConfig | undefined) {
  const employeeIds = readStringArray(record, ['employeeIds', 'actorIds'])
  const roleIds = readStringArray(record, ['roleIds'])
  const employeeId = readString(record, ['employeeId', 'actorId'])
  const roleId = readString(record, ['roleId'])
  if (employeeId || employeeIds.length > 0) return Boolean(employee && (employeeId === employee.id || employeeIds.includes(employee.id)))
  if (roleId || roleIds.length > 0) return Boolean(role && (roleId === role.id || roleIds.includes(role.id)))
  return false
}

function readStationIds(value: unknown) {
  const ids = readStringArray(value, ['stationIds', 'workstationIds', 'productionStationIds'])
  const single = readString(value, ['stationId', 'workstationId', 'productionStationId'])
  return single ? [...ids, single] : ids
}

function readMode(value: unknown): FulfillmentMode | null {
  const raw = readString(value, ['fulfillmentMode', 'kdsMode', 'workMode'])?.toLowerCase()
  if (!raw) return null
  if (['all', 'oversight', 'manager', 'supervisor'].includes(raw)) return 'oversight'
  if (['production', 'prepare', 'maker', 'bartender'].includes(raw)) return 'production'
  if (['delivery', 'deliver', 'runner', 'service'].includes(raw)) return 'delivery'
  return null
}

function readString(value: unknown, keys: string[]) {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return undefined
}

function readStringArray(value: unknown, keys: string[]) {
  if (!isRecord(value)) return []
  for (const key of keys) {
    const item = value[key]
    if (Array.isArray(item)) return item.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  }
  return []
}

function readRecordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function matchesAny(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
