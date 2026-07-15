import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { StoreImportPackage } from '../src/shared/store-import-contracts.js'
import { createSeedState } from './seed.js'
import {
  applyStoreImportPackage,
  preflightStoreImportPackage,
  StoreImportValidationError,
} from './store-import.js'

const businessDate = '2026-07-14'
const packageCreatedAt = '2026-07-14T10:00:00.000Z'

function sourceState(): RuntimeState {
  const state = createSeedState()
  state.store.businessDate = businessDate
  state.tasks = []
  state.awaitingOrderIntents = []
  state.members = []
  state.benefitTemplates = []
  state.benefitGrantPolicies = []
  state.orderDomain.orders = []
  state.orderDomain.authorizations = []
  state.orderDomain.kdsTasks = []
  state.orderDomain.tableLedgerEntries = []
  state.songState.tableSessions = []
  state.songState.requests = []
  state.songState.managerActorIds = []
  return state
}

function completePackage(): StoreImportPackage {
  return {
    schemaVersion: 1,
    packageId: 'store-import-test',
    packageVersion: 1,
    targetStoreId: 'mbox-lujiazui',
    createdAt: packageCreatedAt,
    source: {
      sourceSystem: 'implementation-workbook',
      sourceReference: 'signed/test-store-v1',
      preparedBy: 'implementation-consultant',
    },
    declaredMissingData: [],
    policy: {
      target: 'production',
      sections: {
        store: { completeness: 'complete' },
        config: { completeness: 'complete' },
        areas: { mode: 'replace', completeness: 'complete' },
        tables: { mode: 'replace', completeness: 'complete' },
        employees: { mode: 'replace', completeness: 'complete' },
        shiftAssignments: { mode: 'replace', completeness: 'complete' },
        products: { mode: 'replace', completeness: 'complete' },
        authorizationAuthorities: { mode: 'replace', completeness: 'complete' },
      },
      responsibilityRoles: {
        primaryRoleIds: ['server'],
        backupRoleIds: ['backup'],
        supervisorRoleIds: ['supervisor'],
        managerRoleIds: ['manager'],
      },
      requireShiftRoleMatchEmployeeRole: true,
      allowZeroListPrice: false,
    },
    data: {
      store: {
        id: 'mbox-lujiazui',
        name: 'M-Box 测试门店正式资料',
        businessDate,
        timezone: 'Asia/Shanghai',
      },
      config: {
        version: 2,
        status: 'published',
        publishedAt: '2026-07-14T09:00:00.000Z',
        roles: [
          { id: 'server', name: '主服务员', maxConcurrentTasks: 2, canReceiveTasks: true },
          { id: 'backup', name: '区域候补', maxConcurrentTasks: 3, canReceiveTasks: true },
          { id: 'supervisor', name: '领班', maxConcurrentTasks: 5, canReceiveTasks: true },
          { id: 'manager', name: '值班经理', maxConcurrentTasks: 8, canReceiveTasks: true },
        ],
        serviceTypes: [{
          id: 'water',
          code: 'ADD_WATER',
          name: '加水',
          icon: 'water',
          enabled: true,
          priority: 'normal',
          dispatchRoleIds: ['server', 'backup', 'supervisor', 'manager'],
          sla: { warningSeconds: 30, escalateSeconds: 60, managerSeconds: 120 },
          customerReply: '已收到，服务人员正在处理。',
          actionScript: ['确认需求', '完成服务', '离桌前复核'],
        }],
        proactiveOrderCare: {
          enabled: true,
          firstReminderSeconds: 300,
          repeatReminderSeconds: 300,
          maxReminders: 3,
          serviceTypeId: 'water',
        },
        guestServiceLimits: {
          windowSeconds: 60,
          maxRequests: 5,
          duplicateSeconds: 60,
        },
      },
      areas: [{ id: 'area-a', name: 'A区', shortName: 'A区', color: '#169bd5', sortOrder: 1 }],
      employees: [
        { id: 'emp-primary', displayName: '主责测试', initials: '主', status: 'active', roleId: 'server', online: false, paused: false, areaIds: ['area-a'] },
        { id: 'emp-backup', displayName: '候补测试', initials: '候', status: 'active', roleId: 'backup', online: false, paused: false, areaIds: ['area-a'] },
        { id: 'emp-supervisor', displayName: '领班测试', initials: '领', status: 'active', roleId: 'supervisor', online: false, paused: false, areaIds: ['area-a'] },
        { id: 'emp-manager', displayName: '经理测试', initials: '经', status: 'active', roleId: 'manager', online: false, paused: false, areaIds: ['area-a'] },
      ],
      shiftAssignments: [
        { id: 'shift-primary', employeeId: 'emp-primary', businessDate, startAt: '2026-07-14T11:00:00.000Z', endAt: '2026-07-14T19:00:00.000Z', roleId: 'server', areaIds: ['area-a'], isPrimary: true, status: 'scheduled' },
        { id: 'shift-backup', employeeId: 'emp-backup', businessDate, startAt: '2026-07-14T11:00:00.000Z', endAt: '2026-07-14T19:00:00.000Z', roleId: 'backup', areaIds: ['area-a'], isPrimary: false, status: 'scheduled' },
        { id: 'shift-supervisor', employeeId: 'emp-supervisor', businessDate, startAt: '2026-07-14T11:00:00.000Z', endAt: '2026-07-14T19:00:00.000Z', roleId: 'supervisor', areaIds: ['area-a'], isPrimary: false, status: 'scheduled' },
        { id: 'shift-manager', employeeId: 'emp-manager', businessDate, startAt: '2026-07-14T11:00:00.000Z', endAt: '2026-07-14T19:00:00.000Z', roleId: 'manager', areaIds: ['area-a'], isPrimary: false, status: 'scheduled' },
      ],
      tables: [{
        id: 'table-a01', code: 'A01', displayName: 'A区01', areaId: 'area-a', capacity: 4,
        status: 'available', primaryEmployeeId: 'emp-primary', backupEmployeeIds: ['emp-backup'],
        guestCount: 0, openedAt: null,
      }],
      products: [{
        id: 'product-water', sku: 'WATER-001', name: '瓶装水', specification: '500ml',
        listPriceAmount: 2800, costAmount: 300, stationId: 'bar-main', enabled: true, configVersion: 2,
      }],
      authorizationAuthorities: [{
        id: 'authority-manager', actorId: 'emp-manager', kinds: ['discount', 'gift'], maxAmount: 100_000,
        allowedSkuIds: ['product-water'], tableSessionIds: null,
        validFrom: '2026-07-14T10:00:00.000Z', validUntil: '2026-07-14T20:00:00.000Z',
        approval: {
          operationsApproverId: 'ops-director',
          financeApproverId: 'finance-director',
          approvedAt: '2026-07-14T08:00:00.000Z',
          reason: '测试门店经营权限联合审批',
        },
      }],
    },
  }
}

