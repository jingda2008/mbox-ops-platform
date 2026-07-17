import {
  skillConfigSchema,
  workstationConfigSchema,
  type AuditEntry,
  type Employee,
  type RuntimeState,
  type ShiftAssignment,
  type SkillConfig,
  type StoreConfig,
  type WorkstationConfig,
} from '../src/shared/contracts.js'
import type { OrderAuthorizationAuthority } from '../src/shared/order-contracts.js'
import { z, type ZodError } from 'zod'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'
import { CHINA_TIME_ZONE } from '../src/shared/china-time.js'
import {
  storeImportApplyCommandSchema,
  storeImportPackageSchema,
  type StoreImportApplyCommand,
  type StoreImportAuthority,
  type StoreImportDiffEntry,
  type StoreImportIssue,
  type StoreImportPackage,
  type StoreImportPreflightResult,
  type StoreImportPreview,
  type StoreImportSection,
  type StoreImportSectionDiff,
} from '../src/shared/store-import-contracts.js'

type CollectionSection =
  | 'areas'
  | 'tables'
  | 'employees'
  | 'shiftAssignments'
  | 'products'
  | 'authorizationAuthorities'

interface ImportCandidate {
  store: RuntimeState['store']
  config: StoreConfig
  areas: RuntimeState['areas']
  tables: RuntimeState['tables']
  employees: RuntimeState['employees']
  shiftAssignments: RuntimeState['shiftAssignments']
  products: RuntimeState['products']
  authorizationAuthorities: OrderAuthorizationAuthority[]
}

interface ImportExtensions {
  skills?: SkillConfig[]
  workstations?: WorkstationConfig[]
  serviceTypeGuestVisible: Map<string, boolean>
  employeeSkillIds: Map<string, string[]>
  shiftStationIds: Map<string, string[]>
}

type ParsedImportPackage =
  | { success: true; data: StoreImportPackage }
  | { success: false; issues: StoreImportIssue[] }

export interface StoreImportApplyResult {
  state: RuntimeState
  preview: StoreImportPreview
  auditEntry: AuditEntry
}

export class StoreImportValidationError extends Error {
  readonly issues: StoreImportIssue[]

  constructor(issues: StoreImportIssue[]) {
    super(`门店导入预检失败：${issues.filter((issue) => issue.severity === 'error').length} 个错误`)
    this.name = 'StoreImportValidationError'
    this.issues = structuredClone(issues)
  }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => !sameValue(before[key], after[key])).toSorted()
}

function sectionDiff(
  current: readonly Record<string, unknown>[],
  next: readonly Record<string, unknown>[],
  idOf: (item: Record<string, unknown>) => string,
): StoreImportSectionDiff {
  const currentById = new Map(current.map((item) => [idOf(item), item]))
  const nextById = new Map(next.map((item) => [idOf(item), item]))
  const entries: StoreImportDiffEntry[] = []

  for (const item of next) {
    const id = idOf(item)
    const before = currentById.get(id)
    if (!before) {
      entries.push({ id, operation: 'add', changedFields: Object.keys(item).toSorted(), before: null, after: item })
      continue
    }
    const fields = changedFields(before, item)
    entries.push({
      id,
      operation: fields.length === 0 ? 'unchanged' : 'update',
      changedFields: fields,
      before,
      after: item,
    })
  }
  for (const item of current) {
    const id = idOf(item)
    if (!nextById.has(id)) {
      entries.push({ id, operation: 'remove', changedFields: Object.keys(item).toSorted(), before: item, after: null })
    }
  }

  return {
    added: entries.filter((entry) => entry.operation === 'add').length,
    updated: entries.filter((entry) => entry.operation === 'update').length,
    removed: entries.filter((entry) => entry.operation === 'remove').length,
    unchanged: entries.filter((entry) => entry.operation === 'unchanged').length,
    entries,
  }
}

function singletonDiff(id: string, current: Record<string, unknown>, next: Record<string, unknown>) {
  return sectionDiff([current], [next], () => id)
}

function mergeById<T extends { id: string }>(current: readonly T[], incoming: readonly T[], mode: 'replace' | 'upsert') {
  if (mode === 'replace') return structuredClone(incoming) as T[]
  const incomingById = new Map(incoming.map((item) => [item.id, item]))
  const merged = current.map((item) => incomingById.get(item.id) ?? item)
  const currentIds = new Set(current.map((item) => item.id))
  merged.push(...incoming.filter((item) => !currentIds.has(item.id)))
  return structuredClone(merged) as T[]
}

function runtimeAuthority(authority: StoreImportAuthority): OrderAuthorizationAuthority {
  const { approval: _approval, ...record } = authority
  return structuredClone(record)
}

function inferredLegacyWorkstations(input: StoreImportPackage): WorkstationConfig[] {
  const stationIds = [...new Set(input.data.products.map((product) => product.stationId))]
  const roleIds = input.data.config.roles.filter((role) => role.canReceiveTasks).map((role) => role.id)
  const deliveryServiceTypeId = input.data.config.serviceTypes.find((serviceType) => (
    serviceType.enabled && serviceType.code === 'FULFILLMENT_DELIVERY'
  ))?.id ?? null
  return stationIds.map((stationId) => ({
    id: stationId,
    name: stationId,
    kind: 'hybrid',
    enabled: true,
    productionRoleIds: [...roleIds],
    deliveryRoleIds: [...roleIds],
    requiredSkillIds: [],
    productionSlaSeconds: 300,
    pickupSlaSeconds: 90,
    deliveryServiceTypeId,
    fallbackStationId: null,
  }))
}

function extensionSchemaIssues(error: ZodError, prefix: PropertyKey[]) {
  return error.issues.map((issue): StoreImportIssue => ({
    severity: 'error',
    code: 'SCHEMA_INVALID',
    message: issue.message,
    ...schemaIssueLocation([...prefix, ...issue.path]),
  }))
}

