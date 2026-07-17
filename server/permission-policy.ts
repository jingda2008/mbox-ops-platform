import type {
  RoleApprovalLimits,
  RoleConfig,
  RoleDataScope,
  RuntimeState,
  StaffPermissionId,
  StoreConfig,
} from '../src/shared/contracts.js'
import { defaultRolePolicies, withDefaultRolePolicy } from '../src/shared/role-policy.js'

export type StaffOperation =
  | 'config.write'
  | 'master-data.write'
  | 'identity.write'
  | 'shift.write'
  | 'table.open'
  | 'table.write'
  | 'table.close'
  | 'business-day.close'
  | 'commerce-authority.write'
  | 'commerce.order.create'
  | 'commerce.kds.prepare'
  | 'commerce.kds.deliver'
  | 'commerce.authorization.request'
  | 'payment.intent.create'
  | 'payment.pos.report'
  | 'payment.refund.request'
  | 'payment.refund.approve'
  | 'notification.retry'
  | 'reservation.view'
  | 'reservation.manage'
  | 'reservation.config.write'
  | 'reservation.deposit.confirm'
  | 'reservation.deposit.refund.request'
  | 'reservation.deposit.refund.approve'
  | 'inventory.manage'
  | 'inventory.view'
  | 'inventory.approve'
  | 'benefit.grant'
  | 'benefit.approve'
  | 'benefit.manage'
  | 'song.request'
  | 'song.manage'
  | 'store-import.apply'
  | 'service.task.create'
  | 'service.task.action'

export type StaffRoleId =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'supervisor'
  | 'server'
  | 'bartender'
  | 'kitchen'
  | 'cashier'
  | 'host'
  | 'runner'
  | 'backup'
  | 'specialist'

export type LegacyDataScope = 'assigned' | 'area' | 'organization'
export type DataScope = RoleDataScope | LegacyDataScope
export type OperationRisk = 'standard' | 'high'
export type ApprovalLimitType =
  | 'gift'
  | 'discount'
  | 'refundRequest'
  | 'refundApprove'
  | 'inventoryAdjustment'

export interface RolePermissionPolicy {
  readonly name: string
  readonly permissionIds: readonly StaffPermissionId[]
  readonly operations: readonly StaffOperation[]
  readonly dataScope: DataScope
  readonly approvalLimits: Readonly<RoleApprovalLimits>
  readonly canApproveHighRisk: boolean
}

export interface OperationPermissionPolicy {
  readonly name: string
  readonly permissionId: StaffPermissionId
  readonly risk: OperationRisk
}

export interface PermissionPolicy {
  readonly roles: Readonly<Record<string, RolePermissionPolicy>>
  readonly operations: Readonly<Record<StaffOperation, OperationPermissionPolicy>>
}

type RolePermissionPolicyOverride = Omit<Partial<RolePermissionPolicy>, 'approvalLimits'> & {
  readonly approvalLimits?: Partial<RoleApprovalLimits>
}

export interface PermissionPolicyOverrides {
  readonly roles?: Readonly<Record<string, RolePermissionPolicyOverride>>
  readonly operations?: Partial<Record<StaffOperation, Partial<OperationPermissionPolicy>>>
}

