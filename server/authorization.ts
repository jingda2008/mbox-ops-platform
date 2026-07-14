import type { FastifyRequest } from 'fastify'
import type { RuntimeState } from '../src/shared/contracts.js'
import { requireRequestActor } from './auth-context.js'

export type StaffOperation =
  | 'config.write'
  | 'master-data.write'
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

const operationRoles: Record<StaffOperation, readonly string[]> = {
  'config.write': ['supervisor', 'manager'],
  'master-data.write': ['supervisor', 'manager'],
  'commerce-authority.write': ['manager'],
  'commerce.order.create': ['server', 'backup', 'supervisor', 'manager'],
  'commerce.kds.prepare': ['specialist', 'supervisor', 'manager'],
  'commerce.kds.deliver': ['server', 'backup', 'specialist', 'supervisor', 'manager'],
  'commerce.authorization.request': ['server', 'backup', 'specialist', 'supervisor', 'manager'],
  'payment.intent.create': ['server', 'backup', 'supervisor', 'manager'],
  'payment.pos.report': ['supervisor', 'manager'],
  'payment.refund.request': ['server', 'backup', 'supervisor', 'manager'],
  'payment.refund.approve': ['supervisor', 'manager'],
  'notification.retry': ['supervisor', 'manager'],
}

const operationNames: Record<StaffOperation, string> = {
  'config.write': '修改门店配置',
  'master-data.write': '修改门店主数据',
  'commerce-authority.write': '修改经营授权',
  'commerce.order.create': '创建订单',
  'commerce.kds.prepare': '执行出品操作',
  'commerce.kds.deliver': '执行取送操作',
  'commerce.authorization.request': '申请经营授权',
  'payment.intent.create': '创建收款单',
  'payment.pos.report': '报送物理POS收款',
  'payment.refund.request': '申请退款',
  'payment.refund.approve': '审批并确认退款',
  'notification.retry': '人工重试客户通知',
}

export class AuthorizationError extends Error {
  readonly statusCode = 403
  readonly code = 'AUTHORIZATION_DENIED'

  constructor(message: string, public readonly operation: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export function requireOperation(request: FastifyRequest, operation: StaffOperation) {
  return requireAnyRole(request, operationRoles[operation], operation, operationNames[operation])
}

export function requireAnyRole(
  request: FastifyRequest,
  allowedRoleIds: readonly string[],
  operation: string,
  actionName = operation,
) {
  const actor = requireRequestActor(request)
  if (!allowedRoleIds.includes(actor.roleId)) {
    throw new AuthorizationError(`当前岗位无权${actionName}`, operation)
  }
  return actor
}

export function requireOrderCreationRole(request: FastifyRequest, state: RuntimeState) {
  const configuredRoleIds = state.config.serviceTypes.find((item) => item.code === 'ORDER_HELP' && item.enabled)
    ?.dispatchRoleIds
  return configuredRoleIds
    ? requireAnyRole(request, configuredRoleIds, 'commerce.order.create', '创建订单')
    : requireOperation(request, 'commerce.order.create')
}

export function requireCommerceDecisionAuthority(
  request: FastifyRequest,
  state: RuntimeState,
  authorizationId: string,
  now = new Date(),
) {
  const actor = requireRequestActor(request)
  const authorization = state.orderDomain.authorizations.find((item) => item.id === authorizationId)
  if (!authorization) return actor
  const order = state.orderDomain.orders.find((item) => item.id === authorization.orderId)
  if (!order) return actor
  const authorizationItems = order.items.filter((item) => authorization.lineIds.includes(item.id))
  const occurredAt = now.getTime()
  const hasConfiguredAuthority = state.orderDomain.authorizationAuthorities.some((authority) => (
    authority.actorId === actor.actorId &&
    authority.kinds.includes(authorization.kind) &&
    authority.maxAmount >= authorization.requestedAmount &&
    (authority.allowedSkuIds == null || authorizationItems.every((item) => authority.allowedSkuIds?.includes(item.skuId))) &&
    (authority.tableSessionIds === null || authority.tableSessionIds.includes(order.tableSessionId)) &&
    occurredAt >= Date.parse(authority.validFrom) &&
    occurredAt <= Date.parse(authority.validUntil)
  ))
  if (!hasConfiguredAuthority) {
    throw new AuthorizationError('当前员工没有有效的经营审批授权', 'commerce.authorization.decide')
  }
  return actor
}