function prepareImportExtensions(rawInput: unknown) {
  const baseInput = structuredClone(rawInput)
  const extensions: ImportExtensions = {
    serviceTypeGuestVisible: new Map(),
    employeeSkillIds: new Map(),
    shiftStationIds: new Map(),
  }
  const issues: StoreImportIssue[] = []
  if (!baseInput || typeof baseInput !== 'object' || Array.isArray(baseInput)) {
    return { baseInput, extensions, issues }
  }
  const data = (baseInput as { data?: unknown }).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { baseInput, extensions, issues }
  const mutableData = data as Record<string, unknown>
  const config = mutableData.config
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const mutableConfig = config as Record<string, unknown>
    if ('skills' in mutableConfig) {
      const result = z.array(skillConfigSchema).safeParse(mutableConfig.skills)
      if (result.success) extensions.skills = result.data
      else issues.push(...extensionSchemaIssues(result.error, ['data', 'config', 'skills']))
      delete mutableConfig.skills
    }
    if ('workstations' in mutableConfig) {
      const result = z.array(workstationConfigSchema).safeParse(mutableConfig.workstations)
      if (result.success) extensions.workstations = result.data
      else issues.push(...extensionSchemaIssues(result.error, ['data', 'config', 'workstations']))
      delete mutableConfig.workstations
    }
    const serviceTypes = mutableConfig.serviceTypes
    if (Array.isArray(serviceTypes)) {
      serviceTypes.forEach((serviceType, index) => {
        if (!serviceType || typeof serviceType !== 'object' || Array.isArray(serviceType)) return
        const mutableServiceType = serviceType as Record<string, unknown>
        if (!('guestVisible' in mutableServiceType)) return
        const result = z.boolean().safeParse(mutableServiceType.guestVisible)
        if (result.success && typeof mutableServiceType.id === 'string') {
          extensions.serviceTypeGuestVisible.set(mutableServiceType.id, result.data)
        } else if (!result.success) {
          issues.push(...extensionSchemaIssues(result.error, ['data', 'config', 'serviceTypes', index, 'guestVisible']))
        }
        delete mutableServiceType.guestVisible
      })
    }
  }

  const employees = mutableData.employees
  if (Array.isArray(employees)) {
    employees.forEach((employee, index) => {
      if (!employee || typeof employee !== 'object' || Array.isArray(employee)) return
      const mutableEmployee = employee as Record<string, unknown>
      if (!('skillIds' in mutableEmployee)) return
      const result = z.array(z.string().trim().min(1).max(64)).max(20).safeParse(mutableEmployee.skillIds)
      if (result.success && typeof mutableEmployee.id === 'string') extensions.employeeSkillIds.set(mutableEmployee.id, result.data)
      else if (!result.success) issues.push(...extensionSchemaIssues(result.error, ['data', 'employees', index, 'skillIds']))
      delete mutableEmployee.skillIds
    })
  }

  const shifts = mutableData.shiftAssignments
  if (Array.isArray(shifts)) {
    shifts.forEach((shift, index) => {
      if (!shift || typeof shift !== 'object' || Array.isArray(shift)) return
      const mutableShift = shift as Record<string, unknown>
      if (!('stationIds' in mutableShift)) return
      const result = z.array(z.string().trim().min(1).max(64)).max(20).safeParse(mutableShift.stationIds)
      if (result.success && typeof mutableShift.id === 'string') extensions.shiftStationIds.set(mutableShift.id, result.data)
      else if (!result.success) issues.push(...extensionSchemaIssues(result.error, ['data', 'shiftAssignments', index, 'stationIds']))
      delete mutableShift.stationIds
    })
  }
  return { baseInput, extensions, issues }
}

function parseImportPackage(rawInput: unknown): ParsedImportPackage {
  const { baseInput, extensions, issues } = prepareImportExtensions(rawInput)
  const parsed = storeImportPackageSchema.safeParse(baseInput)
  if (!parsed.success) issues.push(...schemaIssues(parsed.error))
  if (!parsed.success || issues.length > 0) return { success: false, issues }

  const config = parsed.data.data.config as unknown as StoreConfig
  config.skills = structuredClone(extensions.skills ?? [])
  config.workstations = structuredClone(extensions.workstations ?? inferredLegacyWorkstations(parsed.data))
  for (const serviceType of config.serviceTypes) {
    const guestVisible = extensions.serviceTypeGuestVisible.get(serviceType.id)
    if (guestVisible !== undefined) serviceType.guestVisible = guestVisible
  }
  for (const employee of parsed.data.data.employees as unknown as Employee[]) {
    const skillIds = extensions.employeeSkillIds.get(employee.id)
    if (skillIds) employee.skillIds = structuredClone(skillIds)
  }
  for (const shift of parsed.data.data.shiftAssignments as unknown as ShiftAssignment[]) {
    const stationIds = extensions.shiftStationIds.get(shift.id)
    if (stationIds) shift.stationIds = structuredClone(stationIds)
  }
  return { success: true, data: parsed.data }
}

function buildCandidate(state: RuntimeState, input: StoreImportPackage): ImportCandidate {
  const { sections } = input.policy
  return {
    store: structuredClone(input.data.store),
    config: {
      ...(structuredClone(input.data.config) as StoreConfig),
      communityBrand: structuredClone(input.data.config.communityBrand ?? state.config.communityBrand),
      roles: input.data.config.roles.map((role) => withDefaultRolePolicy(structuredClone(role))),
    },
    areas: mergeById(state.areas, input.data.areas, sections.areas.mode),
    tables: mergeById(state.tables, input.data.tables, sections.tables.mode),
    employees: mergeById(state.employees, input.data.employees, sections.employees.mode),
    shiftAssignments: mergeById(
      state.shiftAssignments,
      input.data.shiftAssignments,
      sections.shiftAssignments.mode,
    ),
    products: mergeById(state.products, input.data.products, sections.products.mode),
    authorizationAuthorities: mergeById(
      state.orderDomain.authorizationAuthorities,
      input.data.authorizationAuthorities.map(runtimeAuthority),
      sections.authorizationAuthorities.mode,
    ),
  }
}

function buildPreview(state: RuntimeState, candidate: ImportCandidate): StoreImportPreview {
  return {
    store: singletonDiff('store', state.store as unknown as Record<string, unknown>, candidate.store as unknown as Record<string, unknown>),
    config: singletonDiff('store-config', state.config as unknown as Record<string, unknown>, candidate.config as unknown as Record<string, unknown>),
    areas: sectionDiff(state.areas as unknown as Record<string, unknown>[], candidate.areas as unknown as Record<string, unknown>[], (item) => String(item.id)),
    tables: sectionDiff(state.tables as unknown as Record<string, unknown>[], candidate.tables as unknown as Record<string, unknown>[], (item) => String(item.id)),
    employees: sectionDiff(state.employees as unknown as Record<string, unknown>[], candidate.employees as unknown as Record<string, unknown>[], (item) => String(item.id)),
    shiftAssignments: sectionDiff(state.shiftAssignments as unknown as Record<string, unknown>[], candidate.shiftAssignments as unknown as Record<string, unknown>[], (item) => String(item.id)),
    products: sectionDiff(state.products as unknown as Record<string, unknown>[], candidate.products as unknown as Record<string, unknown>[], (item) => String(item.id)),
    authorizationAuthorities: sectionDiff(
      state.orderDomain.authorizationAuthorities as unknown as Record<string, unknown>[],
      candidate.authorizationAuthorities as unknown as Record<string, unknown>[],
      (item) => String(item.id),
    ),
  }
}

