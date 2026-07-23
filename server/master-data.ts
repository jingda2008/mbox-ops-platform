import { randomUUID } from 'node:crypto'
import type {
  AreaWriteInput,
  EmployeeWriteInput,
  ProductWriteInput,
  RuntimeState,
  ShiftAssignment,
  ShiftWriteInput,
  TableWriteInput,
} from '../src/shared/contracts.js'
import type { AuthorityWriteInput } from '../src/shared/commerce-api.js'

function audit(
  state: RuntimeState,
  actorId: string,
  action: string,
  objectType: string,
  objectId: string,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType,
    objectId,
    occurredAt: new Date().toISOString(),
    details,
  })
  state.revision += 1
}

function assertRole(state: RuntimeState, roleId: string) {
  if (!state.config.roles.some((role) => role.id === roleId)) throw new Error('岗位不存在')
}

function normalizedRoleIds(roleId: string, roleIds: string[] | undefined) {
  return [...new Set(roleIds ?? [])].filter((id) => id !== roleId)
}

function assertRoles(state: RuntimeState, roleId: string, roleIds: string[] | undefined) {
  const normalized = normalizedRoleIds(roleId, roleIds)
  ;[roleId, ...normalized].forEach((id) => assertRole(state, id))
  return normalized
}

function assertAreas(state: RuntimeState, areaIds: string[]) {
  const unique = new Set(areaIds)
  if (unique.size !== areaIds.length) throw new Error('责任区不能重复')
  if (areaIds.some((areaId) => !state.areas.some((area) => area.id === areaId))) throw new Error('责任区不存在')
}

export function createEmployee(state: RuntimeState, input: EmployeeWriteInput, actorId: string) {
  const roleIds = assertRoles(state, input.roleId, input.roleIds)
  assertAreas(state, input.areaIds)
  if (state.employees.some((employee) => employee.displayName === input.displayName && employee.status === 'active')) {
    throw new Error('已有同名在职员工')
  }
  const employee = { id: `emp_${randomUUID()}`, ...input, roleIds, permissionIds: [...new Set(input.permissionIds ?? [])] }
  state.employees.push(employee)
  audit(state, actorId, 'employee.created.v1', 'employee', employee.id, { after: employee })
  return employee
}

export function updateEmployee(
  state: RuntimeState,
  employeeId: string,
  input: EmployeeWriteInput,
  actorId: string,
) {
  const employee = state.employees.find((item) => item.id === employeeId)
  if (!employee) throw new Error('员工不存在')
  const roleIds = assertRoles(state, input.roleId, input.roleIds)
  assertAreas(state, input.areaIds)
  if (
    input.status === 'inactive' &&
    state.tasks.some((task) => task.ownerId === employeeId && !['completed', 'confirmed', 'cancelled'].includes(task.status))
  ) {
    throw new Error('员工仍有未关闭任务，不能停用')
  }
  const before = structuredClone(employee)
  Object.assign(employee, input, { roleIds, permissionIds: [...new Set(input.permissionIds ?? [])] })
  if (employee.status === 'inactive') {
    employee.online = false
    employee.paused = true
  }
  audit(state, actorId, 'employee.updated.v1', 'employee', employee.id, { before, after: employee })
  return employee
}

export function updateTable(
  state: RuntimeState,
  tableId: string,
  input: TableWriteInput,
  actorId: string,
) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) throw new Error('桌台不存在')
  if (!state.areas.some((area) => area.id === input.areaId)) throw new Error('区域不存在')
  const primary = state.employees.find((employee) => employee.id === input.primaryEmployeeId)
  if (!primary || primary.status !== 'active') throw new Error('主责任人不存在或已停用')
  const backups = Array.from(new Set(input.backupEmployeeIds))
  if (backups.includes(input.primaryEmployeeId)) throw new Error('主责任人不能同时作为候补')
  if (backups.some((id) => !state.employees.some((employee) => employee.id === id && employee.status === 'active'))) {
    throw new Error('候补人员不存在或已停用')
  }
  const before = structuredClone(table)
  Object.assign(table, input, { backupEmployeeIds: backups })
  audit(state, actorId, 'table.updated.v1', 'table', table.id, { before, after: table })
  return table
}

function validateShift(state: RuntimeState, input: ShiftWriteInput) {
  const employee = state.employees.find((item) => item.id === input.employeeId)
  if (!employee || employee.status !== 'active') throw new Error('排班员工不存在或已停用')
  assertRoles(state, input.roleId, input.roleIds)
  assertAreas(state, input.areaIds)
  if (new Date(input.startAt) >= new Date(input.endAt)) throw new Error('班次结束时间必须晚于开始时间')
}

export function createShift(state: RuntimeState, input: ShiftWriteInput, actorId: string) {
  validateShift(state, input)
  const overlapping = state.shiftAssignments.some(
    (shift) =>
      shift.employeeId === input.employeeId &&
      shift.status !== 'cancelled' &&
      new Date(shift.startAt) < new Date(input.endAt) &&
      new Date(shift.endAt) > new Date(input.startAt),
  )
  if (overlapping) throw new Error('该员工已有重叠班次')
  const shift: ShiftAssignment = { id: `shift_${randomUUID()}`, ...input, roleIds: normalizedRoleIds(input.roleId, input.roleIds) }
  state.shiftAssignments.push(shift)
  audit(state, actorId, 'shift.created.v1', 'shiftAssignment', shift.id, { after: shift })
  return shift
}

