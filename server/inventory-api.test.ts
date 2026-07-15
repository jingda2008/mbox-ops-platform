import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerAuthContext } from './auth-context.js'
import { AuthorizationError } from './authorization.js'
import { registerInventoryRoutes } from './inventory-api.js'
import { JsonRepository } from './repository.js'

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-inventory-api-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  await registerAuthContext(app, { runtimeMode: 'test', readState: () => repository.read() })
  registerInventoryRoutes(app, repository)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
    }
    return reply.status(400).send({ message: error.message })
  })
  return { app, repository }
}

function headers(actorId: string) {
  return { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': 'mbox-lujiazui' }
}

describe('inventory API', () => {
  it('uses configurable role permissions and preserves receipt idempotency', async () => {
    const { app, repository } = await fixture()
    const payload = {
      productId: 'product-beer',
      unitCode: 'bottle',
      quantity: 24,
      reason: '营业前补货',
      occurredAt: new Date().toISOString(),
      idempotencyKey: 'receipt-api-0001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/inventory/receipts', headers: headers('emp-chen'), payload })
    const replay = await app.inject({ method: 'POST', url: '/api/inventory/receipts', headers: headers('emp-chen'), payload })
    expect(first.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
    expect((await repository.read()).inventoryDomain?.movements).toHaveLength(1)

    const denied = await app.inject({ method: 'POST', url: '/api/inventory/receipts', headers: headers('emp-lin'), payload: {
      ...payload, idempotencyKey: 'receipt-api-0002',
    } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED', operation: 'inventory.manage' })
    await app.close()
    await repository.close()
  })

  it('uses configured permissions before the inventory operation policy', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      const manager = state.config.roles.find((role) => role.id === 'manager')!
      manager.permissionIds = manager.permissionIds?.filter((permission) => permission !== 'inventory.manage')
      state.revision += 1
    })
    const inventoryBeforeRequest = (await repository.read()).inventoryDomain
    const payload = {
      productId: 'product-beer',
      unitCode: 'bottle',
      quantity: 12,
      reason: '测试配置权限优先',
      occurredAt: new Date().toISOString(),
      idempotencyKey: 'receipt-config-denied-0001',
    }
    const denied = await app.inject({
      method: 'POST', url: '/api/inventory/receipts', headers: headers('emp-chen'), payload,
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED', operation: 'inventory.manage' })
    expect((await repository.read()).inventoryDomain).toEqual(inventoryBeforeRequest)
    await app.close()
    await repository.close()
  })

  it.each([
    ['emp-admin', 'admin'],
    ['emp-cashier', 'cashier'],
    ['emp-host', 'host'],
    ['emp-lin', 'server'],
  ])('denies unrelated %s (%s) inventory management by default', async (actorId) => {
    const { app, repository } = await fixture()
    const response = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers(actorId),
      payload: {
        productId: 'product-beer',
        unitCode: 'bottle',
        quantity: 1,
        reason: '无关岗位权限测试',
        occurredAt: new Date().toISOString(),
        idempotencyKey: `receipt-denied-${actorId}`,
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED', operation: 'inventory.manage' })
    await app.close()
    await repository.close()
  })

  it('allows configured owner and manager approval but denies supervisor approval', async () => {
    const { app, repository } = await fixture()
    const inventory = await app.inject({ method: 'GET', url: '/api/inventory', headers: headers('emp-owner') })
    const policy = inventory.json().policy
    const payload = {
      policy,
      reason: '验证库存审批岗位授权',
      idempotencyKey: 'inventory-policy-auth-0001',
    }
    const denied = await app.inject({
      method: 'PUT', url: '/api/inventory/policy', headers: headers('emp-mia'), payload,
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED', operation: 'inventory.approve' })

    const manager = await app.inject({
      method: 'PUT', url: '/api/inventory/policy', headers: headers('emp-chen'), payload,
    })
    expect(manager.statusCode).toBe(200)

    const owner = await app.inject({
      method: 'PUT',
      url: '/api/inventory/policy',
      headers: headers('emp-owner'),
      payload: { ...payload, idempotencyKey: 'inventory-policy-auth-0002' },
    })
    expect(owner.statusCode).toBe(200)

    const ownerReceipt = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers('emp-owner'),
      payload: {
        productId: 'product-beer',
        unitCode: 'bottle',
        quantity: 6,
        reason: '所有者补充库存',
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'receipt-owner-manage-0001',
      },
    })
    expect(ownerReceipt.statusCode).toBe(201)
    await app.close()
    await repository.close()
  })

  it('enforces the approver cost limit before applying a stock-count variance', async () => {
    const { app, repository } = await fixture()
    const occurredAt = new Date().toISOString()
    const receipt = await app.inject({
      method: 'POST',
      url: '/api/inventory/receipts',
      headers: headers('emp-chen'),
      payload: {
        productId: 'product-beer', unitCode: 'bottle', quantity: 100,
        reason: '建立盘点账面库存', occurredAt, idempotencyKey: 'inventory-limit-receipt-0001',
      },
    })
    expect(receipt.statusCode).toBe(201)
    const count = await app.inject({
      method: 'POST',
      url: '/api/inventory/stock-counts',
      headers: headers('emp-mia'),
      payload: {
        productId: 'product-beer', unitCode: 'bottle', countedQuantity: 0,
        approvalId: 'approval-inventory-limit-0001', occurredAt,
        idempotencyKey: 'inventory-limit-count-0001',
      },
    })
    expect(count.statusCode, count.body).toBe(201)

    const denied = await app.inject({
      method: 'POST',
      url: `/api/inventory/stock-counts/${count.json().id}/decision`,
      headers: headers('emp-chen'),
      payload: {
        decision: 'confirm', approvalId: 'approval-inventory-limit-0001',
        reason: '经理确认大额差异', occurredAt: new Date(Date.now() + 1_000).toISOString(),
        idempotencyKey: 'inventory-limit-decision-0001',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED', operation: 'inventory.approve' })
    expect(denied.json().message).toContain('180000')

    const state = await repository.read()
    expect(state.inventoryDomain?.stockCounts.find((item) => item.id === count.json().id)?.status).toBe('pending_confirmation')
    await app.close()
    await repository.close()
  })

  it('requires a separately authorized approver for stored-bottle transfer', async () => {
    const { app, repository } = await fixture()
    const now = Date.now()
    const deposit = await app.inject({
      method: 'POST',
      url: '/api/inventory/bottles',
      headers: headers('emp-mia'),
      payload: {
        productId: 'product-beer',
        skuSnapshot: 'BEER-001',
        productNameSnapshot: '精酿啤酒',
        owner: { kind: 'member', memberId: 'member-amy' },
        capacityQuantity: 1000,
        unitCode: 'ml',
        expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
        tableSessionId: 'session-l01',
        orderId: 'order-l01',
        orderItemId: 'item-beer',
        reason: '客户确认存酒',
        occurredAt: new Date(now).toISOString(),
        idempotencyKey: 'bottle-deposit-api-0001',
      },
    })
    expect(deposit.statusCode).toBe(201)

    const selfApproved = await app.inject({
      method: 'POST',
      url: `/api/inventory/bottles/${deposit.json().id}/transfer`,
      headers: headers('emp-mia'),
      payload: {
        recipientOwner: { kind: 'member', memberId: 'member-li' },
        tableSessionId: 'session-l01',
        approvalId: 'approval-transfer-1',
        approvedBy: 'emp-mia',
        reason: '客户申请转赠',
        occurredAt: new Date(now + 1000).toISOString(),
        idempotencyKey: 'bottle-transfer-api-self',
      },
    })
    expect(selfApproved.statusCode).toBe(400)

    const transferred = await app.inject({
      method: 'POST',
      url: `/api/inventory/bottles/${deposit.json().id}/transfer`,
      headers: headers('emp-mia'),
      payload: {
        recipientOwner: { kind: 'member', memberId: 'member-li' },
        tableSessionId: 'session-l01',
        approvalId: 'approval-transfer-2',
        approvedBy: 'emp-chen',
        reason: '客户申请转赠并完成复核',
        occurredAt: new Date(now + 2000).toISOString(),
        idempotencyKey: 'bottle-transfer-api-0001',
      },
    })
    expect(transferred.statusCode).toBe(200)
    expect(transferred.json().owner).toMatchObject({ kind: 'member', memberId: 'member-li' })
    await app.close()
    await repository.close()
  })
})