function schemaIssueLocation(path: PropertyKey[]) {
  const dataIndex = path.indexOf('data')
  const policyIndex = path.indexOf('sections')
  const sectionValue = dataIndex >= 0 ? path[dataIndex + 1] : policyIndex >= 0 ? path[policyIndex + 1] : null
  const validSections: StoreImportSection[] = [
    'store', 'config', 'areas', 'tables', 'employees', 'shiftAssignments', 'products', 'authorizationAuthorities',
  ]
  const section = validSections.includes(sectionValue as StoreImportSection)
    ? sectionValue as StoreImportSection
    : 'package'
  const sectionIndex = dataIndex >= 0 ? dataIndex + 1 : policyIndex >= 0 ? policyIndex + 1 : -1
  const rowIndex = sectionIndex >= 0 && typeof path[sectionIndex + 1] === 'number'
    ? Number(path[sectionIndex + 1])
    : null
  const fieldStart = rowIndex === null ? sectionIndex + 1 : sectionIndex + 2
  const field = sectionIndex >= 0 && fieldStart < path.length
    ? path.slice(fieldStart).map(String).join('.') || null
    : path.map(String).join('.') || null
  return { section, row: rowIndex === null ? null : rowIndex + 1, field }
}

function schemaIssues(error: ZodError): StoreImportIssue[] {
  return error.issues.map((issue) => ({
    severity: 'error',
    code: 'SCHEMA_INVALID',
    message: issue.message,
    ...schemaIssueLocation(issue.path),
  }))
}

