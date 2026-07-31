import { describe, expect, it } from 'vitest'
import {
  createEmployee,
  createProduct,
  createShift,
  updateArea,
  updateEmployee,
  updateProduct,
  updateTable,
} from './master-data.js'
import { serializeRuntimeState } from './postgres-repository.js'
import { createSeedState } from './seed.js'

describe('master data management', () => {
  it('creates an auditable employee with configured role and areas', () => {
    const state = createSeedState()
    const employee = createEmployee(state, {
      displayName: '新员工',
      initials: '新',
      status: 'active',
      roleId: 'backup',
      online: false,
      paused: false,
      areaIds: ['lounge'],
    }, 'manager-demo')

    expect(employee.id).toMatch(/^emp_/)
    expect(state.auditEntries.at(-1)?.action).toBe('employee.created.v1')
  })

  it('prevents deactivation while the employee owns an open task', () => {
    const state = createSeedState()
    state.tasks.push({
      id: 'task-open', tableId: 'table-l01', serviceTypeId: 'water', source: 'guest', note: '',
      status: 'accepted', priority: 'normal', ownerId: 'emp-lin', notifiedEmployeeIds: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acceptedAt: null,
      arrivedAt: null, completedAt: null, warningAt: new Date().toISOString(),
      escalateAt: new Date().toISOString(), managerAt: new Date().toISOString(), escalationLevel: 0,
      configVersion: 1, customerReply: '', actionScript: [], resolution: null,
    })
    const employee = state.employees.find((item) => item.id === 'emp-lin')!

    expect(() => updateEmployee(state, employee.id, { ...employee, status: 'inactive' }, 'manager-demo'))
      .toThrow('员工仍有未关闭任务')
  })

  it('saves an auditable personal high-frequency entry override within effective permissions', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-lin')!

    const updated = updateEmployee(state, employee.id, {
      ...employee,
      primaryNavigationIds: ['commerce', 'tasks'],
    }, 'emp-wu')

    expect(updated.primaryNavigationIds).toEqual(['commerce', 'tasks'])
    expect(state.auditEntries.at(-1)).toMatchObject({
      actorId: 'emp-wu',
      action: 'employee.updated.v1',
      objectId: employee.id,
      details: { after: { primaryNavigationIds: ['commerce', 'tasks'] } },
    })
  })

  it('rejects personal high-frequency entries outside effective permissions', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-lin')!

    expect(() => updateEmployee(state, employee.id, {
      ...employee,
      primaryNavigationIds: ['config'],
    }, 'emp-wu')).toThrow('高频入口超出该员工当前权限')
  })

  it('removes a personal override cleanly and keeps runtime state JSON serializable', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-lin')!
    employee.primaryNavigationIds = ['commerce', 'tasks']

    const updated = updateEmployee(state, employee.id, {
      ...employee,
      primaryNavigationIds: undefined,
    }, 'emp-wu')

    expect(Object.hasOwn(updated, 'primaryNavigationIds')).toBe(false)
    expect(() => serializeRuntimeState(state)).not.toThrow()
  })

  it('validates primary and backup table responsibility', () => {
    const state = createSeedState()
    const table = state.tables[0]!
    expect(() => updateTable(state, table.id, {
      displayName: table.displayName,
      areaId: table.areaId,
      capacity: table.capacity,
      status: table.status,
      primaryEmployeeId: 'emp-lin',
      backupEmployeeIds: ['emp-lin'],
    }, 'manager-demo')).toThrow('主责任人不能同时作为候补')
  })

  it('creates cross-midnight shifts and rejects overlaps', () => {
    const state = createSeedState()
    state.shiftAssignments = []
    const input = {
      employeeId: 'emp-lin', businessDate: '2026-07-14', startAt: '2026-07-14T11:00:00.000Z',
      endAt: '2026-07-14T19:00:00.000Z', roleId: 'server', areaIds: ['lounge'],
      isPrimary: true, status: 'active' as const,
    }
    createShift(state, input, 'manager-demo')
    expect(() => createShift(state, { ...input, startAt: '2026-07-14T12:00:00.000Z' }, 'manager-demo'))
      .toThrow('已有重叠班次')
  })

  it('updates area presentation without changing identity', () => {
    const state = createSeedState()
    const area = updateArea(state, 'lounge', {
      name: '大厅服务区', shortName: '大厅', color: '#1188aa', sortOrder: 2,
    }, 'manager-demo')
    expect(area.id).toBe('lounge')
    expect(area.name).toBe('大厅服务区')
  })

  it('versions product changes and rejects invalid cost', () => {
    const state = createSeedState()
    const product = createProduct(state, {
      sku: 'TEST-001', name: '测试商品', specification: '1份', listPriceAmount: 1000,
      costAmount: 300, stationId: 'bar-main', enabled: true,
    }, 'manager-demo')
    const updated = updateProduct(state, product.id, {
      sku: product.sku, name: product.name, specification: product.specification,
      listPriceAmount: 1200, costAmount: 400, stationId: product.stationId, enabled: true,
    }, 'manager-demo')
    expect(updated.configVersion).toBe(2)
    expect(() => updateProduct(state, product.id, {
      sku: product.sku, name: product.name, specification: product.specification,
      listPriceAmount: 500, costAmount: 600, stationId: product.stationId, enabled: true,
    }, 'manager-demo')).toThrow('商品成本不能高于标价')
  })

  it('classifies clear drink names and rejects unclassified guest drinks', () => {
    const state = createSeedState()
    const beer = createProduct(state, {
      sku: 'TEST-BEER-001', name: '测试精酿啤酒', specification: '330ml',
      categoryId: 'drinks', categoryName: '酒水', beverageFamily: 'none',
      listPriceAmount: 6800, costAmount: 1800, stationId: 'bar-main', enabled: true,
    }, 'manager-demo')
    expect(beer.beverageFamily).toBe('beer')

    expect(() => createProduct(state, {
      sku: 'TEST-DRINK-UNKNOWN', name: '当日限定饮品', specification: '1杯',
      categoryId: 'drinks', categoryName: '酒水', beverageFamily: 'none',
      listPriceAmount: 6800, costAmount: 1800, stationId: 'bar-main', enabled: true,
    }, 'manager-demo')).toThrow('客人可见的酒水商品必须选择酒水类型')
  })
})
