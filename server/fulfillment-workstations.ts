import type {
  FulfillmentWorkstationConfig,
  KdsTask,
  OrderDomainState,
} from '../src/shared/order-contracts.js'
import type { RuntimeState, WorkstationConfig } from '../src/shared/contracts.js'

const FALLBACK_PRODUCTION_ROLE_IDS = ['specialist']
const FALLBACK_DELIVERY_ROLE_IDS = ['server', 'backup', 'specialist']
export const defaultDeliveryServiceTypeId = 'fulfillment-delivery'

export const defaultFulfillmentWorkstations: readonly FulfillmentWorkstationConfig[] = [
  {
    id: 'bar-main',
    name: '主吧台',
    productionRoleIds: FALLBACK_PRODUCTION_ROLE_IDS,
    deliveryRoleIds: FALLBACK_DELIVERY_ROLE_IDS,
    requiredSkillIds: [],
    deliveryServiceTypeId: defaultDeliveryServiceTypeId,
    productionSlaSeconds: 180,
    pickupSlaSeconds: 90,
    configVersion: 1,
  },
  {
    id: 'kitchen-cold',
    name: '冷菜间',
    productionRoleIds: FALLBACK_PRODUCTION_ROLE_IDS,
    deliveryRoleIds: FALLBACK_DELIVERY_ROLE_IDS,
    requiredSkillIds: [],
    deliveryServiceTypeId: defaultDeliveryServiceTypeId,
    productionSlaSeconds: 300,
    pickupSlaSeconds: 120,
    configVersion: 1,
  },
  {
    id: 'kitchen-hot',
    name: '热厨',
    productionRoleIds: FALLBACK_PRODUCTION_ROLE_IDS,
    deliveryRoleIds: FALLBACK_DELIVERY_ROLE_IDS,
    requiredSkillIds: [],
    deliveryServiceTypeId: defaultDeliveryServiceTypeId,
    productionSlaSeconds: 600,
    pickupSlaSeconds: 120,
    configVersion: 1,
  },
]

function cloneWorkstation(workstation: FulfillmentWorkstationConfig): FulfillmentWorkstationConfig {
  return {
    ...workstation,
    productionRoleIds: [...workstation.productionRoleIds],
    deliveryRoleIds: [...workstation.deliveryRoleIds],
    requiredSkillIds: [...workstation.requiredSkillIds],
  }
}

