import type { FastifyRequest } from 'fastify'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import { requireGiftPolicy } from './gift-policy.js'
import { requireRequestActor } from './auth-context.js'
import {
  canRoleAccessDataScope,
  canRoleApproveAmount,
  canRoleApproveHighRiskOperation,
  canRolePerformOperation,
  createPermissionPolicyFromRuntimeState,
  DEFAULT_PERMISSION_POLICY,
  getAllowedRoleIds,
  getOperationPolicy,
  getRoleApprovalLimit,
  getRolePolicy,
  isPolicyHighRiskOperation,
  STAFF_OPERATION_PERMISSION_IDS,
  type ApprovalLimitType,
  type DataScope,
  type PermissionPolicy,
  type StaffOperation,
} from './permission-policy.js'
import {
  effectiveDataScopeForEmployee,
  effectivePermissionIdsForEmployee,
  effectiveRoleIdsForEmployee,
} from '../src/shared/staff-access.js'

export type {
  ApprovalLimitType,
  DataScope,
  LegacyDataScope,
  OperationRisk,
  PermissionPolicy,
  PermissionPolicyOverrides,
  RolePermissionPolicy,
  StaffOperation,
  StaffRoleId,
} from './permission-policy.js'
export { createPermissionPolicy, DEFAULT_PERMISSION_POLICY } from './permission-policy.js'
export {
  APPROVAL_LIMIT_FIELDS,
  createPermissionPolicyFromRuntimeState,
  createPermissionPolicyFromStoreConfig,
  permissionPolicyFromRuntimeState,
  permissionPolicyFromStoreConfig,
  STAFF_OPERATION_PERMISSION_IDS,
} from './permission-policy.js'

export type AuthorizationFailureReason =
  | 'role_not_allowed'
  | 'role_not_configured'
  | 'scope_not_allowed'
  | 'approval_limit_exceeded'
  | 'high_risk_approval_required'

export interface AuthorizationErrorDetails {
  readonly reason: AuthorizationFailureReason
  readonly roleId?: string
  readonly allowedRoleIds?: readonly string[]
  readonly grantedScope?: DataScope
  readonly requiredScope?: DataScope
  readonly approvalLimitType?: ApprovalLimitType
  readonly requestedAmount?: number
  readonly approvalLimit?: number
  readonly tableId?: string
  readonly areaId?: string
}

export class AuthorizationError extends Error {
  readonly statusCode = 403
  readonly code = 'AUTHORIZATION_DENIED'