function extendedPackage() {
  const input = structuredClone(completePackage()) as unknown as Record<string, unknown>
  const data = input.data as Record<string, unknown>
  const config = data.config as Record<string, unknown>
  const serviceTypes = config.serviceTypes as Array<Record<string, unknown>>
  const employees = data.employees as Array<Record<string, unknown>>
  const shifts = data.shiftAssignments as Array<Record<string, unknown>>
  config.skills = [{ id: 'skill-water', name: '饮品出品', enabled: true }]
  serviceTypes.push({
    id: 'fulfillment-delivery', code: 'FULFILLMENT_DELIVERY', name: '出品取送', icon: 'order',
    enabled: true, guestVisible: false, priority: 'normal',
    dispatchRoleIds: ['server', 'backup', 'supervisor', 'manager'],
    sla: { warningSeconds: 30, escalateSeconds: 60, managerSeconds: 120 },
    customerReply: '出品已完成，服务人员正在取送。',
    actionScript: ['取货并核对桌号', '送达后确认'],
  })
  config.workstations = [{
    id: 'bar-main', name: '测试吧台', kind: 'hybrid', enabled: true,
    productionRoleIds: ['server', 'supervisor', 'manager'],
    deliveryRoleIds: ['backup', 'supervisor', 'manager'],
    requiredSkillIds: ['skill-water'], productionSlaSeconds: 120, pickupSlaSeconds: 45,
    deliveryServiceTypeId: 'fulfillment-delivery', fallbackStationId: null,
  }]
  employees[0]!.skillIds = ['skill-water']
  shifts[0]!.stationIds = ['bar-main']
  return input
}