export function updateShift(
  state: RuntimeState,
  shiftId: string,
  input: ShiftWriteInput,
  actorId: string,
) {
  const shift = state.shiftAssignments.find((item) => item.id === shiftId)
  if (!shift) throw new Error('班次不存在')
  validateShift(state, input)
  const overlapping = state.shiftAssignments.some(
    (item) =>
      item.id !== shiftId &&
      item.employeeId === input.employeeId &&
      item.status !== 'cancelled' &&
      new Date(item.startAt) < new Date(input.endAt) &&
      new Date(item.endAt) > new Date(input.startAt),
  )
  if (overlapping) throw new Error('该员工已有重叠班次')
  const before = structuredClone(shift)
  Object.assign(shift, input, { roleIds: normalizedRoleIds(input.roleId, input.roleIds) })
  audit(state, actorId, 'shift.updated.v1', 'shiftAssignment', shift.id, { before, after: shift })
  return shift
}

export function updateArea(state: RuntimeState, areaId: string, input: AreaWriteInput, actorId: string) {
  const area = state.areas.find((item) => item.id === areaId)
  if (!area) throw new Error('区域不存在')
  const before = structuredClone(area)
  Object.assign(area, input)
  audit(state, actorId, 'area.updated.v1', 'area', area.id, { before, after: area })
  return area
}

export function createProduct(state: RuntimeState, input: ProductWriteInput, actorId: string) {
  if (state.products.some((product) => product.sku === input.sku)) throw new Error('商品SKU已存在')
  const normalized = normalizeProductInput(input)
  validateProductInput(normalized)
  const product = { id: `product_${randomUUID()}`, ...normalized, configVersion: 1 }
  state.products.push(product)
  audit(state, actorId, 'product.created.v1', 'product', product.id, { after: product })
  return product
}

export function updateProduct(
  state: RuntimeState,
  productId: string,
  input: ProductWriteInput,
  actorId: string,
) {
  const product = state.products.find((item) => item.id === productId)
  if (!product) throw new Error('商品不存在')
  if (state.products.some((item) => item.id !== productId && item.sku === input.sku)) throw new Error('商品SKU已存在')
  const normalized = normalizeProductInput(input)
  validateProductInput(normalized)
  const before = structuredClone(product)
  Object.assign(product, normalized, { configVersion: product.configVersion + 1 })
  audit(state, actorId, 'product.updated.v1', 'product', product.id, { before, after: product })
  return product
}

function normalizeProductInput(input: ProductWriteInput): ProductWriteInput {
  const soldOut = input.soldOut ?? false
  return {
    ...input,
    categoryId: input.categoryId ?? 'featured',
    categoryName: input.categoryName ?? '推荐',
    description: input.description ?? '',
    imageUrl: input.imageUrl ?? '',
    tags: [...new Set(input.tags ?? [])],
    sortOrder: input.sortOrder ?? 999,
    soldOut,
    soldOutReason: soldOut ? input.soldOutReason?.trim() || '暂时售罄' : '',
    availableFrom: input.availableFrom || null,
    availableUntil: input.availableUntil || null,
    guestVisible: input.guestVisible ?? true,
    requiresFulfillment: input.requiresFulfillment ?? true,
    maxOrderQuantity: input.maxOrderQuantity ?? 50,
  }
}

function validateProductInput(input: ProductWriteInput) {
  if (input.costAmount > input.listPriceAmount) throw new Error('商品成本不能高于标价')
  if (Boolean(input.availableFrom) !== Boolean(input.availableUntil)) throw new Error('供应开始和结束时间必须同时填写')
  if (input.availableFrom && input.availableFrom === input.availableUntil) throw new Error('供应开始和结束时间不能相同')
}

function validateAuthority(state: RuntimeState, input: AuthorityWriteInput) {
  const employee = state.employees.find((item) => item.id === input.actorId)
  if (!employee || employee.status !== 'active') throw new Error('授权员工不存在或已停用')
  if (new Date(input.validFrom) >= new Date(input.validUntil)) throw new Error('授权结束时间必须晚于开始时间')
  if (new Set(input.kinds).size !== input.kinds.length) throw new Error('授权类型不能重复')
  if (input.allowedSkuIds) {
    if (new Set(input.allowedSkuIds).size !== input.allowedSkuIds.length) throw new Error('授权商品不能重复')
    if (input.allowedSkuIds.some((id) => !state.products.some((product) => product.id === id))) {
      throw new Error('授权商品不存在')
    }
  }
}

export function createAuthority(state: RuntimeState, input: AuthorityWriteInput, actorId: string) {
  validateAuthority(state, input)
  const authority = { id: `authority_${randomUUID()}`, ...input }
  state.orderDomain.authorizationAuthorities.push(authority)
  audit(state, actorId, 'commerce.authority.created.v1', 'orderAuthorizationAuthority', authority.id, { after: authority })
  return authority
}

export function updateAuthority(
  state: RuntimeState,
  authorityId: string,
  input: AuthorityWriteInput,
  actorId: string,
) {
  const authority = state.orderDomain.authorizationAuthorities.find((item) => item.id === authorityId)
  if (!authority) throw new Error('经营授权不存在')
  validateAuthority(state, input)
  const before = structuredClone(authority)
  Object.assign(authority, input)
  audit(state, actorId, 'commerce.authority.updated.v1', 'orderAuthorizationAuthority', authority.id, { before, after: authority })
  return authority
}
