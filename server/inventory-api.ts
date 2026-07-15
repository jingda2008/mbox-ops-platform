import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { InventoryDomainState, InventoryOperationPolicy } from '../src/shared/inventory-contracts.js'
import type { Employee, RuntimeState } from '../src/shared/contracts.js'
import {
  AuthorizationError,
  requireApprovalAmount,
  requireConfiguredOperation,
  type StaffOperation,
} from './authorization.js'
import {
  confirmStockCount,
  createInventoryDomainState,
  depositBottle,
  receiveInventory,
  rejectStockCount,
  submitStockCount,
  transferStoredBottle,
  useStoredBottle,
  voidStoredBottle,
} from './inventory-domain.js'
import type { RuntimeRepository } from './repository.js'

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

function inventory(state: RuntimeState) {
  if (!state.inventoryDomain) {
    state.inventoryDomain = createInventoryDomainState(
      { tenantId: 'runtime', storeId: state.store.id },
      defaultPolicy(state),
    )
  }
  return state.inventoryDomain
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

function requireApprover(state: RuntimeState, approverId: string, actorId: string, roles: string[]) {
  if (approverId === actorId) throw new Error('高风险库存操作必须由另一人审批')
  const approver = state.employees.find((item) => item.id === approverId && item.status === 'active')
  const configuredRole = approver && state.config.roles.find((role) => role.id === approver.roleId)
  if (
    !approver ||
    !configuredRole?.permissionIds?.includes('inventory.approve') ||
    !roles.includes(approver.roleId)
  ) {
    throw new AuthorizationError('审批人岗位无权批准该库存操作', 'inventory.approve')
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
    return state.inventoryDomain ?? createInventoryDomainState(
      { tenantId: 'runtime', storeId: state.store.id },
      defaultPolicy(state),
    )
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
      if (!state.products.some((product) => product.id === input.productId)) throw new Error('入库商品不存在')
      return mutateInventory(state, (value) => receiveInventory(value, {
        ...input,
        movementId: deterministicId('inventory_movement', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
    return reply.status(201).send(result)
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
        if (!product) throw new Error('盘点商品不存在')
        const adjustmentAmount = Math.abs(count.differenceQuantity) * product.costAmount
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

  app.post<{ Params: { batchId: string } }>('/api/inventory/bottles/:batchId/transfer', async (request) => {
    const input = z.object({ recipientOwner: owner, tableSessionId: identifier, orderId: identifier.optional(), approvalId: identifier, approvedBy: identifier, reason, occurredAt, idempotencyKey }).strict().parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '转赠存酒')
      requireApprover(state, input.approvedBy, actor.id, domain.policy.bottleApprovalRoleIds)
      return mutateInventory(state, (value) => transferStoredBottle(value, {
        ...input,
        sourceBatchId: request.params.batchId,
        recipientBatchId: deterministicId('bottle_batch', input.idempotencyKey),
        eventId: deterministicId('bottle_event', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
  })

  app.post<{ Params: { batchId: string } }>('/api/inventory/bottles/:batchId/void', async (request) => {
    const input = z.object({ tableSessionId: identifier.optional(), orderId: identifier.optional(), approvalId: identifier, approvedBy: identifier, reason, occurredAt, idempotencyKey }).strict().parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredInventoryActor(state, request, 'inventory.manage')
      const domain = inventory(state)
      requirePolicyRole(actor, domain.policy.bottleUseRoleIds, 'inventory.manage', '作废存酒')
      requireApprover(state, input.approvedBy, actor.id, domain.policy.bottleApprovalRoleIds)
      return mutateInventory(state, (value) => voidStoredBottle(value, {
        ...input,
        batchId: request.params.batchId,
        eventId: deterministicId('bottle_event', input.idempotencyKey),
        actorId: actor.id,
        businessDate: state.store.businessDate,
      }))
    })
  })
}
