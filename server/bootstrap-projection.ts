import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import type { RuntimeState, StaffPermissionId } from '../src/shared/contracts.js'
import {
  assignedAreaIdsForActor,
  canActorAccessTableDataScope,
  effectiveActorForState,
} from './authorization.js'
import {
  effectiveDataScopeForEmployee,
  effectivePermissionIdsForEmployee,
} from '../src/shared/staff-access.js'
import { venueBusinessDateKey } from '../src/shared/venue-time.js'
import { tableSessionBusinessDate } from './table-sessions.js'

function retainCurrentOperationalData(
  projected: RuntimeState,
  currentSessionIds: ReadonlySet<string>,
  currentActorId: string,
) {
  const businessDate = projected.store.businessDate
  const rolloverHour = projected.tableOperationsConfig?.businessDayRolloverHour ?? 6
  const isCurrentTimestamp = (timestamp: string | null | undefined) => {
    if (!timestamp) return false
    try {
      return venueBusinessDateKey(timestamp, projected.store.timezone, rolloverHour) === businessDate
    } catch {
      return false
    }
  }
  const currentSessions = projected.songState.tableSessions.filter((session) => currentSessionIds.has(session.id))

  projected.presenceLeases = (projected.presenceLeases ?? []).filter((lease) => lease.businessDate === businessDate)
  projected.shiftAssignments = projected.shiftAssignments.filter((shift) => (
    shift.businessDate >= businessDate || shift.employeeId === currentActorId
  ))
  projected.tasks = projected.tasks.filter((task) => (
    task.archivedAt === null
    && (task.tableSessionId ? currentSessionIds.has(task.tableSessionId) : isCurrentTimestamp(task.createdAt))
  ))
  const retainedTaskIds = new Set(projected.tasks.map((task) => task.id))
  projected.taskEvents = projected.taskEvents.filter((event) => retainedTaskIds.has(event.taskId))
  projected.auditEntries = projected.auditEntries.filter((entry) => isCurrentTimestamp(entry.occurredAt))
  projected.awaitingOrderIntents = projected.awaitingOrderIntents.filter((intent) => (
    isCurrentTimestamp(intent.startedAt)
  ))
  projected.tableTransfers = projected.tableTransfers.filter((record) => (
    currentSessionIds.has(record.tableSessionId) || isCurrentTimestamp(record.occurredAt)
  ))
  projected.tableSessionOperations = (projected.tableSessionOperations ?? []).filter((record) => (
    currentSessionIds.has(record.tableSessionId)
  ))
  projected.salesAttributionRecords = (projected.salesAttributionRecords ?? []).filter((record) => (
    isCurrentTimestamp(record.occurredAt)
  ))
  projected.tableCombinationRecords = (projected.tableCombinationRecords ?? []).filter((record) => (
    currentSessionIds.has(record.primaryTableSessionId) || currentSessionIds.has(record.relatedTableSessionId)
  ))
  projected.waitlistEntries = projected.waitlistEntries.filter((entry) => isCurrentTimestamp(entry.joinedAt))

  projected.sopExecutions = (projected.sopExecutions ?? []).filter((execution) => (
    currentSessionIds.has(execution.tableSessionId) || isCurrentTimestamp(execution.startedAt)
  ))
  const retainedSopExecutionIds = new Set(projected.sopExecutions.map((execution) => execution.id))
  projected.sopActionRecords = (projected.sopActionRecords ?? []).filter((record) => (
    retainedSopExecutionIds.has(record.executionId)
  ))
  projected.dutyManagerIncidents = (projected.dutyManagerIncidents ?? []).filter((incident) => (
    incident.businessDate === businessDate
  ))

  projected.orderDomain.orders = projected.orderDomain.orders.filter((order) => currentSessionIds.has(order.tableSessionId))
  const currentOrderIds = new Set(projected.orderDomain.orders.map((order) => order.id))
  projected.orderDomain.kdsTasks = projected.orderDomain.kdsTasks.filter((task) => currentSessionIds.has(task.tableSessionId))
  projected.orderDomain.authorizations = projected.orderDomain.authorizations.filter((authorization) => (
    currentOrderIds.has(authorization.orderId)
  ))
  projected.orderDomain.tableLedgerEntries = projected.orderDomain.tableLedgerEntries.filter((entry) => (
    currentSessionIds.has(entry.tableSessionId)
  ))

  projected.paymentDomain.paymentIntents = projected.paymentDomain.paymentIntents.filter((intent) => (
    currentSessionIds.has(intent.tableSessionId) || intent.businessDate === businessDate
  ))
  const currentPaymentIntentIds = new Set(projected.paymentDomain.paymentIntents.map((intent) => intent.id))
  projected.paymentDomain.physicalPosReports = projected.paymentDomain.physicalPosReports.filter((report) => (
    currentSessionIds.has(report.tableSessionId)
  ))
  projected.paymentDomain.cashPaymentConfirmations = (projected.paymentDomain.cashPaymentConfirmations ?? []).filter((confirmation) => (
    currentSessionIds.has(confirmation.tableSessionId)
  ))
  projected.paymentDomain.refunds = projected.paymentDomain.refunds.filter((refund) => (
    currentPaymentIntentIds.has(refund.paymentIntentId)
  ))
  projected.paymentDomain.cashierHandovers = (projected.paymentDomain.cashierHandovers ?? []).filter((handover) => (
    handover.businessDate === businessDate
  ))

  if (projected.inventoryDomain) {
    projected.inventoryDomain.movements = projected.inventoryDomain.movements.filter((record) => record.businessDate === businessDate)
    projected.inventoryDomain.stockCounts = projected.inventoryDomain.stockCounts.filter((record) => record.businessDate === businessDate)
    projected.inventoryDomain.bottleEvents = projected.inventoryDomain.bottleEvents.filter((record) => record.businessDate === businessDate)
    projected.inventoryDomain.auditEvents = projected.inventoryDomain.auditEvents.filter((record) => isCurrentTimestamp(record.occurredAt))
    projected.inventoryDomain.approvalRequests = projected.inventoryDomain.approvalRequests.filter((record) => (
      record.status === 'pending' || isCurrentTimestamp(record.requestedAt)
    ))
  }

  if (projected.reservationState) {
    projected.reservationState.reservations = projected.reservationState.reservations.filter((reservation) => (
      reservation.sourceCode !== 'walk_in'
      && venueBusinessDateKey(reservation.scheduledAt, projected.store.timezone, rolloverHour) >= businessDate
    ))
    const reservationIds = new Set(projected.reservationState.reservations.map((reservation) => reservation.id))
    projected.reservationState.auditEvents = projected.reservationState.auditEvents.filter((event) => reservationIds.has(event.reservationId))
  }

  projected.songState.tableSessions = currentSessions
  projected.songState.performanceSessions = projected.songState.performanceSessions.filter((performance) => (
    performance.businessDate >= businessDate
  ))
  projected.songState.requests = projected.songState.requests.filter((request) => currentSessionIds.has(request.tableSessionId))
  const currentSongRequestIds = new Set(projected.songState.requests.map((request) => request.id))
  projected.songState.auditEvents = projected.songState.auditEvents.filter((event) => currentSongRequestIds.has(event.requestId))

  projected.benefitGrantRequests = projected.benefitGrantRequests.filter((request) => (
    request.status === 'pending' || isCurrentTimestamp(request.requestedAt)
  ))
  projected.benefitRedemptions = projected.benefitRedemptions.filter((redemption) => (
    currentSessionIds.has(redemption.tableSessionId)
  ))
  projected.benefitCampaigns = projected.benefitCampaigns.filter((campaign) => isCurrentTimestamp(campaign.launchedAt))
  projected.customerNotifications = projected.customerNotifications.filter((notification) => (
    notification.status === 'queued' || isCurrentTimestamp(notification.queuedAt)
  ))

  if (projected.commercialOps) {
    projected.commercialOps.printJobs = projected.commercialOps.printJobs.filter((job) => currentOrderIds.has(job.orderId))
    projected.commercialOps.procurementBatches = projected.commercialOps.procurementBatches.filter((batch) => isCurrentTimestamp(batch.receivedAt))
    projected.commercialOps.voucherRedemptions = projected.commercialOps.voucherRedemptions.filter((record) => (
      (record.tableSessionId ? currentSessionIds.has(record.tableSessionId) : false) || isCurrentTimestamp(record.redeemedAt)
    ))
    projected.commercialOps.tipRecords = projected.commercialOps.tipRecords.filter((record) => currentSessionIds.has(record.tableSessionId))
    projected.commercialOps.auditEvents = projected.commercialOps.auditEvents.filter((event) => isCurrentTimestamp(event.occurredAt))
  }

  if (projected.hardwareState) {
    projected.hardwareState.commands = projected.hardwareState.commands.filter((command) => isCurrentTimestamp(command.requestedAt))
  }
}