function semanticIssues(state: RuntimeState, input: StoreImportPackage, candidate: ImportCandidate) {
  const issues: StoreImportIssue[] = []
  const add = (
    severity: StoreImportIssue['severity'],
    code: string,
    message: string,
    section: StoreImportSection,
    row: number | null = null,
    field: string | null = null,
  ) => issues.push({ severity, code, message, section, row, field })

  const rowOf = (section: CollectionSection, id: string) => {
    const rows = input.data[section]
    const index = rows.findIndex((item) => item.id === id)
    return index < 0 ? null : index + 1
  }

  const checkUnique = <T>(
    items: readonly T[],
    valueOf: (item: T) => string | number,
    label: string,
    section: CollectionSection | 'config',
    field: string,
    caseInsensitive = false,
  ) => {
    const seen = new Map<string, number>()
    items.forEach((item, index) => {
      const raw = valueOf(item)
      const value = caseInsensitive ? String(raw).toLocaleUpperCase('en-US') : String(raw)
      const previous = seen.get(value)
      if (previous !== undefined) {
        add('error', 'DUPLICATE_VALUE', `${label}重复：${String(raw)}（首次出现在第 ${previous + 1} 行）`, section, index + 1, field)
      } else {
        seen.set(value, index)
      }
    })
  }

  const checkMergedUnique = <T extends { id: string }>(
    items: readonly T[],
    valueOf: (item: T) => string | number,
    label: string,
    section: CollectionSection,
    field: string,
    caseInsensitive = false,
  ) => {
    const seen = new Map<string, T>()
    for (const item of items) {
      const raw = valueOf(item)
      const value = caseInsensitive ? String(raw).toLocaleUpperCase('en-US') : String(raw)
      const previous = seen.get(value)
      if (previous && previous.id !== item.id) {
        add(
          'error',
          'MERGED_DUPLICATE_VALUE',
          `${label}与记录 ${previous.id} 冲突：${String(raw)}`,
          section,
          rowOf(section, item.id) ?? rowOf(section, previous.id),
          field,
        )
      } else {
        seen.set(value, item)
      }
    }
  }

  if (input.targetStoreId !== state.store.id || input.data.store.id !== state.store.id) {
    add('error', 'STORE_MISMATCH', `导入目标必须是当前门店 ${state.store.id}`, 'store', null, 'id')
  }
  if (input.data.store.id !== input.targetStoreId) {
    add('error', 'TARGET_STORE_MISMATCH', 'data.store.id 必须与 targetStoreId 一致', 'store', null, 'id')
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: candidate.store.timezone }).format()
  } catch {
    add('error', 'TIMEZONE_INVALID', `无效时区：${candidate.store.timezone}`, 'store', null, 'timezone')
  }
  if (candidate.store.timezone !== CHINA_TIME_ZONE) {
    add('error', 'TIMEZONE_MUST_BE_CHINA_STANDARD', 'M-BOX陆家嘴必须使用Asia/Shanghai（北京时间）', 'store', null, 'timezone')
  }

  const sectionEntries = Object.entries(input.policy.sections) as Array<[
    keyof StoreImportPackage['policy']['sections'],
    StoreImportPackage['policy']['sections'][keyof StoreImportPackage['policy']['sections']],
  ]>
  const incomplete = sectionEntries.filter(([, policy]) => policy.completeness !== 'complete')
  for (const [section, policy] of incomplete) {
    const severity = input.policy.target === 'production' ? 'error' : 'warning'
    add(severity, 'SECTION_INCOMPLETE', `${section} 被声明为 ${policy.completeness}，不得视为正式完整资料`, section)
    if ('mode' in policy && policy.mode === 'replace') {
      add('error', 'INCOMPLETE_REPLACE_FORBIDDEN', `${section} 不完整时禁止 replace，以免删除正式数据`, section)
    }
  }
  if (incomplete.length > 0 && input.declaredMissingData.length === 0) {
    add('error', 'MISSING_DATA_NOT_DECLARED', '存在不完整分区，但 declaredMissingData 为空', 'package', null, 'declaredMissingData')
  }
  if (incomplete.length === 0 && input.declaredMissingData.length > 0) {
    add('error', 'COMPLETENESS_CONTRADICTION', '所有分区均声明完整，但仍列出了缺失资料', 'package', null, 'declaredMissingData')
  }
  input.declaredMissingData.forEach((message, index) => {
    add(input.policy.target === 'production' ? 'error' : 'warning', 'DECLARED_MISSING_DATA', message, 'package', index + 1, 'declaredMissingData')
  })

  checkUnique(input.data.areas, (item) => item.id, '区域ID', 'areas', 'id')
  checkUnique(input.data.areas, (item) => item.name, '区域名称', 'areas', 'name', true)
  checkUnique(input.data.areas, (item) => item.sortOrder, '区域排序号', 'areas', 'sortOrder')
  checkUnique(input.data.tables, (item) => item.id, '桌台公开ID', 'tables', 'id')
  checkUnique(input.data.tables, (item) => item.code, '桌台编号', 'tables', 'code', true)
  checkUnique(input.data.employees, (item) => item.id, '员工编号', 'employees', 'id')
  checkUnique(input.data.shiftAssignments, (item) => item.id, '班次ID', 'shiftAssignments', 'id')
  checkUnique(input.data.products, (item) => item.id, '商品ID', 'products', 'id')
  checkUnique(input.data.products, (item) => item.sku, '商品SKU', 'products', 'sku', true)
  checkUnique(input.data.authorizationAuthorities, (item) => item.id, '经营权限ID', 'authorizationAuthorities', 'id')
  checkUnique(candidate.config.roles, (item) => item.id, '岗位ID', 'config', 'roles.id')
  checkUnique(candidate.config.roles, (item) => item.name, '岗位名称', 'config', 'roles.name', true)
  checkUnique(candidate.config.serviceTypes, (item) => item.id, '服务类型ID', 'config', 'serviceTypes.id')
  checkUnique(candidate.config.serviceTypes, (item) => item.code, '服务类型代码', 'config', 'serviceTypes.code', true)
  checkUnique(candidate.config.skills, (item) => item.id, '技能ID', 'config', 'skills.id')
  checkUnique(candidate.config.skills, (item) => item.name, '技能名称', 'config', 'skills.name', true)
  checkUnique(candidate.config.workstations, (item) => item.id, '工作站ID', 'config', 'workstations.id')
  checkUnique(candidate.config.workstations, (item) => item.name, '工作站名称', 'config', 'workstations.name', true)
  checkMergedUnique(candidate.areas, (item) => item.name, '区域名称', 'areas', 'name', true)
  checkMergedUnique(candidate.areas, (item) => item.sortOrder, '区域排序号', 'areas', 'sortOrder')
  checkMergedUnique(candidate.tables, (item) => item.code, '桌台编号', 'tables', 'code', true)
  checkMergedUnique(
    candidate.employees.filter((item) => item.status === 'active'),
    (item) => item.displayName,
    '在职员工昵称',
    'employees',
    'displayName',
    true,
  )
  checkMergedUnique(candidate.products, (item) => item.sku, '商品SKU', 'products', 'sku', true)

  const roleIds = new Set(candidate.config.roles.map((role) => role.id))
  const serviceTypeIds = new Set(candidate.config.serviceTypes.map((serviceType) => serviceType.id))
  const skillIds = new Set(candidate.config.skills.map((skill) => skill.id))
  const workstations = new Map(candidate.config.workstations.map((station) => [station.id, station]))
  const responsibilityRoleOwners = new Map<string, string>()
  for (const [group, configuredRoleIds] of Object.entries(input.policy.responsibilityRoles)) {
    const unique = new Set(configuredRoleIds)
    if (unique.size !== configuredRoleIds.length) {
      add('error', 'RESPONSIBILITY_ROLE_DUPLICATE', `${group} 包含重复岗位`, 'config', null, `policy.responsibilityRoles.${group}`)
    }
    for (const roleId of configuredRoleIds) {
      if (!roleIds.has(roleId)) add('error', 'ROLE_REFERENCE_MISSING', `${group} 引用了不存在的岗位 ${roleId}`, 'config', null, `policy.responsibilityRoles.${group}`)
      const previousGroup = responsibilityRoleOwners.get(roleId)
      if (previousGroup && previousGroup !== group) {
        add('error', 'RESPONSIBILITY_ROLE_OVERLAP', `岗位 ${roleId} 同时出现在 ${previousGroup} 和 ${group}，不能形成独立接管链`, 'config', null, `policy.responsibilityRoles.${group}`)
      } else {
        responsibilityRoleOwners.set(roleId, group)
      }
    }
  }
  for (const serviceType of candidate.config.serviceTypes) {
    if (new Set(serviceType.dispatchRoleIds).size !== serviceType.dispatchRoleIds.length) {
      add('error', 'DISPATCH_ROLE_DUPLICATE', `服务类型 ${serviceType.id} 的派单岗位重复`, 'config', null, `serviceTypes.${serviceType.id}.dispatchRoleIds`)
    }
    for (const roleId of serviceType.dispatchRoleIds) {
      if (!roleIds.has(roleId)) add('error', 'ROLE_REFERENCE_MISSING', `服务类型 ${serviceType.id} 引用了不存在的岗位 ${roleId}`, 'config', null, `serviceTypes.${serviceType.id}.dispatchRoleIds`)
    }
    const { warningSeconds, escalateSeconds, managerSeconds } = serviceType.sla
    if (!(warningSeconds < escalateSeconds && escalateSeconds < managerSeconds)) {
      add('error', 'SLA_ORDER_INVALID', `服务类型 ${serviceType.id} 必须满足预警 < 升级 < 经理接管`, 'config', null, `serviceTypes.${serviceType.id}.sla`)
    }
  }
  for (const station of candidate.config.workstations) {
    const roleGroups: Array<[string, string[]]> = [
      ['productionRoleIds', station.productionRoleIds],
      ['deliveryRoleIds', station.deliveryRoleIds],
    ]
    for (const [field, configuredRoleIds] of roleGroups) {
      if (new Set(configuredRoleIds).size !== configuredRoleIds.length) {
        add('error', 'WORKSTATION_ROLE_DUPLICATE', `工作站 ${station.id} 的岗位重复`, 'config', null, `workstations.${station.id}.${field}`)
      }
      for (const roleId of configuredRoleIds) {
        if (!roleIds.has(roleId)) add('error', 'ROLE_REFERENCE_MISSING', `工作站 ${station.id} 引用了不存在的岗位 ${roleId}`, 'config', null, `workstations.${station.id}.${field}`)
      }
    }
    if (station.kind !== 'delivery' && station.productionRoleIds.length === 0) {
      add('error', 'WORKSTATION_PRODUCTION_ROLE_REQUIRED', `工作站 ${station.id} 缺少生产岗位`, 'config', null, `workstations.${station.id}.productionRoleIds`)
    }
    if (station.kind !== 'production' && station.deliveryRoleIds.length === 0) {
      add('error', 'WORKSTATION_DELIVERY_ROLE_REQUIRED', `工作站 ${station.id} 缺少配送岗位`, 'config', null, `workstations.${station.id}.deliveryRoleIds`)
    }
    if (new Set(station.requiredSkillIds).size !== station.requiredSkillIds.length) {
      add('error', 'WORKSTATION_SKILL_DUPLICATE', `工作站 ${station.id} 的技能重复`, 'config', null, `workstations.${station.id}.requiredSkillIds`)
    }
    for (const skillId of station.requiredSkillIds) {
      if (!skillIds.has(skillId)) add('error', 'SKILL_REFERENCE_MISSING', `工作站 ${station.id} 引用了不存在的技能 ${skillId}`, 'config', null, `workstations.${station.id}.requiredSkillIds`)
    }
    if (station.deliveryServiceTypeId && !serviceTypeIds.has(station.deliveryServiceTypeId)) {
      add('error', 'SERVICE_TYPE_REFERENCE_MISSING', `工作站 ${station.id} 的取送服务类型不存在`, 'config', null, `workstations.${station.id}.deliveryServiceTypeId`)
    } else if (station.deliveryServiceTypeId && candidate.config.serviceTypes.find((type) => type.id === station.deliveryServiceTypeId)?.code !== 'FULFILLMENT_DELIVERY') {
      add('error', 'WORKSTATION_DELIVERY_SERVICE_INVALID', `工作站 ${station.id} 必须使用专用的出品取送任务类型`, 'config', null, `workstations.${station.id}.deliveryServiceTypeId`)
    }
    if (station.fallbackStationId === station.id) {
      add('error', 'WORKSTATION_FALLBACK_SELF', `工作站 ${station.id} 不能回退到自身`, 'config', null, `workstations.${station.id}.fallbackStationId`)
    } else if (station.fallbackStationId && !workstations.has(station.fallbackStationId)) {
      add('error', 'WORKSTATION_REFERENCE_MISSING', `工作站 ${station.id} 的回退工作站不存在`, 'config', null, `workstations.${station.id}.fallbackStationId`)
    }
  }
  if (!serviceTypeIds.has(candidate.config.proactiveOrderCare.serviceTypeId)) {
    add('error', 'SERVICE_TYPE_REFERENCE_MISSING', '主动点单关怀引用的服务类型不存在', 'config', null, 'proactiveOrderCare.serviceTypeId')
  }
  if (state.draftConfig) {
    add('error', 'DRAFT_CONFIG_EXISTS', '当前存在未发布配置草稿，不能执行整店导入', 'config')
  }
  const configChanged = !sameValue(state.config, candidate.config)
  const currentStoreVersions = state.configVersions.filter((record) => record.storeId === state.store.id)
  const maxConfigVersion = Math.max(state.config.version, ...currentStoreVersions.map((record) => record.version))
  if (configChanged && candidate.config.version <= maxConfigVersion) {
    add('error', 'CONFIG_VERSION_NOT_MONOTONIC', `新配置版本必须大于当前最大版本 ${maxConfigVersion}`, 'config', null, 'version')
  }
  if (Date.parse(candidate.config.publishedAt ?? '') > Date.parse(input.createdAt)) {
    add('error', 'CONFIG_PUBLISHED_AFTER_PACKAGE', '配置发布时间不能晚于导入包创建时间', 'config', null, 'publishedAt')
  }

  const areas = new Map(candidate.areas.map((area) => [area.id, area]))
  const employees = new Map(candidate.employees.map((employee) => [employee.id, employee]))
  const products = new Map(candidate.products.map((product) => [product.id, product]))
  const tableSessions = new Map(state.songState.tableSessions.map((session) => [session.id, session]))

  for (const employee of candidate.employees) {
    const row = rowOf('employees', employee.id)
    if (!roleIds.has(employee.roleId)) add('error', 'ROLE_REFERENCE_MISSING', `员工 ${employee.id} 的岗位不存在`, 'employees', row, 'roleId')
    if (new Set(employee.areaIds).size !== employee.areaIds.length) add('error', 'AREA_REFERENCE_DUPLICATE', `员工 ${employee.id} 的责任区重复`, 'employees', row, 'areaIds')
    for (const areaId of employee.areaIds) {
      if (!areas.has(areaId)) add('error', 'AREA_REFERENCE_MISSING', `员工 ${employee.id} 引用了不存在的区域 ${areaId}`, 'employees', row, 'areaIds')
    }
    const employeeSkillIds = employee.skillIds ?? []
    if (new Set(employeeSkillIds).size !== employeeSkillIds.length) add('error', 'SKILL_REFERENCE_DUPLICATE', `员工 ${employee.id} 的技能重复`, 'employees', row, 'skillIds')
    for (const skillId of employeeSkillIds) {
      if (!skillIds.has(skillId)) add('error', 'SKILL_REFERENCE_MISSING', `员工 ${employee.id} 引用了不存在的技能 ${skillId}`, 'employees', row, 'skillIds')
    }
    if (employee.status === 'inactive' && (employee.online || !employee.paused)) {
      add('error', 'INACTIVE_EMPLOYEE_STATE_INVALID', `停用员工 ${employee.id} 必须离线且暂停派单`, 'employees', row, 'status')
    }
  }

  for (const table of candidate.tables) {
    const row = rowOf('tables', table.id)
    if (!areas.has(table.areaId)) add('error', 'AREA_REFERENCE_MISSING', `桌台 ${table.code} 的区域不存在`, 'tables', row, 'areaId')
    const primary = employees.get(table.primaryEmployeeId)
    if (!primary || primary.status !== 'active') {
      add('error', 'PRIMARY_EMPLOYEE_INVALID', `桌台 ${table.code} 的主责任人不存在或已停用`, 'tables', row, 'primaryEmployeeId')
    } else {
      if (!primary.areaIds.includes(table.areaId)) add('error', 'PRIMARY_AREA_MISMATCH', `桌台 ${table.code} 的主责任人未覆盖该区域`, 'tables', row, 'primaryEmployeeId')
      if (!input.policy.responsibilityRoles.primaryRoleIds.includes(primary.roleId)) add('error', 'PRIMARY_ROLE_INVALID', `桌台 ${table.code} 的主责任人岗位不在主责岗位组`, 'tables', row, 'primaryEmployeeId')
    }
    if (new Set(table.backupEmployeeIds).size !== table.backupEmployeeIds.length) add('error', 'BACKUP_DUPLICATE', `桌台 ${table.code} 的候补人员重复`, 'tables', row, 'backupEmployeeIds')
    if (table.backupEmployeeIds.includes(table.primaryEmployeeId)) add('error', 'PRIMARY_BACKUP_CONFLICT', `桌台 ${table.code} 的主责任人不能同时作为候补`, 'tables', row, 'backupEmployeeIds')
    for (const employeeId of table.backupEmployeeIds) {
      const backup = employees.get(employeeId)
      if (!backup || backup.status !== 'active') add('error', 'BACKUP_EMPLOYEE_INVALID', `桌台 ${table.code} 的候补 ${employeeId} 不存在或已停用`, 'tables', row, 'backupEmployeeIds')
      else {
        if (!backup.areaIds.includes(table.areaId)) add('error', 'BACKUP_AREA_MISMATCH', `桌台 ${table.code} 的候补 ${employeeId} 未覆盖该区域`, 'tables', row, 'backupEmployeeIds')
        if (!input.policy.responsibilityRoles.backupRoleIds.includes(backup.roleId)) add('error', 'BACKUP_ROLE_INVALID', `桌台 ${table.code} 的候补 ${employeeId} 岗位不在候补岗位组`, 'tables', row, 'backupEmployeeIds')
      }
    }
    if (table.status === 'occupied' && (table.guestCount === 0 || !table.openedAt)) add('error', 'TABLE_OCCUPANCY_INVALID', `占用桌台 ${table.code} 必须有客人数和开台时间`, 'tables', row, 'status')
    if (table.status !== 'occupied' && (table.guestCount !== 0 || table.openedAt !== null)) add('error', 'TABLE_OCCUPANCY_INVALID', `非占用桌台 ${table.code} 的客人数必须为0且开台时间为空`, 'tables', row, 'status')
  }

  for (const shift of candidate.shiftAssignments) {
    const row = rowOf('shiftAssignments', shift.id)
    const employee = employees.get(shift.employeeId)
    if (!employee) add('error', 'EMPLOYEE_REFERENCE_MISSING', `班次 ${shift.id} 的员工不存在`, 'shiftAssignments', row, 'employeeId')
    else {
      if (shift.status !== 'cancelled' && employee.status !== 'active') add('error', 'INACTIVE_EMPLOYEE_SHIFT', `停用员工 ${employee.id} 不能承担未取消班次`, 'shiftAssignments', row, 'employeeId')
      if (input.policy.requireShiftRoleMatchEmployeeRole && shift.roleId !== employee.roleId) add('error', 'SHIFT_ROLE_MISMATCH', `班次 ${shift.id} 岗位与员工岗位不一致`, 'shiftAssignments', row, 'roleId')
      for (const areaId of shift.areaIds) {
        if (!employee.areaIds.includes(areaId)) add('error', 'SHIFT_AREA_OUTSIDE_RESPONSIBILITY', `班次 ${shift.id} 包含员工责任区之外的区域 ${areaId}`, 'shiftAssignments', row, 'areaIds')
      }
    }
    if (!roleIds.has(shift.roleId)) add('error', 'ROLE_REFERENCE_MISSING', `班次 ${shift.id} 的岗位不存在`, 'shiftAssignments', row, 'roleId')
    if (new Set(shift.areaIds).size !== shift.areaIds.length) add('error', 'AREA_REFERENCE_DUPLICATE', `班次 ${shift.id} 的区域重复`, 'shiftAssignments', row, 'areaIds')
    for (const areaId of shift.areaIds) {
      if (!areas.has(areaId)) add('error', 'AREA_REFERENCE_MISSING', `班次 ${shift.id} 的区域 ${areaId} 不存在`, 'shiftAssignments', row, 'areaIds')
    }
    const stationIds = shift.stationIds ?? []
    if (new Set(stationIds).size !== stationIds.length) add('error', 'WORKSTATION_REFERENCE_DUPLICATE', `班次 ${shift.id} 的工作站重复`, 'shiftAssignments', row, 'stationIds')
    for (const stationId of stationIds) {
      const station = workstations.get(stationId)
      if (!station) {
        add('error', 'WORKSTATION_REFERENCE_MISSING', `班次 ${shift.id} 引用了不存在的工作站 ${stationId}`, 'shiftAssignments', row, 'stationIds')
        continue
      }
      const productionRoute = station.productionRoleIds.includes(shift.roleId)
      const deliveryRoute = station.deliveryRoleIds.includes(shift.roleId)
      if (!productionRoute && !deliveryRoute) add('error', 'SHIFT_WORKSTATION_ROLE_MISMATCH', `班次 ${shift.id} 的岗位不能路由到工作站 ${stationId}`, 'shiftAssignments', row, 'stationIds')
      if (productionRoute && employee) {
        const missingSkills = station.requiredSkillIds.filter((skillId) => !(employee.skillIds ?? []).includes(skillId))
        if (missingSkills.length > 0) add('error', 'SHIFT_WORKSTATION_SKILL_MISMATCH', `班次 ${shift.id} 缺少工作站 ${stationId} 所需技能 ${missingSkills.join('、')}`, 'shiftAssignments', row, 'stationIds')
      }
    }
    if (Date.parse(shift.startAt) >= Date.parse(shift.endAt)) add('error', 'SHIFT_TIME_INVALID', `班次 ${shift.id} 结束时间必须晚于开始时间`, 'shiftAssignments', row, 'endAt')
  }
  const activeShifts = candidate.shiftAssignments.filter((shift) => shift.status !== 'cancelled')
  for (let leftIndex = 0; leftIndex < activeShifts.length; leftIndex += 1) {
    const left = activeShifts[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < activeShifts.length; rightIndex += 1) {
      const right = activeShifts[rightIndex]!
      if (left.employeeId === right.employeeId && Date.parse(left.startAt) < Date.parse(right.endAt) && Date.parse(left.endAt) > Date.parse(right.startAt)) {
        add('error', 'SHIFT_OVERLAP', `员工 ${left.employeeId} 的班次 ${left.id} 与 ${right.id} 重叠`, 'shiftAssignments', rowOf('shiftAssignments', right.id), 'startAt')
      }
    }
  }

  const coverageShifts = activeShifts.filter((shift) => shift.businessDate === candidate.store.businessDate)
  const coverage = (areaId: string, roleGroup: readonly string[], primaryOnly = false) => coverageShifts.some((shift) => {
    const employee = employees.get(shift.employeeId)
    return employee?.status === 'active' && shift.areaIds.includes(areaId) && employee.areaIds.includes(areaId) && roleGroup.includes(shift.roleId) && (!primaryOnly || shift.isPrimary)
  })
  for (const area of candidate.areas) {
    const row = rowOf('areas', area.id)
    if (!candidate.tables.some((table) => table.areaId === area.id)) add('warning', 'AREA_WITHOUT_TABLE', `区域 ${area.id} 没有桌台`, 'areas', row, 'id')
    const checks: Array<[string, readonly string[], boolean]> = [
      ['主责', input.policy.responsibilityRoles.primaryRoleIds, true],
      ['候补', input.policy.responsibilityRoles.backupRoleIds, false],
      ['领班', input.policy.responsibilityRoles.supervisorRoleIds, false],
      ['经理', input.policy.responsibilityRoles.managerRoleIds, false],
    ]
    for (const [label, roles, primaryOnly] of checks) {
      if (!coverage(area.id, roles, primaryOnly)) add('error', 'RESPONSIBILITY_CHAIN_INCOMPLETE', `区域 ${area.id} 在营业日 ${candidate.store.businessDate} 缺少${label}班次覆盖`, 'areas', row, 'id')
    }
  }

  for (const product of candidate.products) {
    const row = rowOf('products', product.id)
    if (product.costAmount > product.listPriceAmount) add('error', 'PRODUCT_COST_EXCEEDS_PRICE', `商品 ${product.sku} 成本不能高于标价`, 'products', row, 'costAmount')
    if (!input.policy.allowZeroListPrice && product.listPriceAmount === 0) add('error', 'ZERO_PRICE_FORBIDDEN', `商品 ${product.sku} 标价为0，但导入策略不允许零价`, 'products', row, 'listPriceAmount')
    if (product.configVersion > candidate.config.version) add('error', 'PRODUCT_VERSION_AHEAD_OF_CONFIG', `商品 ${product.sku} 的配置版本不能高于门店配置版本`, 'products', row, 'configVersion')
    if (!workstations.has(product.stationId)) add('error', 'WORKSTATION_REFERENCE_MISSING', `商品 ${product.sku} 的工作站不存在`, 'products', row, 'stationId')
    const currentProduct = state.products.find((item) => item.id === product.id)
    if (currentProduct && !sameValue(currentProduct, product) && product.configVersion <= currentProduct.configVersion) {
      add('error', 'PRODUCT_VERSION_NOT_MONOTONIC', `已变更商品 ${product.sku} 的配置版本必须大于当前版本 ${currentProduct.configVersion}`, 'products', row, 'configVersion')
    }
  }

  for (const authority of candidate.authorizationAuthorities) {
    const row = rowOf('authorizationAuthorities', authority.id)
    const actor = employees.get(authority.actorId)
    if (!actor || actor.status !== 'active') add('error', 'AUTHORITY_ACTOR_INVALID', `权限 ${authority.id} 的员工不存在或已停用`, 'authorizationAuthorities', row, 'actorId')
    if (new Set(authority.kinds).size !== authority.kinds.length) add('error', 'AUTHORITY_KIND_DUPLICATE', `权限 ${authority.id} 的类型重复`, 'authorizationAuthorities', row, 'kinds')
    if (Date.parse(authority.validFrom) >= Date.parse(authority.validUntil)) add('error', 'AUTHORITY_TIME_INVALID', `权限 ${authority.id} 的结束时间必须晚于开始时间`, 'authorizationAuthorities', row, 'validUntil')
    if (authority.maxAmount === 0) add('warning', 'AUTHORITY_ZERO_LIMIT', `权限 ${authority.id} 额度为0，不会产生实际授权能力`, 'authorizationAuthorities', row, 'maxAmount')
    if (authority.allowedSkuIds) {
      if (new Set(authority.allowedSkuIds).size !== authority.allowedSkuIds.length) add('error', 'AUTHORITY_PRODUCT_DUPLICATE', `权限 ${authority.id} 的商品白名单重复`, 'authorizationAuthorities', row, 'allowedSkuIds')
      for (const productId of authority.allowedSkuIds) {
        if (!products.has(productId)) add('error', 'PRODUCT_REFERENCE_MISSING', `权限 ${authority.id} 引用了不存在的商品ID ${productId}`, 'authorizationAuthorities', row, 'allowedSkuIds')
      }
    }
    if (authority.tableSessionIds) {
      if (new Set(authority.tableSessionIds).size !== authority.tableSessionIds.length) add('error', 'AUTHORITY_SESSION_DUPLICATE', `权限 ${authority.id} 的桌台会话重复`, 'authorizationAuthorities', row, 'tableSessionIds')
      for (const sessionId of authority.tableSessionIds) {
        if (!tableSessions.has(sessionId)) add('error', 'TABLE_SESSION_REFERENCE_MISSING', `权限 ${authority.id} 引用了不存在的桌台会话 ${sessionId}`, 'authorizationAuthorities', row, 'tableSessionIds')
      }
    }
    const importedAuthority = input.data.authorizationAuthorities.find((item) => item.id === authority.id)
    if (importedAuthority) {
      if (importedAuthority.approval.operationsApproverId === importedAuthority.approval.financeApproverId) add('error', 'AUTHORITY_APPROVAL_NOT_SEPARATED', `权限 ${authority.id} 的经营与财务审批人必须不同`, 'authorizationAuthorities', row, 'approval')
      if (Date.parse(importedAuthority.approval.approvedAt) > Date.parse(input.createdAt)) add('error', 'AUTHORITY_APPROVED_AFTER_PACKAGE', `权限 ${authority.id} 的审批时间不能晚于导入包创建时间`, 'authorizationAuthorities', row, 'approval.approvedAt')
    }
  }
  for (let leftIndex = 0; leftIndex < candidate.authorizationAuthorities.length; leftIndex += 1) {
    const left = candidate.authorizationAuthorities[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < candidate.authorizationAuthorities.length; rightIndex += 1) {
      const right = candidate.authorizationAuthorities[rightIndex]!
      const commonKind = left.kinds.some((kind) => right.kinds.includes(kind))
      const overlaps = Date.parse(left.validFrom) < Date.parse(right.validUntil) && Date.parse(left.validUntil) > Date.parse(right.validFrom)
      if (left.actorId === right.actorId && commonKind && overlaps) add('error', 'AUTHORITY_PERIOD_OVERLAP', `员工 ${left.actorId} 的权限 ${left.id} 与 ${right.id} 类型和有效期重叠`, 'authorizationAuthorities', rowOf('authorizationAuthorities', right.id), 'validFrom')
    }
  }

  const tableIds = new Set(candidate.tables.map((table) => table.id))
  for (const task of state.tasks.filter((task) => !['completed', 'confirmed', 'cancelled'].includes(task.status))) {
    if (!tableIds.has(task.tableId)) add('error', 'OPEN_TASK_TABLE_REMOVED', `未关闭任务 ${task.id} 引用的桌台将被移除`, 'tables')
    if (task.ownerId && employees.get(task.ownerId)?.status !== 'active') add('error', 'OPEN_TASK_OWNER_REMOVED', `未关闭任务 ${task.id} 的责任员工将被移除或停用`, 'employees')
    if (!serviceTypeIds.has(task.serviceTypeId)) add('error', 'OPEN_TASK_SERVICE_TYPE_REMOVED', `未关闭任务 ${task.id} 的服务类型将被移除`, 'config')
  }
  for (const intent of state.awaitingOrderIntents.filter((intent) => intent.status === 'active')) {
    if (!tableIds.has(intent.tableId)) add('error', 'ACTIVE_INTENT_TABLE_REMOVED', `进行中的点单关怀 ${intent.id} 引用的桌台将被移除`, 'tables')
  }
  for (const entry of state.waitlistEntries.filter((item) => ['waiting', 'notified'].includes(item.status))) {
    if (!entry.heldTableId) continue
    const table = candidate.tables.find((item) => item.id === entry.heldTableId)
    if (!table) add('error', 'WAITLIST_HELD_TABLE_REMOVED', `候补 ${entry.id} 锁定的桌台将被移除`, 'tables')
    else if (entry.heldTableCode && table.code !== entry.heldTableCode) add('error', 'WAITLIST_HELD_TABLE_CODE_CHANGED', `候补 ${entry.id} 锁定桌台编号不能变更`, 'tables', rowOf('tables', table.id), 'code')
  }
  for (const session of state.songState.tableSessions.filter((session) => session.status === 'open')) {
    const table = candidate.tables.find((item) => item.id === session.tableId)
    if (!table) add('error', 'OPEN_SESSION_TABLE_REMOVED', `开放桌台会话 ${session.id} 的桌台将被移除`, 'tables')
    else if (table.code !== session.tableCode) add('error', 'OPEN_SESSION_TABLE_CODE_CHANGED', `开放桌台会话 ${session.id} 对应桌台编号不能变更`, 'tables', rowOf('tables', table.id), 'code')
  }
  for (const member of state.members) {
    if (member.salesOwnerId && !employees.has(member.salesOwnerId)) add('error', 'MEMBER_OWNER_REMOVED', `会员 ${member.id} 的销售归属员工将被移除`, 'employees')
  }
  for (const managerActorId of state.songState.managerActorIds) {
    const manager = employees.get(managerActorId)
    if (!manager || manager.status !== 'active' || !input.policy.responsibilityRoles.managerRoleIds.includes(manager.roleId)) add('error', 'SONG_MANAGER_REMOVED', `点歌域经理 ${managerActorId} 将被移除、停用或不再属于经理岗位组`, 'employees')
  }
  for (const template of state.benefitTemplates) {
    if (template.productId && !products.has(template.productId)) add('error', 'BENEFIT_PRODUCT_REMOVED', `权益模板 ${template.id} 引用的商品将被移除`, 'products')
  }
  for (const policy of state.benefitGrantPolicies) {
    if (!roleIds.has(policy.roleId)) add('error', 'BENEFIT_ROLE_REMOVED', `权益策略 ${policy.id} 引用的岗位将被移除`, 'config')
  }
  for (const order of state.orderDomain.orders.filter((order) => order.status !== 'fulfilled')) {
    for (const item of order.items) {
      if (!products.has(item.skuId)) add('error', 'OPEN_ORDER_PRODUCT_REMOVED', `未履约订单 ${order.id} 引用的商品将被移除`, 'products')
    }
  }
  if (candidate.store.businessDate !== state.store.businessDate) {
  const hasLiveWork = state.tasks.some((task) => !['completed', 'confirmed', 'cancelled'].includes(task.status)) ||
      state.awaitingOrderIntents.some((intent) => intent.status === 'active') ||
      state.waitlistEntries.some((entry) => ['waiting', 'notified'].includes(entry.status)) ||
      state.songState.tableSessions.some((session) => session.status === 'open')
    if (hasLiveWork) add('error', 'BUSINESS_DATE_CHANGE_WITH_LIVE_WORK', '存在进行中任务或桌台会话时不能切换营业日', 'store', null, 'businessDate')
  }

  return issues
}