export const STAFF_OPERATION_PERMISSION_IDS: Record<StaffOperation, StaffPermissionId> = {
  'config.write': 'config.manage',
  'master-data.write': 'master_data.manage',
  'identity.write': 'identity.manage',
  'shift.write': 'shift.manage',
  'table.open': 'table.open',
  'table.write': 'table.manage',
  'table.close': 'table.close',
  'business-day.close': 'business_day.close',
  'commerce-authority.write': 'commerce.authorization.approve',
  'commerce.order.create': 'order.create',
  'commerce.kds.prepare': 'kds.prepare',
  'commerce.kds.deliver': 'kds.deliver',
  'commerce.authorization.request': 'commerce.authorization.request',
  'payment.intent.create': 'payment.collect',
  'payment.pos.report': 'payment.pos_report',
  'payment.refund.request': 'payment.refund.request',
  'payment.refund.approve': 'payment.refund.approve',
  'notification.retry': 'complaint.handle',
  'reservation.view': 'reservation.view',
  'reservation.manage': 'reservation.manage',
  'reservation.config.write': 'reservation.config.manage',
  'reservation.deposit.confirm': 'payment.collect',
  'reservation.deposit.refund.request': 'payment.refund.request',
  'reservation.deposit.refund.approve': 'payment.refund.approve',
  'inventory.manage': 'inventory.manage',
  'inventory.view': 'inventory.view',
  'inventory.approve': 'inventory.approve',
  'benefit.grant': 'benefit.grant',
  'benefit.approve': 'benefit.approve',
  'benefit.manage': 'benefit.manage',
  'song.request': 'song.view',
  'song.manage': 'song.manage',
  'store-import.apply': 'store_import.apply',
  'service.task.create': 'service.execute',
  'service.task.action': 'service.execute',
}

export const ALL_STAFF_OPERATIONS = Object.keys(STAFF_OPERATION_PERMISSION_IDS) as StaffOperation[]

const defaultOperations: Record<StaffOperation, OperationPermissionPolicy> = {
  'config.write': { name: '修改门店配置', permissionId: 'config.manage', risk: 'high' },
  'master-data.write': { name: '修改门店主数据', permissionId: 'master_data.manage', risk: 'high' },
  'identity.write': { name: '管理员工身份', permissionId: 'identity.manage', risk: 'high' },
  'shift.write': { name: '管理班次', permissionId: 'shift.manage', risk: 'high' },
  'table.open': { name: '开台接客', permissionId: 'table.open', risk: 'standard' },
  'table.write': { name: '管理桌台', permissionId: 'table.manage', risk: 'high' },
  'table.close': { name: '结台清台', permissionId: 'table.close', risk: 'high' },
  'business-day.close': { name: '关闭营业日', permissionId: 'business_day.close', risk: 'high' },
  'commerce-authority.write': { name: '修改经营授权', permissionId: 'commerce.authorization.approve', risk: 'high' },
  'commerce.order.create': { name: '创建订单', permissionId: 'order.create', risk: 'standard' },
  'commerce.kds.prepare': { name: '执行出品操作', permissionId: 'kds.prepare', risk: 'standard' },
  'commerce.kds.deliver': { name: '执行取送操作', permissionId: 'kds.deliver', risk: 'standard' },
  'commerce.authorization.request': {
    name: '申请经营授权', permissionId: 'commerce.authorization.request', risk: 'standard',
  },
  'payment.intent.create': { name: '创建收款单', permissionId: 'payment.collect', risk: 'standard' },
  'payment.pos.report': { name: '报送物理POS收款', permissionId: 'payment.pos_report', risk: 'high' },
  'payment.refund.request': { name: '申请退款', permissionId: 'payment.refund.request', risk: 'standard' },
  'payment.refund.approve': { name: '审批并确认退款', permissionId: 'payment.refund.approve', risk: 'high' },
  'notification.retry': { name: '人工重试客户通知', permissionId: 'complaint.handle', risk: 'high' },
  'reservation.view': { name: '查看预约', permissionId: 'reservation.view', risk: 'standard' },
  'reservation.manage': { name: '管理预约', permissionId: 'reservation.manage', risk: 'standard' },
  'reservation.config.write': { name: '修改预约规则', permissionId: 'reservation.config.manage', risk: 'high' },
  'reservation.deposit.confirm': { name: '确认预约订金', permissionId: 'payment.collect', risk: 'high' },
  'reservation.deposit.refund.request': {
    name: '申请退还预约订金', permissionId: 'payment.refund.request', risk: 'standard',
  },
  'reservation.deposit.refund.approve': {
    name: '审批退还预约订金', permissionId: 'payment.refund.approve', risk: 'high',
  },
  'inventory.manage': { name: '管理库存', permissionId: 'inventory.manage', risk: 'standard' },
  'inventory.view': { name: '查看库存', permissionId: 'inventory.view', risk: 'standard' },
  'inventory.approve': { name: '审批库存调整', permissionId: 'inventory.approve', risk: 'high' },
  'benefit.grant': { name: '发放权益', permissionId: 'benefit.grant', risk: 'standard' },
  'benefit.approve': { name: '审批权益', permissionId: 'benefit.approve', risk: 'high' },
  'benefit.manage': { name: '管理权益规则', permissionId: 'benefit.manage', risk: 'high' },
  'song.request': { name: '提交点歌', permissionId: 'song.view', risk: 'standard' },
  'song.manage': { name: '管理点歌', permissionId: 'song.manage', risk: 'standard' },
  'store-import.apply': { name: '应用整店导入', permissionId: 'store_import.apply', risk: 'high' },
  'service.task.create': { name: '创建服务任务', permissionId: 'service.execute', risk: 'standard' },
  'service.task.action': { name: '处理服务任务', permissionId: 'service.execute', risk: 'standard' },
}

