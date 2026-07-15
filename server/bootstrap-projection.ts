import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import type { RuntimeState, StaffPermissionId } from '../src/shared/contracts.js'
import {
  assignedAreaIdsForActor,
  canActorAccessTableDataScope,
  effectiveActorForState,
} from './authorization.js'

function effectiveRoleId(state: RuntimeState, actor: RequestActorContext) {
  return effectiveActorForState(actor, state).roleId
}

function legacyTableIdFromSession(tableSessionId: string) {
  if (!tableSessionId.startsWith('session:')) return null
  return tableSessionId.slice('session:'.length).split(':')[0] ?? null
}

/** Returns the maximum data this authenticated role needs for its configured workspace. */
export function projectRuntimeStateForActor(state: RuntimeState, actor: RequestActorContext): RuntimeState {
  const projected = structuredClone(state)
  const role = state.config.roles.find((item) => item.id === effectiveRoleId(state, actor))
  const permissions = new Set<StaffPermissionId>(role?.permissionIds ?? [])
  const scope = role?.dataScope ?? 'own'
  const canAccessProjectedStore = scope === 'all_stores' || actor.storeId === state.store.id
  const visibleAreaIds = new Set(canAccessProjectedStore ? assignedAreaIdsForActor(state, actor.actorId) : [])
  const storeWide = scope === 'all_stores' || (scope === 'store' && actor.storeId === state.store.id)

  const visibleTables = state.tables.filter((table) => canActorAccessTableDataScope(state, actor, table.id))
  const visibleTableIds = new Set(visibleTables.map((table) => table.id))
  const sessionTableIds = new Map(state.songState.tableSessions.map((session) => [session.id, session.tableId]))
  const sessionVisible = (tableSessionId: string) => {
    const tableId = sessionTableIds.get(tableSessionId) ?? legacyTableIdFromSession(tableSessionId)
    return tableId != null && visibleTableIds.has(tableId)
  }

  projected.tables = structuredClone(visibleTables)
  projected.areas = projected.areas.filter((area) => canAccessProjectedStore && (
    storeWide || visibleAreaIds.has(area.id) || visibleTables.some((table) => table.areaId === area.id)
  ))
  projected.tasks = projected.tasks.filter((task) => canAccessProjectedStore && (
    storeWide || task.ownerId === actor.actorId || visibleTableIds.has(task.tableId)
  ))
  const visibleTaskIds = new Set(projected.tasks.map((task) => task.id))
  projected.taskEvents = projected.taskEvents.filter((event) => visibleTaskIds.has(event.taskId))
  projected.awaitingOrderIntents = projected.awaitingOrderIntents.filter((intent) => (
    canAccessProjectedStore && visibleTableIds.has(intent.tableId)
  ))
  projected.tableTransfers = (projected.tableTransfers ?? []).filter((record) => (
    canAccessProjectedStore && (storeWide || visibleTableIds.has(record.sourceTableId) || visibleTableIds.has(record.targetTableId))
  ))
  const canUseWaitlist = permissions.has('reservation.view') || permissions.has('reservation.manage')
  projected.waitlistEntries = canUseWaitlist && canAccessProjectedStore
    ? projected.waitlistEntries
    : []

  const canViewOrders = permissions.has('order.view')
  const canUseKds = permissions.has('kds.prepare') || permissions.has('kds.deliver')
  const activeShiftStationIds = new Set(state.shiftAssignments
    .filter((shift) => (
      shift.employeeId === actor.actorId
      && shift.businessDate === state.store.businessDate
      && shift.status === 'active'
    ))
    .flatMap((shift) => shift.stationIds ?? []))
  const workstationTaskVisible = (task: RuntimeState['orderDomain']['kdsTasks'][number]) => {
    if (!canAccessProjectedStore) return false
    if (!activeShiftStationIds.has(task.stationId)) return false
    const workstation = task.workstation
      ?? state.orderDomain.fulfillmentWorkstations?.find((item) => item.id === task.stationId)
      ?? state.config.workstations.find((item) => item.id === task.stationId)
    if (!workstation) return false
    return (permissions.has('kds.prepare') && workstation.productionRoleIds.includes(role?.id ?? ''))
      || (permissions.has('kds.deliver') && workstation.deliveryRoleIds.includes(role?.id ?? ''))
  }
  projected.orderDomain.orders = canViewOrders
    ? projected.orderDomain.orders.filter((order) => storeWide || sessionVisible(order.tableSessionId))
    : []
  const visibleOrderIds = new Set(projected.orderDomain.orders.map((order) => order.id))
  projected.orderDomain.kdsTasks = canUseKds || canViewOrders
    ? projected.orderDomain.kdsTasks.filter((task) => (
      storeWide || sessionVisible(task.tableSessionId) || workstationTaskVisible(task)
    ))
    : []
  projected.orderDomain.authorizations = canViewOrders
    ? projected.orderDomain.authorizations.filter((authorization) => visibleOrderIds.has(authorization.orderId))
    : []
  projected.orderDomain.tableLedgerEntries = canViewOrders
    ? projected.orderDomain.tableLedgerEntries.filter((entry) => storeWide || sessionVisible(entry.tableSessionId))
    : []
  projected.orderDomain.authorizationAuthorities = permissions.has('commerce.authorization.approve')
    ? projected.orderDomain.authorizationAuthorities
    : projected.orderDomain.authorizationAuthorities.filter((authority) => authority.actorId === actor.actorId)
  projected.orderDomain.idempotencyRecords = []

  const canViewFinance = permissions.has('finance.view')
  if (!canViewFinance) {
    projected.products = projected.products.map((product) => ({ ...product, costAmount: 0 }))
    projected.orderDomain.orders = projected.orderDomain.orders.map((order) => ({
      ...order,
      items: order.items.map((item) => ({ ...item, unitCostAmount: 0 })),
    }))
  }
  const canUsePayments = canViewFinance || [
    'payment.collect', 'payment.pos_report', 'payment.refund.request', 'payment.refund.approve',
  ].some((permission) => permissions.has(permission as StaffPermissionId))
  if (!canUsePayments) {
    projected.paymentDomain = {
      paymentIntents: [], paymentNotifications: [], paymentStatusQueries: [],
      physicalPosReports: [], refunds: [], idempotencyRecords: [],
    }
  } else {
    projected.paymentDomain.paymentIntents = projected.paymentDomain.paymentIntents.filter((intent) => storeWide || sessionVisible(intent.tableSessionId))
    const intentIds = new Set(projected.paymentDomain.paymentIntents.map((intent) => intent.id))
    projected.paymentDomain.refunds = projected.paymentDomain.refunds.filter((refund) => intentIds.has(refund.paymentIntentId))
    projected.paymentDomain.paymentNotifications = []
    projected.paymentDomain.paymentStatusQueries = []
    projected.paymentDomain.idempotencyRecords = []
  }

  const canUseInventory = ['inventory.view', 'inventory.manage', 'inventory.approve']
    .some((permission) => permissions.has(permission as StaffPermissionId))
  if (!canUseInventory || !canAccessProjectedStore) projected.inventoryDomain = undefined
  else if (projected.inventoryDomain) projected.inventoryDomain.idempotencyRecords = []

  const canUseReservations = ['reservation.view', 'reservation.manage', 'reservation.config.manage']
    .some((permission) => permissions.has(permission as StaffPermissionId))
  if (!canUseReservations || !canAccessProjectedStore) projected.reservationState = undefined
  else if (projected.reservationState) projected.reservationState.idempotencyRecords = []

  const canUseBenefits = ['benefit.view', 'benefit.grant', 'benefit.approve', 'benefit.manage']
    .some((permission) => permissions.has(permission as StaffPermissionId))
  if (!canUseBenefits || !canAccessProjectedStore) {
    projected.members = []
    projected.benefitTemplates = []
    projected.benefitGrantPolicies = []
    projected.benefitGrantRequests = []
    projected.memberBenefits = []
    projected.benefitRedemptions = []
    projected.benefitCampaigns = []
    projected.customerNotifications = []
  }

  if (!permissions.has('audit.view') || !canAccessProjectedStore) projected.auditEntries = []
  if (!permissions.has('config.manage')) {
    projected.draftConfig = null
    projected.configVersions = []
  }

  const referencedEmployeeIds = new Set([
    actor.actorId,
    ...projected.tables.flatMap((table) => [table.primaryEmployeeId, ...table.backupEmployeeIds]),
    ...projected.tasks.flatMap((task) => [task.ownerId, ...task.notifiedEmployeeIds]).filter((id): id is string => Boolean(id)),
  ])
  if (!canAccessProjectedStore) {
    projected.employees = []
    projected.shiftAssignments = []
  } else if (!permissions.has('identity.manage') && !permissions.has('shift.manage')) {
    projected.employees = projected.employees.filter((item) => referencedEmployeeIds.has(item.id))
    projected.shiftAssignments = projected.shiftAssignments.filter((shift) => shift.employeeId === actor.actorId)
  }

  return projected
}