  constructor(
    message: string,
    public readonly operation: string,
    public readonly details?: AuthorizationErrorDetails,
  ) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export function canPerformOperation(
  roleId: string,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return canRolePerformOperation(roleId, operation, policy)
}

function requireRoleOperation(
  actor: RequestActorContext,
  roleId: string,
  operation: StaffOperation,
  policy: PermissionPolicy,
) {
  const operationPolicy = getOperationPolicy(operation, policy)
  if (!getRolePolicy(roleId, policy)) {
    throw new AuthorizationError(`岗位 ${roleId} 未配置权限策略，无法${operationPolicy.name}`, operation, {
      reason: 'role_not_configured',
      roleId,
    })
  }
  if (!canPerformOperation(roleId, operation, policy)) {
    const allowedRoleIds = getAllowedRoleIds(operation, policy)
    const allowedRoles = allowedRoleIds.length > 0 ? allowedRoleIds.join('、') : '无'
    throw new AuthorizationError(`岗位 ${roleId} 无权${operationPolicy.name}；允许岗位：${allowedRoles}`, operation, {
      reason: 'role_not_allowed',
      roleId,
      allowedRoleIds,
    })
  }
  return actor.roleId === roleId ? actor : { ...actor, roleId }
}

export function effectiveActorForState(actor: RequestActorContext, state: RuntimeState) {
  const employee = state.employees.find((item) => item.id === actor.actorId && item.status === 'active')
  const activeShift = state.shiftAssignments.find((shift) => (
    shift.employeeId === actor.actorId &&
    shift.businessDate === state.store.businessDate &&
    shift.status === 'active'
  ))
  const roleId = activeShift?.roleId ?? employee?.roleId ?? actor.roleId
  return actor.roleId === roleId ? actor : { ...actor, roleId }
}

function effectiveRequestActor(request: FastifyRequest, state: RuntimeState) {
  return effectiveActorForState(requireRequestActor(request), state)
}

export function assignedAreaIdsForActor(state: RuntimeState, actorId: string) {
  const activeShifts = state.shiftAssignments.filter((shift) => (
    shift.employeeId === actorId
    && shift.businessDate === state.store.businessDate
    && shift.status === 'active'
  ))
  if (activeShifts.length > 0) {
    return [...new Set(activeShifts.flatMap((shift) => shift.areaIds))]
  }
  const employee = state.employees.find((item) => item.id === actorId && item.status === 'active')
  return [...(employee?.areaIds ?? [])]
}

export function canActorAccessTableDataScope(
  state: RuntimeState,
  actor: RequestActorContext,
  tableId: string,
) {
  const effectiveActor = effectiveActorForState(actor, state)
  const scope = effectiveDataScopeForEmployee(state, effectiveActor.actorId)
  const table = state.tables.find((item) => item.id === tableId)
  if (!scope || !table) return false

  if (scope === 'all_stores') return true
  if (effectiveActor.storeId !== state.store.id) return false
  if (scope === 'store') return true
  if (scope === 'assigned_areas') {
    return assignedAreaIdsForActor(state, effectiveActor.actorId).includes(table.areaId)
  }
  return table.primaryEmployeeId === effectiveActor.actorId
    || table.backupEmployeeIds.includes(effectiveActor.actorId)
}

export function requireTableDataScope(
  request: FastifyRequest,
  state: RuntimeState,
  tableId: string,
  operation = 'table.access',
) {
  const actor = effectiveRequestActor(request, state)
  const roleIds = effectiveRoleIdsForEmployee(state, actor.actorId)
  if (roleIds.length === 0) {
    throw new AuthorizationError(`岗位 ${actor.roleId} 未配置桌台数据范围`, operation, {
      reason: 'role_not_configured',
      roleId: actor.roleId,
      tableId,
    })
  }
  if (!canActorAccessTableDataScope(state, actor, tableId)) {
    const table = state.tables.find((item) => item.id === tableId)
    throw new AuthorizationError(`岗位 ${actor.roleId} 无权访问桌台 ${table?.code ?? tableId}`, operation, {
      reason: 'scope_not_allowed',
      roleId: actor.roleId,
      grantedScope: effectiveDataScopeForEmployee(state, actor.actorId),
      tableId,
      areaId: table?.areaId,
    })
  }
  return actor
}

export function requireOperation(
  request: FastifyRequest,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  const actor = requireRequestActor(request)
  return requireRoleOperation(actor, actor.roleId, operation, policy)
}

export function requireConfiguredOperation(
  request: FastifyRequest,
  state: RuntimeState,
  operation: StaffOperation,
) {
  const actor = effectiveRequestActor(request, state)
  const policy = createPermissionPolicyFromRuntimeState(state)
  const configuredRoleIds = effectiveRoleIdsForEmployee(state, actor.actorId)
  const roleIds = configuredRoleIds.length > 0 ? configuredRoleIds : [actor.roleId]
  const matchedRoleId = roleIds
    .find((roleId) => canPerformOperation(roleId, operation, policy))
  if (matchedRoleId) return actor.roleId === matchedRoleId ? actor : { ...actor, roleId: matchedRoleId }
  if (effectivePermissionIdsForEmployee(state, actor.actorId).includes(STAFF_OPERATION_PERMISSION_IDS[operation])) return actor
  return requireRoleOperation(actor, actor.roleId, operation, policy)
}

export function requireAnyRole(
  request: FastifyRequest,
  state: RuntimeState,
  allowedRoleIds: readonly string[],
  operation: string,
  actionName = operation,
) {
  const requestActor = requireRequestActor(request)
  const actor = effectiveRequestActor(request, state)
  const configuredRoleIds = effectiveRoleIdsForEmployee(state, actor.actorId)
  const roleIds = configuredRoleIds.includes(requestActor.roleId) ? configuredRoleIds : [requestActor.roleId]
  const matchedRoleId = roleIds.find((roleId) => allowedRoleIds.includes(roleId))
  if (!matchedRoleId) {
    const allowedRoles = allowedRoleIds.length > 0 ? allowedRoleIds.join('、') : '无'
    throw new AuthorizationError(`岗位 ${actor.roleId} 无权${actionName}；允许岗位：${allowedRoles}`, operation, {
      reason: 'role_not_allowed',
      roleId: actor.roleId,
      allowedRoleIds: [...allowedRoleIds],
    })
  }
  return actor.roleId === matchedRoleId ? actor : { ...actor, roleId: matchedRoleId }
}

export function canAccessDataScope(
  roleId: string,
  requiredScope: DataScope,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return canRoleAccessDataScope(roleId, requiredScope, policy)
}

export function canApproveAmount(
  roleId: string,
  limitType: ApprovalLimitType,
  amount: number,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return canRoleApproveAmount(roleId, limitType, amount, policy)
}

const approvalLimitNames: Record<ApprovalLimitType, string> = {
  gift: '赠送',
  discount: '折扣',
  refundRequest: '退款申请',
  refundApprove: '退款审批',
  inventoryAdjustment: '库存调整',
}

export function requireApprovalAmount(
  request: FastifyRequest,
  state: RuntimeState,
  limitType: ApprovalLimitType,
  amount: number,
  operation = `approval.${limitType}`,
) {
  const actor = effectiveRequestActor(request, state)
  const policy = createPermissionPolicyFromRuntimeState(state)
  const configuredRoleIds = effectiveRoleIdsForEmployee(state, actor.actorId)
  const roleIds = configuredRoleIds.length > 0 ? configuredRoleIds : [actor.roleId]
  if (!roleIds.some((roleId) => getRolePolicy(roleId, policy))) {
    throw new AuthorizationError(`岗位 ${actor.roleId} 未配置审批额度`, operation, {
      reason: 'role_not_configured',
      roleId: actor.roleId,
    })
  }
  const approvalLimit = Math.max(0, ...roleIds.map((roleId) => getRoleApprovalLimit(roleId, limitType, policy)))
  const approvalRoleId = roleIds.find((roleId) => canApproveAmount(roleId, limitType, amount, policy))
  if (!approvalRoleId) {
    throw new AuthorizationError(
      `岗位 ${actor.roleId} 的${approvalLimitNames[limitType]}额度不足：申请 ${amount} 分，上限 ${approvalLimit} 分`,
      operation,
      {
        reason: 'approval_limit_exceeded',
        roleId: actor.roleId,
        approvalLimitType: limitType,
        requestedAmount: amount,
        approvalLimit,
      },
    )
  }
  return actor.roleId === approvalRoleId ? actor : { ...actor, roleId: approvalRoleId }
}

export function requireDataScope(
  request: FastifyRequest,
  requiredScope: DataScope,
  operation = 'data.read',
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  const actor = requireRequestActor(request)
  const role = getRolePolicy(actor.roleId, policy)
  if (!canAccessDataScope(actor.roleId, requiredScope, policy)) {
    const scopeNames: Record<DataScope, string> = {
      own: '本人',
      assigned: '已分配数据',
      assigned_areas: '已分配区域',
      area: '所属区域',
      store: '当前门店',
      organization: '整个组织',
      all_stores: '全部门店',
    }
    const grantedScope = role ? scopeNames[role.dataScope] : '未配置'
    throw new AuthorizationError(
      `岗位 ${actor.roleId} 的数据范围不足：当前为${grantedScope}，需要${scopeNames[requiredScope]}范围`,
      operation,
      {
        reason: 'scope_not_allowed',
        roleId: actor.roleId,
        grantedScope: role?.dataScope,
        requiredScope,
      },
    )
  }
  return actor
}

export function isHighRiskOperation(
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return isPolicyHighRiskOperation(operation, policy)
}

export function canApproveHighRiskOperation(
  roleId: string,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return canRoleApproveHighRiskOperation(roleId, operation, policy)
}

export function requireHighRiskApproval(
  request: FastifyRequest,
  operation: StaffOperation,
  policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  const actor = requireRequestActor(request)
  if (!isHighRiskOperation(operation, policy)) return actor
  if (!canApproveHighRiskOperation(actor.roleId, operation, policy)) {
    throw new AuthorizationError(`岗位 ${actor.roleId} 无权审批高风险操作：${getOperationPolicy(operation, policy).name}`, operation, {
      reason: 'high_risk_approval_required',
      roleId: actor.roleId,
      allowedRoleIds: Object.keys(policy.roles).filter((roleId) => canApproveHighRiskOperation(roleId, operation, policy)),
    })
  }
  return actor
}

export function requireOrderCreationRole(
  request: FastifyRequest,
  state: RuntimeState,
  _policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
) {
  return requireConfiguredOperation(request, state, 'commerce.order.create')
}

export function requireCommerceDecisionAuthority(
  request: FastifyRequest,
  state: RuntimeState,
  authorizationId: string,
  now = new Date(),
  decision: 'granted' | 'rejected' = 'granted',
) {
  const requestActor = requireRequestActor(request)
  const authorization = state.orderDomain.authorizations.find((item) => item.id === authorizationId)
  if (!authorization) return requestActor
  const order = state.orderDomain.orders.find((item) => item.id === authorization.orderId)
  if (!order) return requestActor
  const actor = requireApprovalAmount(
    request,
    state,
    authorization.kind,
    authorization.requestedAmount,
    'commerce.authorization.decide',
  )
  const authorizationItems = order.items.filter((item) => authorization.lineIds.includes(item.id))
  if (authorization.kind === 'gift' && decision === 'granted') {
    try {
      requireGiftPolicy(state, {
        actorId: actor.actorId,
        tableSessionId: order.tableSessionId,
        items: authorizationItems.map((item) => ({ productId: item.skuId, quantity: item.quantity })),
        amount: authorization.requestedAmount,
        occurredAt: now.toISOString(),
      })
    } catch (error) {
      throw new AuthorizationError(
        error instanceof Error ? error.message : '当前员工没有可用的赠送授权',
        'commerce.authorization.decide',
      )
    }
    return actor
  }
  const occurredAt = now.getTime()
  const hasConfiguredAuthority = state.orderDomain.authorizationAuthorities.some((authority) => (
    authority.actorId === actor.actorId &&
    authority.kinds.includes(authorization.kind) &&
    authority.maxAmount >= authorization.requestedAmount &&
    (
      (authority.allowedSkuIds == null && authority.allowedCategoryIds == null)
      || authorizationItems.every((item) => {
        const product = state.products.find((candidate) => candidate.id === item.skuId)
        return Boolean(
          authority.allowedSkuIds?.includes(item.skuId)
          || authority.allowedCategoryIds?.includes(product?.categoryId ?? 'featured')
        )
      })
    ) &&
    (authority.tableSessionIds === null || authority.tableSessionIds.includes(order.tableSessionId)) &&
    occurredAt >= Date.parse(authority.validFrom) &&
    occurredAt <= Date.parse(authority.validUntil)
  ))
  if (!hasConfiguredAuthority) {
    throw new AuthorizationError('当前员工没有有效的经营审批授权', 'commerce.authorization.decide')
  }
  return actor
}