describe('store import preflight', () => {
  it('accepts workstation, skill, assignment and guest visibility extensions', () => {
    const result = preflightStoreImportPackage(sourceState(), extendedPackage())

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('rejects using a guest service type for automatic fulfillment delivery', () => {
    const input = extendedPackage()
    const data = input.data as Record<string, unknown>
    const config = data.config as Record<string, unknown>
    const workstations = config.workstations as Array<Record<string, unknown>>
    workstations[0]!.deliveryServiceTypeId = 'water'

    const result = preflightStoreImportPackage(sourceState(), input)

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'WORKSTATION_DELIVERY_SERVICE_INVALID', section: 'config',
    }))
  })

  it('rejects products that reference a workstation omitted by explicit configuration', () => {
    const input = extendedPackage()
    const data = input.data as Record<string, unknown>
    const config = data.config as Record<string, unknown>
    const workstations = config.workstations as Array<Record<string, unknown>>
    workstations[0]!.id = 'another-station'

    const result = preflightStoreImportPackage(sourceState(), input)

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'WORKSTATION_REFERENCE_MISSING', section: 'products', field: 'stationId',
    }))
  })

  it('locates schema errors at section, row and field without creating a preview', () => {
    const input = completePackage() as unknown as Record<string, unknown>
    const data = input.data as Record<string, unknown>
    const products = data.products as Array<Record<string, unknown>>
    delete products[0]!.listPriceAmount

    const result = preflightStoreImportPackage(sourceState(), input)

    expect(result.valid).toBe(false)
    expect(result.preview).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'SCHEMA_INVALID', section: 'products', row: 1, field: 'listPriceAmount',
    }))
  })

  it('reports uniqueness, reference, shift, price, responsibility and permission errors together', () => {
    const state = sourceState()
    const input = completePackage()
    input.data.tables.push({ ...input.data.tables[0]!, id: 'table-a02', areaId: 'missing-area' })
    input.data.shiftAssignments.push({
      ...input.data.shiftAssignments[0]!,
      id: 'shift-primary-overlap',
      startAt: '2026-07-14T12:00:00.000Z',
    })
    input.data.products[0]!.costAmount = 3000
    input.data.authorizationAuthorities[0]!.allowedSkuIds = ['missing-product']
    input.data.authorizationAuthorities[0]!.approval.financeApproverId = 'ops-director'
    input.data.shiftAssignments = input.data.shiftAssignments.filter((shift) => shift.roleId !== 'manager')
    const before = structuredClone(state)

    const result = preflightStoreImportPackage(state, input)
    const codes = new Set(result.issues.map((issue) => issue.code))

    expect(result.preview).not.toBeNull()
    expect(codes).toEqual(expect.objectContaining(new Set([
      'DUPLICATE_VALUE',
      'AREA_REFERENCE_MISSING',
      'SHIFT_OVERLAP',
      'PRODUCT_COST_EXCEEDS_PRICE',
      'RESPONSIBILITY_CHAIN_INCOMPLETE',
      'PRODUCT_REFERENCE_MISSING',
      'AUTHORITY_APPROVAL_NOT_SEPARATED',
    ])))
    expect(state).toEqual(before)
  })

  it('blocks partial replace and allows an explicitly declared partial sandbox upsert with warnings', () => {
    const first = applyStoreImportPackage(sourceState(), completePackage(), {
      actorId: 'implementation-admin',
      occurredAt: '2026-07-14T10:30:00.000Z',
      reason: '建立已校验的测试基线',
    })
    const partial = completePackage()
    partial.packageVersion = 2
    partial.policy.target = 'sandbox'
    partial.policy.sections.tables.completeness = 'partial'
    partial.declaredMissingData = ['桌台清单仍缺少C区、K区和W区，不是正式全店数据']

    const blocked = preflightStoreImportPackage(first.state, partial)
    expect(blocked.issues.some((issue) => issue.code === 'INCOMPLETE_REPLACE_FORBIDDEN')).toBe(true)

    partial.policy.sections.tables.mode = 'upsert'
    const warned = preflightStoreImportPackage(first.state, partial)
    expect(warned.valid).toBe(true)
    expect(warned.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'SECTION_INCOMPLETE', section: 'tables' }),
      expect.objectContaining({ severity: 'warning', code: 'DECLARED_MISSING_DATA' }),
    ]))
  })

  it('revalidates preserved authorities after another section replaces their referenced products', () => {
    const first = applyStoreImportPackage(sourceState(), completePackage(), {
      actorId: 'implementation-admin',
      occurredAt: '2026-07-14T10:30:00.000Z',
      reason: '建立权限引用测试基线',
    })
    first.state.products.push({
      id: 'legacy-product', sku: 'LEGACY-001', name: '旧商品', specification: '1份',
      listPriceAmount: 1000, costAmount: 100, stationId: 'bar-main', enabled: true, configVersion: 2,
    })
    first.state.orderDomain.authorizationAuthorities.push({
      id: 'legacy-authority', actorId: 'emp-supervisor', kinds: ['gift'], maxAmount: 1000,
      allowedSkuIds: ['legacy-product'], tableSessionIds: null,
      validFrom: '2026-07-14T10:00:00.000Z', validUntil: '2026-07-14T20:00:00.000Z',
    })
    const next = completePackage()
    next.packageVersion = 2
    next.policy.sections.authorizationAuthorities.mode = 'upsert'

    const result = preflightStoreImportPackage(first.state, next)

    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'PRODUCT_REFERENCE_MISSING',
      section: 'authorizationAuthorities',
    }))
  })
})

