import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  InventoryApprovalActorSnapshot,
  InventoryDomainState,
  InventoryOperationPolicy,
} from '../src/shared/inventory-contracts.js'
import type { Employee, RuntimeState } from '../src/shared/contracts.js'
import {
  AuthorizationError,
  requireApprovalAmount,
  requireConfiguredOperation,
  type StaffOperation,
} from './authorization.js'
import {
  confirmStockCount,
  convertIngredientQuantityToBase,
  createInventoryDomainState,
  depositBottle,
  normalizeInventoryDomainState,
  publishRecipeVersion,
  receiveInventory,
  rejectStockCount,
  submitStockCount,
  transferStoredBottle,
  upsertIngredientSku,
  useStoredBottle,
  voidStoredBottle,
} from './inventory-domain.js'
import type { RuntimeRepository } from './repository.js'
import { consumeManagedInventoryForRemadeOrderItem } from './inventory-order-integration.js'
import { requireRequestActor } from './auth-context.js'
import {
  beginDualApprovalDecision,
  completeDualApprovalDecision,
  requestDualApproval,
} from './dual-approval.js'

const identifier = z.string().trim().min(1).max(128)
const idempotencyKey = z.string().trim().min(8).max(128)
const occurredAt = z.string().datetime({ offset: true })
const reason = z.string().trim().min(2).max(500)
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const unitCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
const owner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), memberId: identifier }).strict(),
  z.object({
    kind: z.literal('anonymous'),
    customerRef: identifier,
    displayNameSnapshot: z.string().trim().min(1).max(80),
  }).strict(),
])
const conversionSchema = z.object({ unitCode, baseQuantity: quantity }).strict()
const recipeLineSchema = z.object({
  ingredientSkuId: identifier,
  standardQuantity: quantity,
  allowedLossBps: z.number().int().min(0).max(10_000),
}).strict()
const bottleTransferRequestSchema = z.object({
  recipientOwner: owner,
  tableSessionId: identifier,
  orderId: identifier.optional(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()
const bottleVoidRequestSchema = z.object({
  tableSessionId: identifier.optional(),
  orderId: identifier.optional(),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()
const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason,
  occurredAt,
  idempotencyKey,
}).strict()

const policySchema = z.object({
  policyAdminRoleIds: z.array(identifier).min(1),
  receiptRoleIds: z.array(identifier),
  stockCountRoleIds: z.array(identifier),
  stockCountApprovalRoleIds: z.array(identifier),
  bottleDepositRoleIds: z.array(identifier),
  bottleUseRoleIds: z.array(identifier),
  bottleApprovalRoleIds: z.array(identifier),
}).strict()

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function defaultPolicy(state: RuntimeState): InventoryOperationPolicy {
  const roleIds = state.config.roles.map((role) => role.id)
  const managers = roleIds.filter((roleId) => roleId === 'owner' || roleId === 'manager')
  const supervisors = roleIds.filter((roleId) => roleId === 'owner' || roleId === 'supervisor' || roleId === 'manager')
  return {
    policyAdminRoleIds: managers,
    receiptRoleIds: managers,
    stockCountRoleIds: supervisors,
    stockCountApprovalRoleIds: managers,
    bottleDepositRoleIds: roleIds,
    bottleUseRoleIds: roleIds,
    bottleApprovalRoleIds: supervisors,
  }
}

export function ensureInventoryDomainState(state: RuntimeState) {
  if (!state.inventoryDomain) {
    state.inventoryDomain = createInventoryDomainState(
      { tenantId: 'runtime', storeId: state.store.id },
      defaultPolicy(state),
    )
  }
  return normalizeInventoryDomainState(state.inventoryDomain)
}

const inventory = ensureInventoryDomainState

function approvalActorSnapshot(request: FastifyRequest, employee: Employee): InventoryApprovalActorSnapshot {
  const actor = requireRequestActor(request)
  if (actor.actorId !== employee.id) throw new Error('认证员工与库存操作人不一致')
  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    roleId: employee.roleId,
    authenticatedBy: actor.authenticatedBy,
  }
}

function appendApprovalAudit(
  state: RuntimeState,
  input: { id: string; actorId: string; action: string; occurredAt: string; details: Record<string, unknown> },
) {
  state.auditEntries.push({
    id: deterministicId('audit_inventory_approval', `${input.id}:${input.action}:${input.occurredAt}`),
    actorId: input.actorId,
    action: input.action,
    objectType: 'inventoryApproval',
    objectId: input.id,
    occurredAt: input.occurredAt,
    details: structuredClone(input.details),
  })
}

function requireConfiguredInventoryActor(
  state: RuntimeState,
  request: FastifyRequest,
  operation: StaffOperation,
) {
  const actor = requireConfiguredOperation(request, state, operation)
  const employee = state.employees.find((item) => item.id === actor.actorId && item.status === 'active')
  if (!employee) throw new AuthorizationError('库存操作人不存在或已停用', operation)
  return employee.roleId === actor.roleId ? employee : { ...employee, roleId: actor.roleId }
}

function requirePolicyRole(employee: Employee, allowedRoleIds: string[], operation: StaffOperation, action: string) {
  if (!allowedRoleIds.includes(employee.roleId)) {
    throw new AuthorizationError(`当前岗位无权${action}`, operation)
  }
}

function mutateInventory<T>(state: RuntimeState, operation: (domain: InventoryDomainState) => T) {
  const domain = inventory(state)
  const before = domain.idempotencyRecords.length
  const result = operation(domain)
  if (domain.idempotencyRecords.length !== before) state.revision += 1
  return result
}

export function registerInventoryRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/inventory', async (request) => {
    const state = await repository.read()
    requireConfiguredOperation(request, state, 'inventory.view')
    return state.inventoryDomain
      ? normalizeInventoryDomainState(state.inventoryDomain)
      : createInventoryDomainState({ tenantId: 'runtime', storeId: state.store.id }, defaultPolicy(state))
  })

  app.post('/api/inventory/ingredients', async (request, reply) => {
    const input = z.object({
      ingredientSkuId: identifier.optional(),
      sku: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
      name: z.string().trim().min(1).max(120),
      baseUnitCode: unitCode,
      costAmountPerBaseUnit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      conversions: z.array(conversionSchema).min(1).max(20),
      enabled: z.boolean().default(true),
      reason,
      occurredAt,
      idempotencyKey,
    }).strict().parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.approve')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.policyAdminRoleIds, 'inventory.approve', '配置原料SKU')
      return mutateInventory(state, (value) => upsertIngredientSku(value, {
        ...input,
        ingredientSkuId: input.ingredientSkuId ?? deterministicId('ingredient', input.idempotencyKey),
        actorId: actor.id,
      }))
    })
    return reply.status(201).send(result)
  })

  app.post('/api/inventory/recipes', async (request, reply) => {
    const input = z.object({
      productId: identifier,
      lines: z.array(recipeLineSchema).min(1).max(50),
      reason,
      occurredAt,
      idempotencyKey,
    }).strict().parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.approve')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.policyAdminRoleIds, 'inventory.approve', '发布配方')
      if (!state.products.some((item) => item.id === input.productId && item.enabled)) {
        throw new Error('配方商品不存在或已停用')
      }
      return mutateInventory(state, (value) => publishRecipeVersion(value, {
        ...input,
        recipeVersionId: deterministicId('recipe', input.idempotencyKey),
        actorId: actor.id,
      }))
    })
    return reply.status(201).send(result)
  })

  app.put('/api/inventory/policy', async (request) => {
    const input = z.object({ policy: policySchema, reason, idempotencyKey }).strict().parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.approve')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.policyAdminRoleIds, 'inventory.approve', '修改库存权限')
      const validRoles = new Set(state.config.roles.map((role) => role.id))
      for (const [field, roleIds] of Object.entries(input.policy)) {
        if (new Set(roleIds).size !== roleIds.length) throw new Error(`${field}不能包含重复岗位`)
        if (roleIds.some((roleId) => !validRoles.has(roleId))) throw new Error(`${field}引用了不存在的岗位`)
      }
      const existing = state.auditEntries.find((entry) =>
        entry.action === 'inventory.policy.updated.v1' && entry.details.idempotencyKey === input.idempotencyKey,
      )
      if (existing) {
        if (JSON.stringify(existing.details.policy) !== JSON.stringify(input.policy)) throw new Error('幂等键已用于不同库存权限配置')
        return domain.policy
      }
      domain.policy = structuredClone(input.policy)
      state.revision += 1
      state.auditEntries.push({
        id: deterministicId('audit_inventory_policy', input.idempotencyKey),
        actorId: actor.id,
        action: 'inventory.policy.updated.v1',
        objectType: 'inventoryPolicy',
        objectId: state.store.id,
        occurredAt: new Date().toISOString(),
        details: { reason: input.reason, idempotencyKey: input.idempotencyKey, policy: structuredClone(input.policy) },
      })
      return domain.policy
    })
  })

  app.post('/api/inventory/receipts', async (request, reply) => {
    const input = z.object({ productId: identifier, unitCode, quantity, reason, occurredAt, idempotencyKey }).strict().parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.receiptRoleIds, 'inventory.manage', '登记入库')
      const ingredient = domain.ingredientSkus.find((item) => item.id === input.productId)
      if (!ingredient && !state.products.some((product) => product.id === input.productId)) {
        throw new Error('入库商品或原料不存在')
      }
      const converted = ingredient
        ? convertIngredientQuantityToBase(domain, input.productId, input.unitCode, input.quantity)
        : null
      return mutateInventory(state, (value) => receiveInventory(value, {
        ...input,
        unitCode: converted?.ingredient.baseUnitCode ?? input.unitCode,
        quantity: converted?.baseQuantity ?? input.quantity,
        movementId: deterministicId('inventory_movement', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
        configurationSnapshot: converted ? {
          kind: 'unit_conversion',
          inputQuantity: input.quantity,
          inputUnitCode: input.unitCode,
          conversion: structuredClone(converted.conversion),
          ingredient: structuredClone(converted.ingredient),
        } : null,
      }))
    })
    return reply.status(201).send(result)
  })

  app.post('/api/inventory/remakes', async (request, reply) => {
    const input = z.object({
      orderId: identifier,
      orderItemId: identifier,
      quantity,
      reason,
      occurredAt,
      idempotencyKey,
    }).strict().parse(request.body)
    const movements = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '登记补做耗用')
      const order = state.orderDomain.orders.find((item) => item.id === input.orderId)
      const item = order?.items.find((candidate) => candidate.id === input.orderItemId)
      if (!order || !item) throw new Error('补做关联的订单明细不存在')
      return mutateInventory(state, (value) => consumeManagedInventoryForRemadeOrderItem(value, order, item, {
        actorId: actor.id,
        businessDate: state.store.businessDate,
        occurredAt: input.occurredAt,
        quantity: input.quantity,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }))
    })
    return reply.status(201).send(movements)
  })

  app.post('/api/inventory/stock-counts', async (request, reply) => {
    const input = z.object({ productId: identifier, unitCode, countedQuantity: z.number().int().nonnegative(), approvalId: identifier.optional(), occurredAt, idempotencyKey }).strict().parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.stockCountRoleIds, 'inventory.manage', '提交盘点')
      return mutateInventory(state, (value) => submitStockCount(value, {
        ...input,
        countId: deterministicId('stock_count', input.idempotencyKey),
        countedBy: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { countId: string } }>('/api/inventory/stock-counts/:countId/decision', async (request) => {
    const input = z.object({ decision: z.enum(['confirm', 'reject']), approvalId: identifier, reason, occurredAt, idempotencyKey }).strict().parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.approve')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.stockCountApprovalRoleIds, 'inventory.approve', '复核盘点差异')
      if (input.decision === 'confirm') {
        const count = domain.stockCounts.find((item) => item.id === request.params.countId)
        if (!count) throw new Error('盘点记录不存在')
        const product = state.products.find((item) => item.id === count.productId)
        const ingredient = domain.ingredientSkus.find((item) => item.id === count.productId)
        if (!product && !ingredient) throw new Error('盘点商品或原料不存在')
        const adjustmentAmount = Math.abs(count.differenceQuantity) *
          (product?.costAmount ?? ingredient?.costAmountPerBaseUnit ?? 0)
        if (!Number.isSafeInteger(adjustmentAmount)) throw new Error('库存调整成本金额超出安全范围')
        requireApprovalAmount(request, state, 'inventoryAdjustment', adjustmentAmount, 'inventory.approve')
      }
      return mutateInventory(state, (value) => input.decision === 'confirm'
        ? confirmStockCount(value, {
            countId: request.params.countId,
            adjustmentMovementId: deterministicId('inventory_adjustment', input.idempotencyKey),
            approvalId: input.approvalId,
            confirmedBy: actor.id,
            reason: input.reason,
            occurredAt: input.occurredAt,
            idempotencyKey: input.idempotencyKey,
          })
        : rejectStockCount(value, {
            countId: request.params.countId,
            approvalId: input.approvalId,
            rejectedBy: actor.id,
            reason: input.reason,
            occurredAt: input.occurredAt,
            idempotencyKey: input.idempotencyKey,
          }))
    })
  })

  app.post('/api/inventory/bottles', async (request, reply) => {
    const input = z.object({
      productId: identifier,
      skuSnapshot: identifier,
      productNameSnapshot: z.string().trim().min(1).max(120),
      owner,
      capacityQuantity: quantity,
      unitCode,
      expiresAt: occurredAt,
      tableSessionId: identifier,
      orderId: identifier,
      orderItemId: identifier,
      approvalId: identifier.optional(),
      reason,
      occurredAt,
      idempotencyKey,
    }).strict().parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleDepositRoleIds, 'inventory.manage', '登记存酒')
      const memberId = input.owner.kind === 'member' ? input.owner.memberId : null
      if (memberId && !state.members.some((member) => member.id === memberId)) {
        throw new Error('存酒会员不存在')
      }
      return mutateInventory(state, (value) => depositBottle(value, {
        ...input,
        batchId: deterministicId('bottle_batch', input.idempotencyKey),
        eventId: deterministicId('bottle_event', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { batchId: string } }>('/api/inventory/bottles/:batchId/use', async (request) => {
    const input = z.object({ quantity, tableSessionId: identifier, orderId: identifier, orderItemId: identifier.optional(), reason, occurredAt, idempotencyKey }).strict().parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '取用存酒')
      return mutateInventory(state, (value) => useStoredBottle(value, {
        ...input,
        batchId: request.params.batchId,
        eventId: deterministicId('bottle_event', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
  })

  app.post<{ Params: { batchId: string } }>('/api/inventory/bottles/:batchId/transfer', async (request, reply) => {
    const input = bottleTransferRequestSchema.parse(request.body)
    const approval = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '转赠存酒')
      const batch = domain.bottleBatches.find((item) => item.id === request.params.batchId)
      if (!batch || !['stored', 'partially_used'].includes(batch.status)) throw new Error('只有有效存酒可以申请转赠')
      if (input.recipientOwner.kind === 'member') {
        const recipientMemberId = input.recipientOwner.memberId
        if (!state.members.some((item) => item.id === recipientMemberId)) throw new Error('接收会员不存在')
      }
      const beforeCount = domain.approvalRequests.length
      const result = requestDualApproval(domain, {
        approvalId: deterministicId('inventory_approval', input.idempotencyKey),
        action: 'bottle_transfer',
        targetId: batch.id,
        requestPayload: structuredClone(input),
        beforeSnapshot: structuredClone(batch),
        requestedBy: approvalActorSnapshot(request, actor),
        reason: input.reason,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      })
      if (domain.approvalRequests.length !== beforeCount) {
        state.revision += 1
        appendApprovalAudit(state, {
          id: result.id,
          actorId: actor.id,
          action: 'inventory.approval.requested.v1',
          occurredAt: input.occurredAt,
          details: { approvalAction: result.action, targetId: result.targetId, beforeSnapshot: result.beforeSnapshot },
        })
      }
      return result
    })
    return reply.status(202).send(approval)
  })

  app.post<{ Params: { batchId: string } }>('/api/inventory/bottles/:batchId/void', async (request, reply) => {
    const input = bottleVoidRequestSchema.parse(request.body)
    const approval = await repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '作废存酒')
      const batch = domain.bottleBatches.find((item) => item.id === request.params.batchId)
      if (!batch || !['stored', 'partially_used'].includes(batch.status)) throw new Error('只有有效存酒可以申请作废')
      const beforeCount = domain.approvalRequests.length
      const result = requestDualApproval(domain, {
        approvalId: deterministicId('inventory_approval', input.idempotencyKey),
        action: 'bottle_void',
        targetId: batch.id,
        requestPayload: structuredClone(input),
        beforeSnapshot: structuredClone(batch),
        requestedBy: approvalActorSnapshot(request, actor),
        reason: input.reason,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      })
      if (domain.approvalRequests.length !== beforeCount) {
        state.revision += 1
        appendApprovalAudit(state, {
          id: result.id,
          actorId: actor.id,
          action: 'inventory.approval.requested.v1',
          occurredAt: input.occurredAt,
          details: { approvalAction: result.action, targetId: result.targetId, beforeSnapshot: result.beforeSnapshot },
        })
      }
      return result
    })
    return reply.status(202).send(approval)
  })

  app.post<{ Params: { approvalId: string } }>('/api/inventory/approvals/:approvalId/decision', async (request) => {
    const input = approvalDecisionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.approve')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleApprovalRoleIds, 'inventory.approve', '审批存酒高风险操作')
      const command = { ...input, decidedBy: approvalActorSnapshot(request, actor) }
      const pending = beginDualApprovalDecision(domain, request.params.approvalId, command)
      if (!['bottle_transfer', 'bottle_void'].includes(pending.approval.action)) {
        throw new Error('该审批单不属于存酒操作')
      }
      if (pending.replay) return pending.approval

      if (input.decision === 'reject') {
        const rejected = completeDualApprovalDecision(domain, pending.approval.id, command, pending.approval.beforeSnapshot)
        state.revision += 1
        appendApprovalAudit(state, {
          id: rejected.id,
          actorId: actor.id,
          action: 'inventory.approval.rejected.v1',
          occurredAt: input.occurredAt,
          details: { approvalAction: rejected.action, requestedBy: rejected.requestedBy.employeeId, reason: input.reason },
        })
        return rejected
      }

      const executionKey = `${pending.approval.id}:execute:v1`
      let afterSnapshot: unknown
      if (pending.approval.action === 'bottle_transfer') {
        const payload = bottleTransferRequestSchema.parse(pending.approval.requestPayload)
        const recipient = mutateInventory(state, (value) => transferStoredBottle(value, {
          recipientOwner: payload.recipientOwner,
          tableSessionId: payload.tableSessionId,
          orderId: payload.orderId,
          approvalId: pending.approval.id,
          approvedBy: actor.id,
          sourceBatchId: pending.approval.targetId,
          recipientBatchId: deterministicId('bottle_batch', executionKey),
          eventId: deterministicId('bottle_event', executionKey),
          actorId: pending.approval.requestedBy.employeeId,
          reason: `${pending.approval.requestReason}；审批意见：${input.reason}`,
          businessDate: state.store.businessDate,
          occurredAt: input.occurredAt,
          idempotencyKey: executionKey,
        }))
        const source = domain.bottleBatches.find((item) => item.id === pending.approval.targetId)
        const event = domain.bottleEvents.find((item) => item.approvalId === pending.approval.id)
        afterSnapshot = { source, recipient, event }
      } else {
        const payload = bottleVoidRequestSchema.parse(pending.approval.requestPayload)
        const event = mutateInventory(state, (value) => voidStoredBottle(value, {
          tableSessionId: payload.tableSessionId,
          orderId: payload.orderId,
          approvalId: pending.approval.id,
          approvedBy: actor.id,
          batchId: pending.approval.targetId,
          eventId: deterministicId('bottle_event', executionKey),
          actorId: pending.approval.requestedBy.employeeId,
          reason: `${pending.approval.requestReason}；审批意见：${input.reason}`,
          businessDate: state.store.businessDate,
          occurredAt: input.occurredAt,
          idempotencyKey: executionKey,
        }))
        const batch = domain.bottleBatches.find((item) => item.id === pending.approval.targetId)
        afterSnapshot = { batch, event }
      }
      const approved = completeDualApprovalDecision(domain, pending.approval.id, command, afterSnapshot)
      state.revision += 1
      appendApprovalAudit(state, {
        id: approved.id,
        actorId: actor.id,
        action: 'inventory.approval.approved_and_executed.v1',
        occurredAt: input.occurredAt,
        details: {
          approvalAction: approved.action,
          requestedBy: approved.requestedBy.employeeId,
          beforeSnapshot: approved.beforeSnapshot,
          afterSnapshot: approved.afterSnapshot,
        },
      })
      return approved
    })
  })
}