function parsedPreflight(state: RuntimeState, input: StoreImportPackage) {
  const candidate = buildCandidate(state, input)
  const preview = buildPreview(state, candidate)
  const issues = semanticIssues(state, input, candidate)
  return { candidate, preview, issues }
}

export function preflightStoreImportPackage(state: RuntimeState, input: unknown): StoreImportPreflightResult {
  const parsed = parseImportPackage(input)
  if (!parsed.success) return { valid: false, issues: parsed.issues, preview: null }
  const { preview, issues } = parsedPreflight(state, parsed.data)
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues: structuredClone(issues),
    preview: structuredClone(preview),
  }
}

export function previewStoreImportPackage(state: RuntimeState, input: unknown): StoreImportPreview {
  const result = preflightStoreImportPackage(state, input)
  if (!result.preview) throw new StoreImportValidationError(result.issues)
  return result.preview
}

function configVersionRecordId(storeId: string, version: number) {
  return `config_version_${storeId}_${version}`
}

function appendImportedConfigVersion(
  state: RuntimeState,
  sourceVersion: number,
  input: StoreImportPackage,
  command: StoreImportApplyCommand,
) {
  const config = state.config
  state.configVersions.push({
    id: configVersionRecordId(state.store.id, config.version),
    storeId: state.store.id,
    version: config.version,
    operation: 'publish',
    sourceVersion,
    rollbackTargetVersion: null,
    snapshot: structuredClone(config),
    actorId: command.actorId,
    reason: command.reason,
    idempotencyKey: `store-import:${input.packageId}:${input.packageVersion}`,
    createdAt: command.occurredAt,
  })
}