const roleNames: Record<string, string> = {
  owner: '所有者',
  admin: '系统管理员',
  manager: '值班经理',
  supervisor: '领班',
  server: '服务员',
  bartender: '调酒师',
  kitchen: '厨房',
  cashier: '收银员',
  host: '迎宾',
  runner: '传菜取送',
  backup: '区域候补',
  specialist: '服务专员',
}

const zeroApprovalLimits: RoleApprovalLimits = {
  giftAmount: 0,
  discountAmount: 0,
  refundRequestAmount: 0,
  refundApproveAmount: 0,
  inventoryAdjustmentAmount: 0,
}

export const APPROVAL_LIMIT_FIELDS: Record<ApprovalLimitType, keyof RoleApprovalLimits> = {
  gift: 'giftAmount',
  discount: 'discountAmount',
  refundRequest: 'refundRequestAmount',
  refundApprove: 'refundApproveAmount',
  inventoryAdjustment: 'inventoryAdjustmentAmount',
}

function hasApprovalAuthority(limits: Readonly<RoleApprovalLimits>) {
  return limits.giftAmount > 0 ||
    limits.discountAmount > 0 ||
    limits.refundApproveAmount > 0 ||
    limits.inventoryAdjustmentAmount > 0
}

function operationsForPermissions(permissionIds: readonly StaffPermissionId[]) {
  return ALL_STAFF_OPERATIONS.filter((operation) => permissionIds.includes(STAFF_OPERATION_PERMISSION_IDS[operation]))
}

function rolePolicy(
  name: string,
  permissionIds: readonly StaffPermissionId[] = [],
  dataScope: DataScope = 'own',
  approvalLimits: Readonly<RoleApprovalLimits> = zeroApprovalLimits,
): RolePermissionPolicy {
  const copiedLimits = { ...zeroApprovalLimits, ...approvalLimits }
  return {
    name,
    permissionIds: [...permissionIds],
    operations: operationsForPermissions(permissionIds),
    dataScope,
    approvalLimits: copiedLimits,
    canApproveHighRisk: hasApprovalAuthority(copiedLimits),
  }
}

const defaultRoles = Object.fromEntries(
  Object.entries(defaultRolePolicies).map(([roleId, configured]) => [
    roleId,
    rolePolicy(
      roleNames[roleId] ?? roleId,
      configured.permissionIds ?? [],
      configured.dataScope ?? 'own',
      configured.approvalLimits ?? zeroApprovalLimits,
    ),
  ]),
) as Record<string, RolePermissionPolicy>

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  roles: defaultRoles,
  operations: defaultOperations,
}

