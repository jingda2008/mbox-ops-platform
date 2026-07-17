import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { StoreImportPackage } from '../src/shared/store-import-contracts.js'
import { registerAuthContext, signStaffSession } from './auth-context.js'
import { AuthorizationError } from './authorization.js'
import { registerStoreImportRoutes } from './store-import-api.js'
import { StoreImportValidationError } from './store-import.js'
import { JsonRepository } from './repository.js'

const sessionSecret = 'store-import-approval-session-secret-32-characters'

function signedHeaders(actorId: string, now = Date.now()) {
  return {
    authorization: `Bearer ${signStaffSession({
      sessionId: `session-${actorId}`, actorId, storeId: 'mbox-lujiazui', issuedAt: now - 1000, expiresAt: now + 60_000,
    }, sessionSecret)}`,
  }
}

function importPackage(state: RuntimeState, now: number): StoreImportPackage {
  const createdAt = new Date(now - 1000).toISOString()
  return {
    schemaVersion: 1,
    packageId: `approval-import-${now}`,
    packageVersion: 1,
    targetStoreId: state.store.id,
    createdAt,
    source: { sourceSystem: 'test', sourceReference: `signed/${now}`, preparedBy: 'test-suite' },
    declaredMissingData: [],
    policy: {
      target: 'sandbox',
      sections: {
        store: { completeness: 'complete' }, config: { completeness: 'complete' },
        areas: { mode: 'upsert', completeness: 'complete' }, tables: { mode: 'upsert', completeness: 'complete' },
        employees: { mode: 'upsert', completeness: 'complete' }, shiftAssignments: { mode: 'upsert', completeness: 'complete' },
        products: { mode: 'upsert', completeness: 'complete' }, authorizationAuthorities: { mode: 'upsert', completeness: 'complete' },
      },
      responsibilityRoles: {
        primaryRoleIds: ['server'], backupRoleIds: ['backup'], supervisorRoleIds: ['supervisor'], managerRoleIds: ['manager'],
      },
      requireShiftRoleMatchEmployeeRole: true,
      allowZeroListPrice: false,
    },
    data: {
      store: { ...state.store, name: `${state.store.name} 审批导入` },
      config: {
        version: state.config.version + 1,
        status: 'published',
        publishedAt: createdAt,
        serviceTypes: state.config.serviceTypes.map((item) => ({
          id: item.id, code: item.code, name: item.name, icon: item.icon, enabled: item.enabled,
          priority: item.priority, dispatchRoleIds: item.dispatchRoleIds, sla: item.sla,
          customerReply: item.customerReply, actionScript: item.actionScript,
        })),
        roles: state.config.roles.map((item) => ({
          id: item.id, name: item.name, maxConcurrentTasks: item.maxConcurrentTasks,
          canReceiveTasks: item.canReceiveTasks, permissionIds: item.permissionIds,
          dataScope: item.dataScope, approvalLimits: item.approvalLimits,
        })),
        proactiveOrderCare: state.config.proactiveOrderCare,
        guestServiceLimits: state.config.guestServiceLimits,
      },
      areas: state.areas.map((item) => ({
        id: item.id, name: item.name, shortName: item.shortName, color: item.color, sortOrder: item.sortOrder,
      })),
      tables: state.tables.map((item) => ({
        id: item.id, code: item.code, displayName: item.displayName, areaId: item.areaId, capacity: item.capacity,
        status: item.status, primaryEmployeeId: item.primaryEmployeeId, backupEmployeeIds: item.backupEmployeeIds,
        guestCount: item.guestCount, openedAt: item.openedAt,
      })),
      employees: state.employees.map((item) => ({
        id: item.id, displayName: item.displayName, initials: item.initials, status: item.status,
        roleId: item.roleId, online: item.online, paused: item.paused, areaIds: item.areaIds,
      })),
      shiftAssignments: state.shiftAssignments.filter((item) => item.areaIds.length > 0).map((item) => ({
        id: item.id, employeeId: item.employeeId, businessDate: item.businessDate, startAt: item.startAt,
        endAt: item.endAt, roleId: item.roleId, areaIds: item.areaIds, isPrimary: item.isPrimary, status: item.status,
      })),
      products: state.products.map((item) => ({
        id: item.id, sku: item.sku, name: item.name, specification: item.specification,
        categoryId: item.categoryId, categoryName: item.categoryName, description: item.description,
        imageUrl: item.imageUrl, tags: item.tags, sortOrder: item.sortOrder, soldOut: item.soldOut,
        soldOutReason: item.soldOutReason, availableFrom: item.availableFrom, availableUntil: item.availableUntil,
        listPriceAmount: item.listPriceAmount, costAmount: item.costAmount, stationId: item.stationId,
        enabled: item.enabled, configVersion: state.config.version + 1,
      })),
      authorizationAuthorities: [{
        id: `authority-import-${now}`, actorId: 'emp-chen', kinds: ['discount', 'gift'], maxAmount: 100_000,
        allowedSkuIds: [state.products[0]!.id], tableSessionIds: null,
        validFrom: new Date(now - 2000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
        approval: {
          operationsApproverId: 'ops-director', financeApproverId: 'finance-director',
          approvedAt: new Date(now - 2000).toISOString(), reason: '测试联合审批',
        },
      }],
    },
  }
}

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-store-import-approval-${crypto.randomUUID()}.json`)
  await repository.init()
  await repository.mutate((state) => {
    const areaId = 'approval-area'
    state.areas = [{ id: areaId, name: '审批测试区', shortName: '审批', color: '#169bd5', sortOrder: 1 }]
    const selected = ['emp-owner', 'emp-lin', 'emp-jie', 'emp-qing', 'emp-chen']
    state.employees = state.employees.filter((item) => selected.includes(item.id)).map((item) => ({
      ...item,
      roleId: item.id === 'emp-qing' ? 'supervisor' : item.roleId,
      roleIds: item.id === 'emp-qing' ? [] : item.roleIds,
      areaIds: item.id === 'emp-owner' ? [] : [areaId],
    }))
    state.tables = [{
      id: 'approval-table', code: 'AP01', displayName: '审批测试桌', areaId, capacity: 4,
      status: 'available', primaryEmployeeId: 'emp-lin', backupEmployeeIds: ['emp-jie'],
      guestCount: 0, openedAt: null,
    }]
    const shiftActors = [
      ['emp-lin', 'server', true], ['emp-jie', 'backup', false],
      ['emp-qing', 'supervisor', false], ['emp-chen', 'manager', false],
    ] as const
    state.shiftAssignments = shiftActors.map(([employeeId, roleId, isPrimary]) => ({
      id: `approval-shift-${employeeId}`, employeeId, businessDate: state.store.businessDate,
      startAt: `${state.store.businessDate}T10:00:00+08:00`, endAt: `${state.store.businessDate}T23:00:00+08:00`,
      roleId, areaIds: [areaId], stationIds: [], isPrimary, status: 'scheduled',
    }))
    state.products = [state.products[0]!]
    state.tasks = []
    state.awaitingOrderIntents = []
    state.waitlistEntries = []
    state.tableTransfers = []
    state.members = []
    state.benefitTemplates = []
    state.benefitGrantPolicies = []
    state.orderDomain.orders = []
    state.orderDomain.authorizations = []
    state.orderDomain.authorizationAuthorities = []
    state.orderDomain.kdsTasks = []
    state.orderDomain.tableLedgerEntries = []
    state.songState.tableSessions = []
    state.songState.requests = []
    state.songState.managerActorIds = []
    const sessionNow = Date.now()
    state.presenceLeases = ['emp-chen', 'emp-owner'].map((actorId) => ({
      sessionId: `session-${actorId}`, actorId, storeId: state.store.id, businessDate: state.store.businessDate,
      establishedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionNow + 60_000, sessionExpiresAt: sessionNow + 60_000,
    }))
    state.revision += 1
  })
  const app = Fastify()
  await registerAuthContext(app, {
    runtimeMode: 'production', sessionSecret, readState: () => repository.read(),
  })
  registerStoreImportRoutes(app, repository)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) return reply.status(error.statusCode).send({ message: error.message })
    if (error instanceof StoreImportValidationError) return reply.status(422).send({ message: error.message, issues: error.issues })
    return reply.status(400).send({ message: error.message })
  })
  return { app, repository }
}

describe('store import dual approval', () => {
  it('does not apply until a second authorized signed session approves', async () => {
    const { app, repository } = await fixture()
    const now = Date.now()
    const before = await repository.read()
    const input = importPackage(before, now)
    const requested = await app.inject({
      method: 'POST', url: '/api/store-import/apply', headers: signedHeaders('emp-chen', now),
      payload: { package: input, reason: '申请应用已预检的整店资料', occurredAt: new Date(now).toISOString(), idempotencyKey: 'store-import-request-approval-0001' },
    })
    expect(requested.statusCode, requested.body).toBe(202)
    expect(requested.json().approval).toMatchObject({
      action: 'store_import', status: 'pending',
      requestedBy: { employeeId: 'emp-chen', authenticatedBy: 'signed_session' },
    })
    expect((await repository.read()).store.name).toBe(before.store.name)

    const selfDecision = await app.inject({
      method: 'POST', url: `/api/store-import/approvals/${requested.json().approval.id}/decision`,
      headers: signedHeaders('emp-chen', now),
      payload: { decision: 'approve', reason: '本人尝试批准', occurredAt: new Date(now + 1000).toISOString(), idempotencyKey: 'store-import-self-decision-0001' },
    })
    expect(selfDecision.statusCode).toBe(400)
    expect((await repository.read()).store.name).toBe(before.store.name)

    const approved = await app.inject({
      method: 'POST', url: `/api/store-import/approvals/${requested.json().approval.id}/decision`,
      headers: signedHeaders('emp-owner', now),
      payload: { decision: 'approve', reason: '老板复核预检差异后批准', occurredAt: new Date(now + 2000).toISOString(), idempotencyKey: 'store-import-owner-decision-0001' },
    })
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json().approval).toMatchObject({
      status: 'approved',
      requestedBy: { employeeId: 'emp-chen', authenticatedBy: 'signed_session' },
      decidedBy: { employeeId: 'emp-owner', authenticatedBy: 'signed_session' },
    })
    expect(approved.json().approval.beforeSnapshot.store.name).toBe(before.store.name)
    expect(approved.json().approval.afterSnapshot.store.name).toContain('审批导入')
    expect((await repository.read()).store.name).toContain('审批导入')
    await app.close()
    await repository.close()
  })
})
