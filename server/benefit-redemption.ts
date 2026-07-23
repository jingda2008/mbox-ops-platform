import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  benefitRedemptionCancelSchema,
  benefitRedemptionConfirmSchema,
  benefitRedemptionLockSchema,
} from '../src/shared/benefit-redemption-contracts.js'
import type {
  BenefitRedemption,
  BenefitRedemptionCancelCommand,
  BenefitRedemptionConfirmCommand,
  BenefitRedemptionLockCommand,
} from '../src/shared/benefit-redemption-contracts.js'
import { currentOpenTableSession } from './table-sessions.js'
import type { AuditEntry, Employee, RuntimeState, Table } from '../src/shared/contracts.js'
import { productAvailability } from '../src/shared/product-availability.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import {
  addOrderItem,
  createOrderDraft,
  decideOrderAuthorization,
  requestOrderAuthorization,
  submitOrder,
} from './order-domain.js'
import type { RuntimeRepository } from './repository.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'

const benefitRedemptionLockHttpSchema = benefitRedemptionLockSchema.omit({ actorId: true })
const benefitRedemptionConfirmHttpSchema = benefitRedemptionConfirmSchema.omit({
  actorId: true,
  authorizedBy: true,
})
const benefitRedemptionCancelHttpSchema = benefitRedemptionCancelSchema.omit({ actorId: true })

export class BenefitRedemptionBusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message)
    this.name = 'BenefitRedemptionBusinessError'
  }
}

function businessError(code: string, message: string, statusCode = 409): never {
  throw new BenefitRedemptionBusinessError(code, message, statusCode)
}

function assertTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value))) businessError('INVALID_OCCURRED_AT', '核销时间必须是有效的ISO时间', 400)
}

function fingerprint(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
}

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

function redemptions(state: RuntimeState) {
  state.benefitRedemptions ??= []
  return state.benefitRedemptions
}

function currentTableSessionId(state: RuntimeState, tableId: string) {
  return currentOpenTableSession(state, tableId).id
}

function findActiveEmployee(state: RuntimeState, actorId: string, label = '操作人员') {
  const employee = state.employees.find((item) => item.id === actorId && item.status === 'active')
  if (!employee) businessError('ACTOR_NOT_ACTIVE', `${label}不存在或已停用`, 403)
  return employee
}

function findOpenTable(state: RuntimeState, tableId: string): Table & { openedAt: string } {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table || table.status !== 'occupied' || !table.openedAt) {
    businessError('TABLE_NOT_OPEN', '权益只能锁定或核销到已开台桌台')
  }
  return table as Table & { openedAt: string }
}

function canOperateTable(employee: Employee, table: Table) {
  return table.primaryEmployeeId === employee.id ||
    table.backupEmployeeIds.includes(employee.id) ||
    ['supervisor', 'manager'].includes(employee.roleId)
}

function assertTablePermission(employee: Employee, table: Table) {
  if (!canOperateTable(employee, table)) {
    businessError('TABLE_OPERATION_FORBIDDEN', '当前人员不是该桌负责人、候补或管理人员', 403)
  }
}

function assertSameOpenSession(state: RuntimeState, redemption: BenefitRedemption) {
  const table = findOpenTable(state, redemption.tableId)
  if (
    table.openedAt !== redemption.tableOpenedAt ||
    currentTableSessionId(state, table.id) !== redemption.tableSessionId
  ) {
    businessError('TABLE_SESSION_CHANGED', '桌台已关台或重新开台，请取消原锁定后重新核销')
  }
  return table
}

function appendAudit(
  state: RuntimeState,
  redemption: BenefitRedemption,
  actorId: string,
  action: string,
  occurredAt: string,
  details: Record<string, unknown>,
) {
  const sequence = state.auditEntries.filter(
    (entry) => entry.objectType === 'benefitRedemption' && entry.objectId === redemption.id,
  ).length + 1
  const entry: AuditEntry = {
    id: `audit:${redemption.id}:${sequence}`,
    actorId,
    action,
    objectType: 'benefitRedemption',
    objectId: redemption.id,
    occurredAt,
    details,
  }
  state.auditEntries.push(entry)
}