function assertIdentifier(value: string, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正安全整数`)
}

export function validateFulfillmentWorkstations(workstations: FulfillmentWorkstationConfig[]) {
  if (new Set(workstations.map((workstation) => workstation.id)).size !== workstations.length) {
    throw new Error('工作站ID不能重复')
  }
  for (const workstation of workstations) {
    assertIdentifier(workstation.id, '工作站ID')
    assertIdentifier(workstation.name, '工作站名称')
    if (workstation.productionRoleIds.length === 0) throw new Error('工作站必须配置制作岗位')
    if (workstation.deliveryRoleIds.length === 0) throw new Error('工作站必须配置取送岗位')
    workstation.deliveryServiceTypeId ??= defaultDeliveryServiceTypeId
    assertIdentifier(workstation.deliveryServiceTypeId, '取送服务类型ID')
    workstation.productionRoleIds.forEach((roleId) => assertIdentifier(roleId, '制作岗位ID'))
    workstation.deliveryRoleIds.forEach((roleId) => assertIdentifier(roleId, '取送岗位ID'))
    workstation.requiredSkillIds.forEach((skillId) => assertIdentifier(skillId, '技能ID'))
    if (new Set(workstation.productionRoleIds).size !== workstation.productionRoleIds.length) {
      throw new Error('工作站制作岗位不能重复')
    }
    if (new Set(workstation.deliveryRoleIds).size !== workstation.deliveryRoleIds.length) {
      throw new Error('工作站取送岗位不能重复')
    }
    assertPositiveInteger(workstation.productionSlaSeconds, '制作SLA')
    assertPositiveInteger(workstation.pickupSlaSeconds, '取货SLA')
    assertPositiveInteger(workstation.configVersion, '工作站配置版本')
  }
}

function legacyWorkstation(stationId: string): FulfillmentWorkstationConfig {
  return {
    id: stationId,
    name: stationId,
    productionRoleIds: [...FALLBACK_PRODUCTION_ROLE_IDS],
    deliveryRoleIds: [...FALLBACK_DELIVERY_ROLE_IDS],
    requiredSkillIds: [],
    deliveryServiceTypeId: defaultDeliveryServiceTypeId,
    productionSlaSeconds: 300,
    pickupSlaSeconds: 120,
    configVersion: 1,
  }
}

function isoAfter(value: string, seconds: number) {
  return new Date(Date.parse(value) + seconds * 1000).toISOString()
}

/** Hydrates fields absent from pre-fulfillment persisted order states in place. */
export function normalizeOrderFulfillmentState(state: OrderDomainState) {
  state.orders ??= []
  state.authorizations ??= []
  state.authorizationAuthorities ??= []
  state.kdsTasks ??= []
  state.tableLedgerEntries ??= []
  state.idempotencyRecords ??= []

  if (!state.fulfillmentWorkstations) {
    const legacyStationIds = new Set([
      ...state.orders.flatMap((order) => order.items.map((item) => item.stationId)),
      ...state.kdsTasks.map((task) => task.stationId),
    ])
    const defaults = defaultFulfillmentWorkstations.map(cloneWorkstation)
    const defaultIds = new Set(defaults.map((workstation) => workstation.id))
    state.fulfillmentWorkstations = [
      ...defaults,
      ...[...legacyStationIds]
        .filter((stationId) => stationId && !defaultIds.has(stationId))
        .map(legacyWorkstation),
    ]
  }
  validateFulfillmentWorkstations(state.fulfillmentWorkstations)

  for (const task of state.kdsTasks) {
    const configured = state.fulfillmentWorkstations.find((workstation) => workstation.id === task.stationId)
      ?? legacyWorkstation(task.stationId)
    task.workstation ??= cloneWorkstation(configured)
    task.productionSla ??= {
      targetSeconds: task.workstation.productionSlaSeconds,
      dueAt: isoAfter(task.queuedAt, task.workstation.productionSlaSeconds),
    }
    task.pickupSla ??= {
      targetSeconds: task.workstation.pickupSlaSeconds,
      dueAt: task.completedAt ? isoAfter(task.completedAt, task.workstation.pickupSlaSeconds) : null,
    }
    task.deliveryServiceTask ??= null
  }
  return state
}

export function configuredFulfillmentWorkstations(state: OrderDomainState) {
  normalizeOrderFulfillmentState(state)
  return state.fulfillmentWorkstations!
}

export function resolveFulfillmentWorkstation(state: OrderDomainState, stationId: string) {
  const workstation = configuredFulfillmentWorkstations(state).find((item) => item.id === stationId)
  if (!workstation) throw new Error(`商品未配置有效工作站：${stationId}`)
  return cloneWorkstation(workstation)
}

function runtimeWorkstationSnapshot(
  workstation: WorkstationConfig,
  configVersion: number,
): FulfillmentWorkstationConfig {
  return {
    id: workstation.id,
    name: workstation.name,
    productionRoleIds: [...workstation.productionRoleIds],
    deliveryRoleIds: [...workstation.deliveryRoleIds],
    requiredSkillIds: [...workstation.requiredSkillIds],
    deliveryServiceTypeId: workstation.deliveryServiceTypeId ?? defaultDeliveryServiceTypeId,
    productionSlaSeconds: workstation.productionSlaSeconds,
    pickupSlaSeconds: workstation.pickupSlaSeconds,
    configVersion,
  }
}

/** StoreConfig is the editable source; OrderDomain only receives an enabled runtime mirror. */
export function syncOrderFulfillmentWorkstations(state: RuntimeState) {
  const workstations = state.config.workstations
    .filter((workstation) => workstation.enabled)
    .map((workstation) => runtimeWorkstationSnapshot(workstation, state.config.version))
  validateFulfillmentWorkstations(workstations)
  state.orderDomain.fulfillmentWorkstations = workstations
  return workstations
}

export function routeProductToEnabledWorkstation(state: RuntimeState, configuredStationId: string) {
  const visited = new Set<string>()
  let stationId: string | null = configuredStationId
  while (stationId) {
    if (visited.has(stationId)) throw new Error(`商品工作站兜底配置形成循环：${configuredStationId}`)
    visited.add(stationId)
    const workstation = state.config.workstations.find((item) => item.id === stationId)
    if (!workstation) throw new Error(`商品工作站不存在：${stationId}`)
    if (workstation.enabled) return resolveFulfillmentWorkstation(state.orderDomain, workstation.id)
    stationId = workstation.fallbackStationId
  }
  throw new Error(`商品工作站已停用且未配置可用兜底：${configuredStationId}`)
}

export function resolveKdsWorkstation(state: OrderDomainState, task: KdsTask) {
  normalizeOrderFulfillmentState(state)
  return cloneWorkstation(task.workstation ?? resolveFulfillmentWorkstation(state, task.stationId))
}

export function allowedFulfillmentRoleIds(
  state: RuntimeState,
  task: KdsTask,
  action: 'start' | 'complete' | 'pickUp' | 'deliver',
) {
  const workstation = state.config.workstations.find((item) => item.id === task.stationId)
    ?? resolveKdsWorkstation(state.orderDomain, task)
  const configuredRoleIds = ['start', 'complete'].includes(action)
    ? workstation.productionRoleIds
    : workstation.deliveryRoleIds
  return [...new Set(configuredRoleIds)]
}