export function createPermissionPolicy(
  overrides: PermissionPolicyOverrides = {},
  base: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
): PermissionPolicy {
  const roles: Record<string, RolePermissionPolicy> = {}
  const roleIds = new Set([...Object.keys(base.roles), ...Object.keys(overrides.roles ?? {})])
  for (const roleId of roleIds) {
    const existing = base.roles[roleId]
    const override = overrides.roles?.[roleId]
    const permissionIds = override?.permissionIds ?? existing?.permissionIds ?? []
    const approvalLimits = {
      ...zeroApprovalLimits,
      ...existing?.approvalLimits,
      ...override?.approvalLimits,
    }
    roles[roleId] = {
      name: override?.name ?? existing?.name ?? roleId,
      permissionIds: [...permissionIds],
      operations: [
        ...(override?.operations ?? (override?.permissionIds ? operationsForPermissions(permissionIds) : existing?.operations) ?? []),
      ],
      dataScope: override?.dataScope ?? existing?.dataScope ?? 'own',
      approvalLimits,
      canApproveHighRisk: override?.canApproveHighRisk ?? hasApprovalAuthority(approvalLimits),
    }
  }

  const operations = { ...base.operations }
  for (const operation of ALL_STAFF_OPERATIONS) {
    const override = overrides.operations?.[operation]
    if (!override) continue
    operations[operation] = {
      name: override.name ?? operations[operation].name,
      permissionId: override.permissionId ?? operations[operation].permissionId,
      risk: override.risk ?? operations[operation].risk,
    }
  }
  return { roles, operations }
}

function configuredRolePolicy(role: RoleConfig) {
  const configured = withDefaultRolePolicy(role)
  return rolePolicy(
    configured.name,
    configured.permissionIds ?? [],
    configured.dataScope ?? 'own',
    configured.approvalLimits ?? zeroApprovalLimits,
  )
}

export function createPermissionPolicyFromStoreConfig(config: Pick<StoreConfig, 'roles'>): PermissionPolicy {
  return {
    roles: Object.fromEntries(config.roles.map((role) => [role.id, configuredRolePolicy(role)])),
    operations: defaultOperations,
  }
}

export function createPermissionPolicyFromRuntimeState(state: Pick<RuntimeState, 'config'>): PermissionPolicy {
  return createPermissionPolicyFromStoreConfig(state.config)
}

export const permissionPolicyFromStoreConfig = createPermissionPolicyFromStoreConfig
export const permissionPolicyFromRuntimeState = createPermissionPolicyFromRuntimeState

export function getOperationPolicy(operation: StaffOperation, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY) {
  return policy.operations[operation]
}

export function getRolePolicy(roleId: string, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY) {
  return policy.roles[roleId]
}

export function getAllowedRoleIds(operation: StaffOperation, policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY) {
  return Object.entries(policy.roles)
    .filter(([, role]) => role.operations.includes(operation))
    .map(([roleId]) => roleId)
}

export function canRolePerformOperation(
  roleId: string,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return policy.roles[roleId]?.operations.includes(operation) ?? false
}

const dataScopeRank: Record<DataScope, number> = {
  own: 0,
  assigned: 1,
  assigned_areas: 1,
  area: 1,
  store: 2,
  organization: 3,
  all_stores: 3,
}

export function canRoleAccessDataScope(
  roleId: string,
  requiredScope: DataScope,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  const grantedScope = policy.roles[roleId]?.dataScope
  return grantedScope != null && dataScopeRank[grantedScope] >= dataScopeRank[requiredScope]
}

export function getRoleApprovalLimit(
  roleId: string,
  limitType: ApprovalLimitType,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return policy.roles[roleId]?.approvalLimits[APPROVAL_LIMIT_FIELDS[limitType]] ?? 0
}

export function canRoleApproveAmount(
  roleId: string,
  limitType: ApprovalLimitType,
  amount: number,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= getRoleApprovalLimit(roleId, limitType, policy)
}

export function isPolicyHighRiskOperation(
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return policy.operations[operation].risk === 'high'
}

export function canRoleApproveHighRiskOperation(
  roleId: string,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  const role = policy.roles[roleId]
  return Boolean(
    role?.canApproveHighRisk &&
    role.operations.includes(operation) &&
    isPolicyHighRiskOperation(operation, policy),
  )
}