function findRedemption(state: RuntimeState, redemptionId: string) {
  const redemption = redemptions(state).find((item) => item.id === redemptionId)
  if (!redemption) businessError('REDEMPTION_NOT_FOUND', '权益核销记录不存在', 404)
  return redemption
}

export function lockBenefitRedemption(state: RuntimeState, command: BenefitRedemptionLockCommand) {
  assertTimestamp(command.occurredAt)
  const requestFingerprint = fingerprint({
    actorId: command.actorId,
    benefitId: command.benefitId,
    tableId: command.tableId,
    quantity: command.quantity,
  })
  const replay = redemptions(state).find((item) => item.lockIdempotencyKey === command.idempotencyKey)
  if (replay) {
    if (replay.lockFingerprint !== requestFingerprint) {
      businessError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的权益锁定请求')
    }
    return replay
  }

  const actor = findActiveEmployee(state, command.actorId)
  const table = findOpenTable(state, command.tableId)
  assertTablePermission(actor, table)
  const benefit = state.memberBenefits.find((item) => item.id === command.benefitId)
  if (!benefit) businessError('MEMBER_BENEFIT_NOT_FOUND', '会员权益不存在', 404)
  if (benefit.status !== 'available') businessError('MEMBER_BENEFIT_NOT_AVAILABLE', '会员权益当前不可锁定')
  const occurredAt = Date.parse(command.occurredAt)
  if (occurredAt < Date.parse(benefit.validFrom) || occurredAt > Date.parse(benefit.validUntil)) {
    businessError('MEMBER_BENEFIT_OUTSIDE_VALIDITY', '会员权益不在有效使用期内')
  }
  if (command.quantity > benefit.remainingQuantity) {
    businessError('MEMBER_BENEFIT_QUANTITY_INSUFFICIENT', '会员权益剩余数量不足')
  }
  const template = state.benefitTemplates.find((item) => item.id === benefit.templateId && item.enabled)
  if (!template) businessError('BENEFIT_TEMPLATE_UNAVAILABLE', '权益模板不存在或已停用')
  if (template.kind === 'amount_coupon') {
    businessError(
      'AMOUNT_COUPON_ORDER_INTEGRATION_UNAVAILABLE',
      '当前订单模型尚未支持金额券安全分摊、退款回退和支付账务联动，暂不能核销金额券',
      422,
    )
  }
  if (template.kind !== 'product_gift') {
    businessError(
      'BENEFIT_KIND_REDEMPTION_UNAVAILABLE',
      `“${template.name}”尚未接入对应履约系统，暂不能直接扣减权益`,
      422,
    )
  }
  if (!template.productId) businessError('BENEFIT_PRODUCT_NOT_CONFIGURED', '商品赠品权益未关联商品')
  const product = state.products.find((item) => item.id === template.productId && item.enabled)
  if (!product) businessError('BENEFIT_PRODUCT_UNAVAILABLE', '权益关联商品不存在或已停用')
  const availability = productAvailability(product, new Date(), state.store.timezone)
  if (!availability.orderable) businessError('BENEFIT_PRODUCT_UNAVAILABLE', `权益关联商品当前不可出品：${availability.label}`)
  if (product.listPriceAmount !== template.valueAmount || product.costAmount !== template.costAmount) {
    businessError('BENEFIT_PRODUCT_SNAPSHOT_MISMATCH', '权益面值或成本与关联商品不一致，请先更新权益配置')
  }
  if (redemptions(state).some((item) => item.memberBenefitId === benefit.id && item.status === 'locked')) {
    businessError('MEMBER_BENEFIT_ALREADY_LOCKED', '该会员权益已有进行中的核销锁定')
  }

  const redemption: BenefitRedemption = {
    id: deterministicId('benefit_redemption', command.idempotencyKey),
    memberBenefitId: benefit.id,
    memberId: benefit.memberId,
    templateId: benefit.templateId,
    kind: template.kind,
    tableId: table.id,
    tableSessionId: currentTableSessionId(state, table.id),
    tableOpenedAt: table.openedAt,
    quantity: command.quantity,
    status: 'locked',
    lockedBy: actor.id,
    lockedAt: command.occurredAt,
    confirmedBy: null,
    authorizedBy: null,
    confirmedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    orderId: null,
    orderItemId: null,
    authorizationId: null,
    lockIdempotencyKey: command.idempotencyKey,
    lockFingerprint: requestFingerprint,
    confirmIdempotencyKey: null,
    confirmFingerprint: null,
    cancelIdempotencyKey: null,
    cancelFingerprint: null,
  }
  benefit.status = 'locked'
  redemptions(state).unshift(redemption)
  appendAudit(state, redemption, actor.id, 'benefit.redemption_locked.v1', command.occurredAt, {
    memberBenefitId: benefit.id,
    memberId: benefit.memberId,
    templateId: template.id,
    productId: product.id,
    tableId: table.id,
    tableSessionId: redemption.tableSessionId,
    quantity: redemption.quantity,
  })
  state.revision += 1
  return redemption
}