describe('atomic store import application', () => {
  it('returns a cloned state, records config history and advances revision exactly once', () => {
    const state = sourceState()
    const before = structuredClone(state)
    const result = applyStoreImportPackage(state, completePackage(), {
      actorId: 'implementation-admin',
      occurredAt: '2026-07-14T10:30:00.000Z',
      reason: '导入经营与财务共同确认的门店资料',
    })

    expect(state).toEqual(before)
    expect(result.state).not.toBe(state)
    expect(result.state.revision).toBe(state.revision + 1)
    expect(result.state.areas.map((area) => area.id)).toEqual(['area-a'])
    expect(result.state.tables.map((table) => table.code)).toEqual(['A01'])
    expect(result.state.config.version).toBe(2)
    expect(result.state.config.skills).toEqual([])
    expect(result.state.config.workstations).toEqual([
      expect.objectContaining({ id: 'bar-main', kind: 'hybrid', deliveryServiceTypeId: null }),
    ])
    expect(result.state.configVersions.at(-1)).toMatchObject({
      storeId: 'mbox-lujiazui', version: 2, operation: 'publish', sourceVersion: 1,
      actorId: 'implementation-admin',
    })
    expect(result.auditEntry).toMatchObject({
      action: 'store.master_data_imported.v1',
      objectId: 'mbox-lujiazui',
      details: { packageId: 'store-import-test', packageVersion: 1, warningCount: 0 },
    })
    expect(result.preview.areas).toMatchObject({ added: 1, removed: 5 })
    expect(result.preview.config.updated).toBe(1)
  })

  it('applies extended routing data without mutating the import package', () => {
    const input = extendedPackage()
    const before = structuredClone(input)
    const result = applyStoreImportPackage(sourceState(), input, {
      actorId: 'implementation-admin',
      occurredAt: '2026-07-14T10:30:00.000Z',
      reason: '导入工作站技能和岗位路由',
    })

    expect(input).toEqual(before)
    expect(result.state.config.serviceTypes.find((type) => type.id === 'fulfillment-delivery')?.guestVisible).toBe(false)
    expect(result.state.config.skills).toEqual([{ id: 'skill-water', name: '饮品出品', enabled: true }])
    expect(result.state.config.workstations[0]).toMatchObject({
      id: 'bar-main', requiredSkillIds: ['skill-water'], deliveryRoleIds: ['backup', 'supervisor', 'manager'],
    })
    expect(result.state.employees[0]?.skillIds).toEqual(['skill-water'])
    expect(result.state.shiftAssignments[0]?.stationIds).toEqual(['bar-main'])
  })

  it('throws before cloning/applying when preflight has blocking errors', () => {
    const state = sourceState()
    const input = completePackage()
    input.data.tables[0]!.backupEmployeeIds = ['emp-primary']
    const before = structuredClone(state)

    expect(() => applyStoreImportPackage(state, input, {
      actorId: 'implementation-admin',
      occurredAt: '2026-07-14T10:30:00.000Z',
      reason: '该导入应被预检阻断',
    })).toThrow(StoreImportValidationError)
    expect(state).toEqual(before)
  })
})