export function applyStoreImportPackage(
  sourceState: RuntimeState,
  rawInput: unknown,
  rawCommand: StoreImportApplyCommand,
): StoreImportApplyResult {
  const parsedInput = parseImportPackage(rawInput)
  if (!parsedInput.success) throw new StoreImportValidationError(parsedInput.issues)
  const input = parsedInput.data
  const command = storeImportApplyCommandSchema.parse(rawCommand)
  const { candidate, preview, issues } = parsedPreflight(sourceState, input)
  if (Date.parse(command.occurredAt) < Date.parse(input.createdAt)) {
    issues.push({
      severity: 'error',
      code: 'APPLY_BEFORE_PACKAGE_CREATED',
      message: '应用时间不能早于导入包创建时间',
      section: 'package',
      row: null,
      field: 'createdAt',
    })
  }
  if (issues.some((issue) => issue.severity === 'error')) throw new StoreImportValidationError(issues)

  const auditId = `audit_store_import_${input.packageId}_${input.packageVersion}`
  if (sourceState.auditEntries.some((entry) => entry.id === auditId)) {
    throw new Error(`导入包 ${input.packageId} v${input.packageVersion} 已应用`)
  }

  const state = structuredClone(sourceState)
  const sourceConfigVersion = state.config.version
  const configChanged = !sameValue(state.config, candidate.config)
  state.store = structuredClone(candidate.store)
  state.config = structuredClone(candidate.config)
  state.areas = structuredClone(candidate.areas)
  state.tables = structuredClone(candidate.tables)
  state.employees = structuredClone(candidate.employees)
  state.shiftAssignments = structuredClone(candidate.shiftAssignments)
  state.products = structuredClone(candidate.products)
  state.orderDomain.authorizationAuthorities = structuredClone(candidate.authorizationAuthorities)
  if (configChanged) appendImportedConfigVersion(state, sourceConfigVersion, input, command)

  const changedSections = Object.entries(preview)
    .filter(([, diff]) => diff.added + diff.updated + diff.removed > 0)
    .map(([section]) => section)
  const auditEntry: AuditEntry = {
    id: auditId,
    actorId: command.actorId,
    action: 'store.master_data_imported.v1',
    objectType: 'store',
    objectId: state.store.id,
    occurredAt: command.occurredAt,
    details: {
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      source: input.source,
      reason: command.reason,
      target: input.policy.target,
      changedSections,
      warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    },
  }
  state.auditEntries.push(auditEntry)
  state.revision += 1
  return { state, preview: structuredClone(preview), auditEntry: structuredClone(auditEntry) }
}
