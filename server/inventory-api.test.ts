import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerAuthContext, signStaffSession } from './auth-context.js'
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

const sessionSecret = 'inventory-api-test-session-secret-32-characters'

async function signedFixture() {
  const repository = new JsonRepository(`/tmp/mbox-inventory-api-signed-${crypto.randomUUID()}.json`)
  await repository.init()
  const now = Date.now()
  await repository.mutate((state) => {
    state.presenceLeases = ['emp-qing', 'emp-chen'].map((actorId) => ({
      sessionId: `session-${actorId}`, actorId, storeId: state.store.id, businessDate: state.store.businessDate,
      establishedAt: now, lastSeenAt: now, expiresAt: now + 60_000, sessionExpiresAt: now + 60_000,
    }))
    state.revision += 1
  })
  const app = Fastify()
  await registerAuthContext(app, {
    runtimeMode: 'production',
    sessionSecret,
    readState: () => repository.read(),
  })
  registerInventoryRoutes(app, repository)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
    }
    return reply.status(400).send({ message: error.message })
  })
  return { app, repository }
}

function signedHeaders(actorId: string, now = Date.now()) {
  return {
    authorization: `Bearer ${signStaffSession({
      sessionId: `session-${actorId}`,
      actorId,
      storeId: 'mbox-lujiazui',
      issuedAt: now - 1000,
      expiresAt: now + 60_000,
    }, sessionSecret)}`,
  }
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

  it('configures ingredient units and recipe versions, then converts receipts to the base unit', async () => {
    const { app, repository } = await fixture()
    const occurredAt = new Date().toISOString()
    const ingredient = await app.inject({
      method: 'POST', url: '/api/inventory/ingredients', headers: headers('emp-chen'),
      payload: {
        sku: 'GIN-API-001', name: '测试金酒', baseUnitCode: 'ml', costAmountPerBaseUnit: 2,
        conversions: [{ unitCode: 'ml', baseQuantity: 1 }, { unitCode: 'bottle', baseQuantity: 750 }],
        enabled: true, reason: '建立测试原料', occurredAt, idempotencyKey: 'ingredient-api-create-0001',
      },
    })
    expect(ingredient.statusCode, ingredient.body).toBe(201)

    const receipt = await app.inject({
      method: 'POST', url: '/api/inventory/receipts', headers: headers('emp-chen'),
      payload: {
        productId: ingredient.json().id, unitCode: 'bottle', quantity: 2,
        reason: '两瓶原料验收入库', occurredAt, idempotencyKey: 'ingredient-api-receipt-0001',
      },
    })
    expect(receipt.statusCode, receipt.body).toBe(201)
    expect(receipt.json()).toMatchObject({ quantity: 1500, unitCode: 'ml', balanceAfter: 1500 })
    expect(receipt.json().configurationSnapshot).toMatchObject({
      kind: 'unit_conversion', inputQuantity: 2, inputUnitCode: 'bottle', conversion: { baseQuantity: 750 },
    })

    const recipe = await app.inject({
      method: 'POST', url: '/api/inventory/recipes', headers: headers('emp-chen'),
      payload: {
        productId: 'product-cocktail',
        lines: [{ ingredientSkuId: ingredient.json().id, standardQuantity: 45, allowedLossBps: 500 }],
        reason: '发布测试配方', occurredAt, idempotencyKey: 'recipe-api-publish-0001',
      },
    })
    expect(recipe.statusCode, recipe.body).toBe(201)
    expect(recipe.json()).toMatchObject({ productId: 'product-cocktail', version: 1, status: 'active' })
    expect((await repository.read()).inventoryDomain?.recipeVersions).toHaveLength(1)
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
      method: 'PUT', url: '/api/inventory/policy', headers: headers('emp-qing'), payload,
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

  it('persists per-item stock alert levels with permission checks and audit evidence', async () => {
    const { app, repository } = await fixture()
    const payload = {
      rules: [
        { itemId: 'product-beer', enabled: true, warningQuantity: 24 },
        { itemId: 'product-cocktail', enabled: false, warningQuantity: 10 },
      ],
      reason: '啤酒按一箱备货，鸡尾酒暂按原料监控',
      idempotencyKey: 'inventory-stock-alerts-0001',
    }
    const denied = await app.inject({
      method: 'PUT', url: '/api/inventory/stock-alerts', headers: headers('emp-qing'), payload,
    })
    expect(denied.statusCode).toBe(403)

    const updated = await app.inject({
      method: 'PUT', url: '/api/inventory/stock-alerts', headers: headers('emp-chen'), payload,
    })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject(payload.rules)

    const replay = await app.inject({
      method: 'PUT', url: '/api/inventory/stock-alerts', headers: headers('emp-chen'), payload,
    })
    expect(replay.statusCode).toBe(200)
    const state = await repository.read()
    expect(state.inventoryDomain?.stockAlertRules).toMatchObject(payload.rules)
    expect(state.auditEntries.filter((entry) => entry.action === 'inventory.stock_alerts.updated.v1')).toHaveLength(1)
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
      headers: headers('emp-qing'),
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

  it('keeps stored-bottle transfer pending until another authorized session approves it', async () => {
    const { app, repository } = await fixture()
    const now = Date.now()
    const deposit = await app.inject({
      method: 'POST',
      url: '/api/inventory/bottles',
      headers: headers('emp-qing'),
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

    const requested = await app.inject({
      method: 'POST',
      url: `/api/inventory/bottles/${deposit.json().id}/transfer`,
      headers: headers('emp-qing'),
      payload: {
        recipientOwner: { kind: 'member', memberId: 'member-li' },
        tableSessionId: 'session-l01',
        reason: '客户申请转赠',
        occurredAt: new Date(now + 1000).toISOString(),
        idempotencyKey: 'bottle-transfer-api-0001',
      },
    })
    expect(requested.statusCode).toBe(202)
    expect(requested.json()).toMatchObject({ action: 'bottle_transfer', status: 'pending' })
    expect((await repository.read()).inventoryDomain?.bottleBatches.find((item) => item.id === deposit.json().id)?.status).toBe('stored')

    const selfApproved = await app.inject({
      method: 'POST',
      url: `/api/inventory/approvals/${requested.json().id}/decision`,
      headers: headers('emp-qing'),
      payload: {
        decision: 'approve',
        reason: '本人尝试批准',
        occurredAt: new Date(now + 2000).toISOString(),
        idempotencyKey: 'bottle-transfer-decision-self',
      },
    })
    expect(selfApproved.statusCode).toBe(403)

    const approved = await app.inject({
      method: 'POST',
      url: `/api/inventory/approvals/${requested.json().id}/decision`,
      headers: headers('emp-chen'),
      payload: {
        decision: 'approve',
        reason: '经理核对客户确认记录后批准',
        occurredAt: new Date(now + 3000).toISOString(),
        idempotencyKey: 'bottle-transfer-decision-0001',
      },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ status: 'approved', decidedBy: { employeeId: 'emp-chen' } })
    expect(approved.json().beforeSnapshot).toMatchObject({ status: 'stored' })
    expect(approved.json().afterSnapshot).toMatchObject({ source: { status: 'transferred' }, recipient: { owner: { memberId: 'member-li' } } })
    await app.close()
    await repository.close()
  })

  it('records distinct signed sessions as the requester and approver', async () => {
    const { app, repository } = await signedFixture()
    const now = Date.now()
    const deposit = await app.inject({
      method: 'POST', url: '/api/inventory/bottles', headers: signedHeaders('emp-qing', now),
      payload: {
        productId: 'product-beer', skuSnapshot: 'BEER-001', productNameSnapshot: '精酿啤酒',
        owner: { kind: 'member', memberId: 'member-amy' }, capacityQuantity: 500, unitCode: 'ml',
        expiresAt: new Date(now + 86_400_000).toISOString(), tableSessionId: 'session-l01',
        orderId: 'order-l01', orderItemId: 'item-beer', reason: '客户确认存酒',
        occurredAt: new Date(now).toISOString(), idempotencyKey: 'signed-bottle-deposit-0001',
      },
    })
    expect(deposit.statusCode, deposit.body).toBe(201)
    const requested = await app.inject({
      method: 'POST', url: `/api/inventory/bottles/${deposit.json().id}/void`, headers: signedHeaders('emp-qing', now),
      payload: {
        reason: '发现登记批次错误，申请作废', occurredAt: new Date(now + 1000).toISOString(),
        idempotencyKey: 'signed-bottle-void-request-0001',
      },
    })
    expect(requested.statusCode, requested.body).toBe(202)
    expect(requested.json().requestedBy).toMatchObject({ employeeId: 'emp-qing', authenticatedBy: 'signed_session' })

    const approved = await app.inject({
      method: 'POST', url: `/api/inventory/approvals/${requested.json().id}/decision`, headers: signedHeaders('emp-chen', now),
      payload: {
        decision: 'approve', reason: '核对原订单与客户记录后批准',
        occurredAt: new Date(now + 2000).toISOString(), idempotencyKey: 'signed-bottle-void-decision-0001',
      },
    })
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json()).toMatchObject({
      status: 'approved',
      requestedBy: { employeeId: 'emp-qing', authenticatedBy: 'signed_session' },
      decidedBy: { employeeId: 'emp-chen', authenticatedBy: 'signed_session' },
    })
    await app.close()
    await repository.close()
  })
})