export function confirmBenefitRedemption(state: RuntimeState, redemptionId: string, command: BenefitRedemptionConfirmCommand) {
  assertTimestamp(command.occurredAt)
  const redemption = findRedemption(state, redemptionId)
  const requestFingerprint = fingerprint({ actorId: command.actorId, authorizedBy: command.authorizedBy })
  if (redemption.confirmIdempotencyKey === command.idempotencyKey) {
    if (redemption.confirmFingerprint !== requestFingerprint) {
      businessError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的权益确认请求')
    }
    return redemption
  }
  if (redemptions(state).some(
    (item) => item.id !== redemption.id && item.confirmIdempotencyKey === command.idempotencyKey,
  )) {
    businessError('IDEMPOTENCY_CONFLICT', '幂等键已用于其他权益确认请求')
  }
  if (redemption.status !== 'locked') businessError('REDEMPTION_NOT_LOCKED', '只有已锁定权益可以确认核销')
  if (Date.parse(command.occurredAt) < Date.parse(redemption.lockedAt)) {
    businessError('REDEMPTION_TIME_INVALID', '核销确认时间不能早于锁定时间')
  }

  const actor = findActiveEmployee(state, command.actorId)
  findActiveEmployee(state, command.authorizedBy, '赠送授权人')
  const table = assertSameOpenSession(state, redemption)
  assertTablePermission(actor, table)
  const benefit = state.memberBenefits.find((item) => item.id === redemption.memberBenefitId)
  if (!benefit || benefit.status !== 'locked' || benefit.remainingQuantity < redemption.quantity) {
    businessError('MEMBER_BENEFIT_LOCK_LOST', '会员权益锁定状态已失效，请重新核销')
  }
  const template = state.benefitTemplates.find((item) => item.id === redemption.templateId && item.enabled)
  if (!template || template.kind !== 'product_gift' || !template.productId) {
    businessError('BENEFIT_TEMPLATE_CHANGED', '权益模板已变更，不能按原锁定继续核销')
  }
  const product = state.products.find((item) => item.id === template.productId && item.enabled)
  if (!product) businessError('BENEFIT_PRODUCT_UNAVAILABLE', '权益关联商品不存在或已停用')
  const availability = productAvailability(product, new Date(), state.store.timezone)
  if (!availability.orderable) businessError('BENEFIT_PRODUCT_UNAVAILABLE', `权益关联商品当前不可出品：${availability.label}`)
  if (product.listPriceAmount !== template.valueAmount || product.costAmount !== template.costAmount) {
    businessError('BENEFIT_PRODUCT_SNAPSHOT_MISMATCH', '权益面值或成本与关联商品不一致，请取消后重新处理')
  }

  const orderId = `benefit-redemption:${redemption.id}:order`
  const orderItemId = `benefit-redemption:${redemption.id}:line`
  const authorizationId = `benefit-redemption:${redemption.id}:authorization`
  const orderDomain = structuredClone(state.orderDomain)
  const inventoryDomain = state.inventoryDomain ? structuredClone(state.inventoryDomain) : undefined
  let order
  try {
    createOrderDraft(orderDomain, {
      orderId,
      tableSessionId: redemption.tableSessionId,
      createdBy: actor.id,
      occurredAt: command.occurredAt,
      idempotencyKey: `${command.idempotencyKey}:draft`,
    })
    addOrderItem(orderDomain, {
      orderId,
      item: {
        id: orderItemId,
        skuId: product.id,
        name: product.name,
        specification: product.specification,
        quantity: redemption.quantity,
        unitListPriceAmount: product.listPriceAmount,
        unitSalePriceAmount: 0,
        unitCostAmount: product.costAmount,
        stationId: product.stationId,
        requiresFulfillment: product.requiresFulfillment !== false,
        configVersion: product.configVersion,
      },
      actorId: actor.id,
      occurredAt: command.occurredAt,
      idempotencyKey: `${command.idempotencyKey}:item`,
    })
    requestOrderAuthorization(orderDomain, {
      authorizationId,
      orderId,
      kind: 'gift',
      lineIds: [orderItemId],
      requestedBy: actor.id,
      occurredAt: command.occurredAt,
      idempotencyKey: `${command.idempotencyKey}:authorization-request`,
    })
    decideOrderAuthorization(orderDomain, {
      authorizationId,
      decision: 'granted',
      decidedBy: command.authorizedBy,
      reason: `会员权益核销：${benefit.id}`,
      occurredAt: command.occurredAt,
      idempotencyKey: `${command.idempotencyKey}:authorization-decision`,
    })
    order = submitOrder(orderDomain, {
      orderId,
      submittedBy: actor.id,
      occurredAt: command.occurredAt,
      idempotencyKey: `${command.idempotencyKey}:submit`,
    })
    consumeManagedInventoryForSubmittedOrder(inventoryDomain, order, {
      actorId: actor.id,
      businessDate: state.store.businessDate,
      occurredAt: command.occurredAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知订单错误'
    const authorizationFailure = message.includes('授权') || message.includes('审批人')
    businessError(
      authorizationFailure ? 'ORDER_GIFT_AUTHORIZATION_FAILED' : 'BENEFIT_ORDER_CREATION_FAILED',
      `权益未扣减，赠送订单创建失败：${message}`,
      authorizationFailure ? 403 : 409,
    )
  }

  state.orderDomain = orderDomain
  if (inventoryDomain) state.inventoryDomain = inventoryDomain
  benefit.remainingQuantity -= redemption.quantity
  benefit.status = benefit.remainingQuantity === 0 ? 'redeemed' : 'available'
  redemption.status = 'confirmed'
  redemption.confirmedBy = actor.id
  redemption.authorizedBy = command.authorizedBy
  redemption.confirmedAt = command.occurredAt
  redemption.orderId = orderId
  redemption.orderItemId = orderItemId
  redemption.authorizationId = authorizationId
  redemption.confirmIdempotencyKey = command.idempotencyKey
  redemption.confirmFingerprint = requestFingerprint
  appendAudit(state, redemption, actor.id, 'benefit.redemption_confirmed.v1', command.occurredAt, {
    memberBenefitId: benefit.id,
    memberId: benefit.memberId,
    tableId: table.id,
    tableSessionId: redemption.tableSessionId,
    orderId,
    orderItemId,
    authorizationId,
    authorizedBy: command.authorizedBy,
    quantity: redemption.quantity,
    grossAmount: order.amounts.grossAmount,
    giftAmount: order.amounts.giftAmount,
    payableAmount: order.amounts.payableAmount,
    unitCostAmount: product.costAmount,
  })
  state.revision += 1
  return redemption
}

export function cancelBenefitRedemption(state: RuntimeState, redemptionId: string, command: BenefitRedemptionCancelCommand) {
  assertTimestamp(command.occurredAt)
  const redemption = findRedemption(state, redemptionId)
  const requestFingerprint = fingerprint({ actorId: command.actorId, reason: command.reason })
  if (redemption.cancelIdempotencyKey === command.idempotencyKey) {
    if (redemption.cancelFingerprint !== requestFingerprint) {
      businessError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同的权益取消请求')
    }
    return redemption
  }
  if (redemptions(state).some(
    (item) => item.id !== redemption.id && item.cancelIdempotencyKey === command.idempotencyKey,
  )) {
    businessError('IDEMPOTENCY_CONFLICT', '幂等键已用于其他权益取消请求')
  }
  if (redemption.status !== 'locked') businessError('REDEMPTION_NOT_LOCKED', '只有已锁定权益可以取消释放')
  if (Date.parse(command.occurredAt) < Date.parse(redemption.lockedAt)) {
    businessError('REDEMPTION_TIME_INVALID', '取消时间不能早于锁定时间')
  }
  const actor = findActiveEmployee(state, command.actorId)
  const table = state.tables.find((item) => item.id === redemption.tableId)
  const canCancel = actor.id === redemption.lockedBy ||
    Boolean(table && canOperateTable(actor, table)) ||
    ['supervisor', 'manager'].includes(actor.roleId)
  if (!canCancel) businessError('REDEMPTION_CANCEL_FORBIDDEN', '当前人员没有取消该权益锁定的权限', 403)
  const benefit = state.memberBenefits.find((item) => item.id === redemption.memberBenefitId)
  if (!benefit || benefit.status !== 'locked') {
    businessError('MEMBER_BENEFIT_LOCK_LOST', '会员权益锁定状态已失效，不能取消')
  }

  benefit.status = Date.parse(command.occurredAt) > Date.parse(benefit.validUntil) ? 'expired' : 'available'
  redemption.status = 'cancelled'
  redemption.cancelledBy = actor.id
  redemption.cancelledAt = command.occurredAt
  redemption.cancelReason = command.reason
  redemption.cancelIdempotencyKey = command.idempotencyKey
  redemption.cancelFingerprint = requestFingerprint
  appendAudit(state, redemption, actor.id, 'benefit.redemption_cancelled.v1', command.occurredAt, {
    memberBenefitId: benefit.id,
    memberId: benefit.memberId,
    tableId: redemption.tableId,
    tableSessionId: redemption.tableSessionId,
    reason: command.reason,
    releasedStatus: benefit.status,
  })
  state.revision += 1
  return redemption
}

export function registerBenefitRedemptionRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/benefits/redemptions/locks', async (request, reply) => {
    const input = benefitRedemptionLockHttpSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'benefit.grant')
      requireTableDataScope(request, state, input.tableId, 'benefit.grant')
      return lockBenefitRedemption(state, { ...input, actorId: actor.actorId, occurredAt: new Date().toISOString() })
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { redemptionId: string } }>('/api/benefits/redemptions/:redemptionId/confirm', async (request) => {
    const input = benefitRedemptionConfirmHttpSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'benefit.approve')
      const redemption = state.benefitRedemptions.find((item) => item.id === request.params.redemptionId)
      if (!redemption) businessError('REDEMPTION_NOT_FOUND', '权益核销记录不存在', 404)
      requireTableDataScope(request, state, redemption.tableId, 'benefit.approve')
      return confirmBenefitRedemption(state, request.params.redemptionId, {
        ...input, actorId: actor.actorId, authorizedBy: actor.actorId, occurredAt: new Date().toISOString(),
      })
    })
  })

  app.post<{ Params: { redemptionId: string } }>('/api/benefits/redemptions/:redemptionId/cancel', async (request) => {
    const input = benefitRedemptionCancelHttpSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'benefit.grant')
      const redemption = state.benefitRedemptions.find((item) => item.id === request.params.redemptionId)
      if (!redemption) businessError('REDEMPTION_NOT_FOUND', '权益核销记录不存在', 404)
      requireTableDataScope(request, state, redemption.tableId, 'benefit.grant')
      return cancelBenefitRedemption(state, request.params.redemptionId, {
        ...input, actorId: actor.actorId, occurredAt: new Date().toISOString(),
      })
    })
  })
}