function legacyTableIdFromSession(tableSessionId: string) {
  if (!tableSessionId.startsWith('session:')) return null
  return tableSessionId.slice('session:'.length).split(':')[0] ?? null
}

/** Returns the maximum data this authenticated role needs for its configured workspace. */
export function projectRuntimeStateForActor(state: RuntimeState, actor: RequestActorContext): RuntimeState {
  const projected = structuredClone(state)
  const effectiveActor = effectiveActorForState(actor, state)
  const permissions = new Set<StaffPermissionId>(effectivePermissionIdsForEmployee(state, effectiveActor.actorId))
  const scope = effectiveDataScopeForEmployee(state, effectiveActor.actorId)
  const canAccessProjectedStore = scope === 'all_stores' || actor.storeId === state.store.id
  const visibleAreaIds = new Set(canAccessProjectedStore ? assignedAreaIdsForActor(state, actor.actorId) : [])
  const storeWide = scope === 'all_stores' || (scope === 'store' && actor.storeId === state.store.id)
  const employee = state.employees.find((item) => item.id === effectiveActor.actorId && item.status === 'active')
  const activeShifts = state.shiftAssignments.filter((shift) => (
    shift.employeeId === effectiveActor.actorId
    && shift.businessDate === state.store.businessDate
    && shift.status === 'active'
  ))
  const primaryShift = activeShifts.find((shift) => shift.isPrimary) ?? activeShifts[0]
  const primaryRoleId = primaryShift?.roleId ?? employee?.roleId ?? effectiveActor.roleId
  const executionRoleIds = new Set([primaryRoleId])
  const operationalOversight = storeWide
    && ['owner', 'operations_director', 'manager', 'supervisor'].includes(primaryRoleId)
  const currentSessionIds = new Set(state.songState.tableSessions
    .filter((session) => tableSessionBusinessDate(state, session) === state.store.businessDate)
    .map((session) => session.id))

  const visibleTables = state.tables.filter((table) => canActorAccessTableDataScope(state, actor, table.id))
  const visibleTableIds = new Set(visibleTables.map((table) => table.id))
  const sessionTableIds = new Map(state.songState.tableSessions.map((session) => [session.id, session.tableId]))
  const tableCodesBySession = new Map(state.songState.tableSessions.map((session) => [
    session.id,
    state.tables.find((table) => table.id === session.tableId)?.code ?? session.tableCode,
  ]))
  const sessionVisible = (tableSessionId: string) => {
    const tableId = sessionTableIds.get(tableSessionId) ?? legacyTableIdFromSession(tableSessionId)
    return tableId != null && visibleTableIds.has(tableId)
  }

  projected.tables = structuredClone(visibleTables)
  projected.areas = projected.areas.filter((area) => canAccessProjectedStore && (
    storeWide || visibleAreaIds.has(area.id) || visibleTables.some((table) => table.areaId === area.id)
  ))
  projected.tasks = projected.tasks.filter((task) => {
    if (!canAccessProjectedStore) return false
    if (operationalOversight || task.ownerId === actor.actorId || task.notifiedEmployeeIds.includes(actor.actorId)) return true
    if (task.targetEmployeeIdsSnapshot?.includes(actor.actorId)) return true
    if (!visibleTableIds.has(task.tableId)) return false
    const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
    const dispatchRoleIds = task.dispatchRoleIdsSnapshot?.length
      ? task.dispatchRoleIdsSnapshot
      : serviceType?.dispatchRoleIds ?? []
    return dispatchRoleIds.some((roleId) => executionRoleIds.has(roleId))
  })
  const visibleTaskIds = new Set(projected.tasks.map((task) => task.id))
  projected.taskEvents = projected.taskEvents.filter((event) => visibleTaskIds.has(event.taskId))
  projected.awaitingOrderIntents = projected.awaitingOrderIntents.filter((intent) => (
    canAccessProjectedStore && visibleTableIds.has(intent.tableId)
  ))
  projected.sopExecutions = (projected.sopExecutions ?? []).filter((execution) => (
    canAccessProjectedStore && (storeWide || visibleTableIds.has(execution.tableId))
  ))
  const visibleSopExecutionIds = new Set(projected.sopExecutions.map((execution) => execution.id))
  projected.sopActionRecords = (projected.sopActionRecords ?? []).filter((record) => (
    visibleSopExecutionIds.has(record.executionId)
    && (storeWide || record.recipientEmployeeIds.includes(actor.actorId) || visibleTableIds.has(record.tableId))
  ))
  const visibleTableCodes = new Set(visibleTables.map((table) => table.code))
  projected.dutyManagerIncidents = (projected.dutyManagerIncidents ?? []).filter((incident) => (
    canAccessProjectedStore
    && (storeWide || incident.tableCode === null || visibleTableCodes.has(incident.tableCode) || incident.acknowledgedBy === actor.actorId)
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
  const activeShiftStationIds = new Set(activeShifts
    .flatMap((shift) => shift.stationIds ?? []))
  const workstationTaskVisible = (task: RuntimeState['orderDomain']['kdsTasks'][number]) => {
    if (!canAccessProjectedStore) return false
    if (!activeShiftStationIds.has(task.stationId)) return false
    const workstation = task.workstation
      ?? state.orderDomain.fulfillmentWorkstations?.find((item) => item.id === task.stationId)
      ?? state.config.workstations.find((item) => item.id === task.stationId)
    if (!workstation) return false
    const productionVisible = ['queued', 'preparing'].includes(task.status)
      && permissions.has('kds.prepare')
      && [...executionRoleIds].some((roleId) => workstation.productionRoleIds.includes(roleId))
    const deliveryVisible = ['completed', 'picked_up'].includes(task.status)
      && permissions.has('kds.deliver')
      && [...executionRoleIds].some((roleId) => workstation.deliveryRoleIds.includes(roleId))
    return productionVisible || deliveryVisible
  }
  projected.orderDomain.orders = canViewOrders
    ? projected.orderDomain.orders.filter((order) => operationalOversight || sessionVisible(order.tableSessionId))
    : []
  const visibleOrderIds = new Set(projected.orderDomain.orders.map((order) => order.id))
  projected.orderDomain.kdsTasks = canUseKds || (canViewOrders && operationalOversight)
    ? projected.orderDomain.kdsTasks.filter((task) => (
      operationalOversight || workstationTaskVisible(task)
    )).map((task) => ({ ...task, tableCode: tableCodesBySession.get(task.tableSessionId) ?? task.tableCode }))
    : []
  projected.orderDomain.authorizations = canViewOrders
    ? projected.orderDomain.authorizations.filter((authorization) => visibleOrderIds.has(authorization.orderId))
    : []
  projected.orderDomain.tableLedgerEntries = canViewOrders
    ? projected.orderDomain.tableLedgerEntries.filter((entry) => operationalOversight || sessionVisible(entry.tableSessionId))
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
  const canUsePayments = canViewFinance || permissions.has('order.view') || [
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

  const canUseInventory = ['inventory.view', 'inventory.manage', 'inventory.receive', 'inventory.count', 'inventory.remake', 'inventory.bottle', 'inventory.approve']
    .some((permission) => permissions.has(permission as StaffPermissionId))
  if (!canUseInventory || !canAccessProjectedStore) projected.inventoryDomain = undefined
  else if (projected.inventoryDomain) projected.inventoryDomain.idempotencyRecords = []

  if (projected.commercialOps) {
    projected.commercialOps.idempotencyRecords = []
    const canConfigureCommercialOps = permissions.has('config.manage')
    const canUseCommercialInventory = ['inventory.view', 'inventory.manage', 'inventory.receive', 'inventory.count', 'inventory.remake', 'inventory.bottle', 'inventory.approve']
      .some((permission) => permissions.has(permission as StaffPermissionId))
    const canUseCommercialFinance = permissions.has('finance.view') || permissions.has('payment.collect')
    if (!canConfigureCommercialOps) {
      projected.commercialOps.config.printers = projected.commercialOps.config.printers.map((printer) => ({
        ...printer,
        endpointReference: '',
      }))
      projected.commercialOps.auditEvents = []
    }
    if (!canUseCommercialInventory) {
      projected.commercialOps.scanCodeBindings = []
      projected.commercialOps.procurementBatches = []
    }
    if (!canUseCommercialFinance) {
      projected.commercialOps.voucherRedemptions = []
      projected.commercialOps.tipRecords = []
    }
    if (!canAccessProjectedStore) projected.commercialOps = undefined
  }

  if (projected.hardwareState) {
    if (!permissions.has('hardware.view') || !canAccessProjectedStore) projected.hardwareState = undefined
    else {
      projected.hardwareState.idempotencyRecords = []
      if (!permissions.has('hardware.manage')) {
        projected.hardwareState.devices = projected.hardwareState.devices.map((device) => ({
          ...device,
          connectionReference: '',
        }))
      }
    }
  }

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

  projected.songState.tableSessions = projected.songState.tableSessions.filter((session) => (
    storeWide || visibleTableIds.has(session.tableId)
  ))

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

  retainCurrentOperationalData(projected, currentSessionIds, actor.actorId)

  return projected
}
