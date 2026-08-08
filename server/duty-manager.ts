import { createHash } from 'node:crypto'
import type {
  DutyManagerBriefing,
  DutyManagerHandover,
  DutyManagerIncident,
  DutyManagerRisk,
  DutyManagerRiskSeverity,
} from '../src/shared/assistant-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import { chinaBusinessDateKey, formatChinaTime } from '../src/shared/china-time.js'
import { effectiveHardwareDeviceStatus } from './hardware-domain.js'
import { isKdsTaskActiveForBusinessDate } from './operational-closure.js'
import { tableOperationsConfig } from './table-sessions.js'

const openServiceStatuses = new Set(['pending', 'accepted', 'arrived', 'reopened', 'escalated'])
const severityOrder: Record<DutyManagerRiskSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 }

const riskRecommendations: Record<DutyManagerRisk['category'], string> = {
  system: '先检查营业日与服务状态；无法恢复时立即启用人工备用流程。',
  service: '先到桌回应客人，再按任务步骤处理并完成留痕。',
  fulfillment: '先确认制作或取送卡点，再安排对应岗位接手。',
  staffing: '先安排可工作的主服务或候补，避免桌台无人负责。',
  sop: '核对阻塞步骤与现场证据，解除后继续执行。',
  approval: '核对失败原因和证据，由有权岗位完成复核。',
  reservation: '先核对联系方式与到店信息，再确认预约或记录后续安排。',
  hardware: '检查设备连接与心跳；未恢复时切换备用设备或人工流程。',
}

function configuredBusinessDate(state: RuntimeState, value: Date | number | string) {
  return chinaBusinessDateKey(value, tableOperationsConfig(state).businessDayRolloverHour ?? 6)
}

function riskId(category: DutyManagerRisk['category'], objectId: string, reason: string) {
  return `duty_risk_${createHash('sha256').update(`${category}:${objectId}:${reason}`).digest('hex').slice(0, 20)}`
}

function minutesOverdue(now: number, dueAt: string) {
  return Math.max(1, Math.ceil((now - Date.parse(dueAt)) / 60_000))
}

function employeeName(state: RuntimeState, employeeId: string | null | undefined) {
  if (!employeeId) return null
  return state.employees.find((employee) => employee.id === employeeId)?.displayName ?? employeeId
}

function tableCode(state: RuntimeState, tableId: string) {
  return state.tables.find((table) => table.id === tableId)?.code ?? tableId
}

type RiskInput = Omit<
  DutyManagerRisk,
  'id' | 'targetObjectId' | 'targetQuery' | 'recommendation' | 'detectedAt' | 'occurrences' | 'sourceRiskIds' | 'incidentIds' | 'incidentStatus' | 'handledByName'
> & { objectId: string; reason: string; targetQuery?: string | null; recommendation?: string }

function addRisk(risks: DutyManagerRisk[], now: number, risk: RiskInput) {
  const id = riskId(risk.category, risk.objectId, risk.reason)
  risks.push({
    id,
    severity: risk.severity,
    category: risk.category,
    title: risk.title,
    detail: risk.detail,
    tableCode: risk.tableCode,
    ownerName: risk.ownerName,
    targetObjectId: risk.objectId,
    targetQuery: risk.targetQuery ?? risk.tableCode,
    recommendation: risk.recommendation ?? riskRecommendations[risk.category],
    recommendedCommand: risk.recommendedCommand,
    detectedAt: new Date(now).toISOString(),
    occurrences: 1,
    sourceRiskIds: [id],
    incidentIds: [],
    incidentStatus: 'open',
    handledByName: null,
  })
}

function aggregateRisks(risks: DutyManagerRisk[]) {
  const groups = new Map<string, DutyManagerRisk>()
  for (const risk of risks) {
    const key = [risk.severity, risk.category, risk.title, risk.tableCode, risk.ownerName, risk.recommendedCommand].join('|')
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...risk })
      continue
    }
    existing.occurrences += 1
    existing.sourceRiskIds = [...new Set([...existing.sourceRiskIds, ...risk.sourceRiskIds])]
    existing.incidentIds = [...new Set([...existing.incidentIds, ...risk.incidentIds])]
    if (risk.incidentStatus === 'open') existing.incidentStatus = 'open'
    else if (risk.incidentStatus === 'acknowledged' && existing.incidentStatus === 'deferred') existing.incidentStatus = 'acknowledged'
    if (existing.handledByName !== risk.handledByName) existing.handledByName = existing.handledByName && risk.handledByName ? '多人协同' : existing.handledByName ?? risk.handledByName
    existing.detail = `共${existing.occurrences}项；${risk.detail}`
  }
  return [...groups.values()]
}

export function collectDutyManagerRisks(state: RuntimeState, now = Date.now()): DutyManagerRisk[] {
  const risks: DutyManagerRisk[] = []
  const rolloverHour = tableOperationsConfig(state).businessDayRolloverHour ?? 6
  const currentBusinessDate = configuredBusinessDate(state, now)
  if (state.store.businessDate < currentBusinessDate) {
    addRisk(risks, now, {
      objectId: state.store.id,
      reason: `stale_business_date:${state.store.businessDate}`,
      severity: 'critical',
      category: 'system',
      title: `营业日仍停留在${state.store.businessDate}`,
      detail: `北京时间${String(rolloverHour).padStart(2, '0')}:00应自动进入${currentBusinessDate}，请检查自动切日运行状态。`,
      tableCode: null,
      ownerName: null,
      recommendedCommand: '打开运行状态',
    })
  }
  for (const job of state.commercialOps?.printJobs ?? []) {
    if (job.status !== 'failed' || configuredBusinessDate(state, job.queuedAt) !== currentBusinessDate) continue
    const order = state.orderDomain.orders.find((item) => item.id === job.orderId)
    const session = order ? state.songState.tableSessions.find((item) => item.id === order.tableSessionId) : undefined
    addRisk(risks, now, {
      objectId: job.id,
      reason: `print_failed:${job.printerId}`,
      severity: 'high',
      category: 'hardware',
      title: '出品单打印失败，已启用电子单兜底',
      detail: `${session?.tableCode ?? '桌台待核对'}打印任务失败：${job.lastError ?? '打印机未返回成功状态'}。电子KDS仍有效，请检查设备并避免重复出品。`,
      tableCode: session?.tableCode ?? null,
      ownerName: null,
      recommendedCommand: '打开经营工具',
    })
  }
  const openTasks = state.tasks.filter((task) => (
    !task.archivedAt
    && openServiceStatuses.has(task.status)
    && configuredBusinessDate(state, task.createdAt) === currentBusinessDate
  ))
  for (const task of openTasks) {
    const code = tableCode(state, task.tableId)
    const typeName = state.config.serviceTypes.find((type) => type.id === task.serviceTypeId)?.name ?? '服务需求'
    const managerDue = now >= Date.parse(task.managerAt) || task.escalationLevel >= 2
    const backupDue = now >= Date.parse(task.escalateAt) || task.escalationLevel >= 1
    const warningDue = now >= Date.parse(task.warningAt)
    if (!managerDue && !backupDue && !warningDue && task.ownerId) continue
    const severity: DutyManagerRiskSeverity = managerDue ? 'critical' : backupDue ? 'high' : 'medium'
    addRisk(risks, now, {
      objectId: task.id,
      reason: managerDue ? 'manager_due' : backupDue ? 'backup_due' : task.ownerId ? 'warning_due' : 'unowned',
      severity,
      category: 'service',
      title: `${code} ${typeName}${managerDue ? '需要经理接管' : task.ownerId ? '即将超时' : '尚未接单'}`,
      detail: `${task.ownerId ? `${employeeName(state, task.ownerId)}负责` : '当前无人负责'}，状态为${task.status}。`,
      tableCode: code,
      ownerName: employeeName(state, task.ownerId),
      recommendedCommand: '打开任务',
    })
  }

  const fulfillmentGroups = new Map<string, {
    phase: 'production' | 'pickup'
    tableSessionId: string
    tableCode: string | null
    stationId: string
    tasks: Array<{ itemName: string; quantity: number; overdue: number }>
  }>()
  for (const task of state.orderDomain.kdsTasks.filter((candidate) => (
    isKdsTaskActiveForBusinessDate(
      state.orderDomain,
      candidate,
      currentBusinessDate,
      rolloverHour,
    )
  ))) {
    const productionDueAt = ['queued', 'preparing'].includes(task.status) ? task.productionSla?.dueAt : null
    const pickupDueAt = ['completed', 'picked_up'].includes(task.status) ? task.pickupSla?.dueAt : null
    const dueAt = productionDueAt ?? pickupDueAt
    if (!dueAt || Date.parse(dueAt) > now) continue
    const overdue = minutesOverdue(now, dueAt)
    const code = task.tableCode ?? state.songState.tableSessions.find((session) => session.id === task.tableSessionId)?.tableCode ?? null
    const phase = productionDueAt ? 'production' : 'pickup'
    const groupKey = `${task.tableSessionId}|${task.stationId}|${phase}`
    const group = fulfillmentGroups.get(groupKey) ?? {
      phase,
      tableSessionId: task.tableSessionId,
      tableCode: code,
      stationId: task.stationId,
      tasks: [],
    }
    group.tasks.push({ itemName: task.itemName, quantity: task.quantity, overdue })
    fulfillmentGroups.set(groupKey, group)
  }
  for (const group of fulfillmentGroups.values()) {
    const longestOverdue = Math.max(...group.tasks.map((task) => task.overdue))
    const totalQuantity = group.tasks.reduce((sum, task) => sum + task.quantity, 0)
    const itemNames = [...new Set(group.tasks.map((task) => task.itemName))]
    const phaseName = group.phase === 'production' ? '制作' : '取送'
    const title = group.tasks.length === 1
      ? `${group.tableCode ? `${group.tableCode} ` : ''}${group.tasks[0]!.itemName}${phaseName}超时${longestOverdue}分钟`
      : `${group.tableCode ? `${group.tableCode} ` : ''}${group.tasks.length}项出品${phaseName}超时`
    addRisk(risks, now, {
      objectId: `${group.tableSessionId}:${group.stationId}:${group.phase}`,
      reason: `${group.phase}_overdue`,
      severity: longestOverdue >= 5 ? 'critical' : 'high',
      category: 'fulfillment',
      title,
      detail: `共${group.tasks.length}个任务、${totalQuantity}份，最久超时${longestOverdue}分钟；${itemNames.slice(0, 3).join('、')}${itemNames.length > 3 ? '等' : ''}；工作站${group.stationId}。`,
      tableCode: group.tableCode,
      ownerName: null,
      recommendedCommand: '打开订单与出品',
    })
  }

  for (const table of state.tables.filter((candidate) => candidate.status === 'occupied')) {
    const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId)
    if (primary && primary.status === 'active' && !primary.paused) continue
    addRisk(risks, now, {
      objectId: table.id,
      reason: primary?.paused ? 'primary_paused' : 'primary_missing',
      severity: 'high',
      category: 'staffing',
      title: `${table.code}缺少可工作的主服务员`,
      detail: primary?.paused ? `${primary.displayName}当前暂停接单，需要安排候补。` : '桌台已经开台，但没有有效责任人。',
      tableCode: table.code,
      ownerName: primary?.displayName ?? null,
      recommendedCommand: '打开全店现场',
    })
  }

  const blockedExecutions = (state.sopExecutions ?? []).filter((execution) => (
    execution.status === 'blocked'
    && configuredBusinessDate(state, execution.anchorAt) === currentBusinessDate
  ))
  for (const execution of blockedExecutions) {
    const code = tableCode(state, execution.tableId)
    addRisk(risks, now, {
      objectId: execution.id,
      reason: execution.stoppedReason ?? 'blocked',
      severity: 'high',
      category: 'sop',
      title: `${code}“${execution.ruleName}”已阻塞`,
      detail: `停止原因：${execution.stoppedReason ?? '步骤未完成'}。`,
      tableCode: code,
      ownerName: null,
      recommendedCommand: '打开运营规则',
    })
  }

  const pendingApprovals = (state.sopActionRecords ?? []).filter((record) => (
    ['awaiting_evidence', 'unconfigured', 'failed', 'rejected'].includes(record.status)
    && configuredBusinessDate(state, record.requestedAt) === currentBusinessDate
  ))
  for (const record of pendingApprovals) {
    const code = tableCode(state, record.tableId)
    const failed = ['unconfigured', 'failed', 'rejected'].includes(record.status)
    addRisk(risks, now, {
      objectId: record.id,
      reason: record.status,
      severity: failed ? 'critical' : 'medium',
      category: 'approval',
      title: `${code} ${failed ? 'SOP验证异常' : '有SOP待复核'}`,
      detail: failed ? (record.failureReason ?? `验证状态为${record.status}`) : '请由有权岗位完成复核或证据确认。',
      tableCode: code,
      ownerName: null,
      recommendedCommand: '打开运营规则',
    })
  }

  for (const reservation of (state.reservationState?.reservations ?? []).filter((candidate) => (
    candidate.status === 'requested' && configuredBusinessDate(state, candidate.scheduledAt) === currentBusinessDate
  ))) {
    addRisk(risks, now, {
      objectId: reservation.id,
      reason: 'unconfirmed_today',
      severity: 'medium',
      category: 'reservation',
      title: `${reservation.customerName}的今日预约待确认`,
      detail: `${reservation.partySize}位，计划${formatChinaTime(reservation.scheduledAt)}到店。`,
      tableCode: reservation.tableCode,
      ownerName: null,
      targetQuery: reservation.customerName,
      recommendedCommand: '打开预约',
    })
  }

  if (state.hardwareState) {
    for (const device of state.hardwareState.devices.filter((candidate) => candidate.enabled)) {
      const status = effectiveHardwareDeviceStatus(device, state.hardwareState.config, now)
      if (status === 'online') continue
      addRisk(risks, now, {
        objectId: device.id,
        reason: `device_${status}`,
        severity: status === 'offline' || status === 'unconfigured' ? 'high' : 'medium',
        category: 'hardware',
        title: `${device.name}${status === 'offline' ? '已离线' : status === 'degraded' ? '状态异常' : '尚未完成连接配置'}`,
        detail: `${device.kind} · ${device.adapter}；${device.diagnostics.message || '请检查设备心跳和连接引用。'}`,
        tableCode: null,
        ownerName: null,
        recommendedCommand: '打开设备中心',
      })
    }
    for (const command of state.hardwareState.commands.filter((candidate) => (
      configuredBusinessDate(state, candidate.requestedAt) === currentBusinessDate
      && (
      (candidate.status === 'queued' && now - Date.parse(candidate.requestedAt) >= 120_000)
      || (['failed', 'unconfigured'].includes(candidate.status) && now - Date.parse(candidate.requestedAt) <= 30 * 60_000)
      )
    )).slice(-20)) {
      addRisk(risks, now, {
        objectId: command.id,
        reason: `command_${command.status}`,
        severity: command.status === 'queued' ? 'high' : 'medium',
        category: 'hardware',
        title: `${command.kind}设备命令${command.status === 'queued' ? '等待回执超时' : '已降级'}`,
        detail: command.resultMessage,
        tableCode: command.tableId ? state.tables.find((table) => table.id === command.tableId)?.code ?? null : null,
        ownerName: employeeName(state, command.requestedBy),
        recommendedCommand: '打开设备中心',
      })
    }
  }

  risks.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.title.localeCompare(right.title, 'zh-CN'))
  return risks
}

function incidentId(riskIdValue: string) {
  return `duty_incident_${createHash('sha256').update(riskIdValue).digest('hex').slice(0, 20)}`
}

function createIncident(risk: DutyManagerRisk, businessDate: string, nowIso: string): DutyManagerIncident {
  return {
    id: incidentId(risk.id),
    riskId: risk.id,
    cycle: 1,
    businessDate,
    severity: risk.severity,
    category: risk.category,
    title: risk.title,
    detail: risk.detail,
    tableCode: risk.tableCode,
    recommendedCommand: risk.recommendedCommand,
    status: 'open',
    firstDetectedAt: nowIso,
    lastDetectedAt: nowIso,
    observationCount: 1,
    acknowledgedAt: null,
    acknowledgedBy: null,
    deferredAt: null,
    deferredBy: null,
    deferredUntil: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissedReason: null,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  }
}

function reopenIncident(incident: DutyManagerIncident, risk: DutyManagerRisk, businessDate: string, nowIso: string) {
  Object.assign(incident, createIncident(risk, businessDate, nowIso), {
    id: incident.id,
    cycle: incident.cycle + 1,
  })
}

export function reconcileDutyManagerIncidents(state: RuntimeState, now = Date.now()) {
  const nowIso = new Date(now).toISOString()
  const businessDate = configuredBusinessDate(state, now)
  const risks = collectDutyManagerRisks(state, now)
  const currentRiskIds = new Set(risks.map((risk) => risk.id))
  const incidents = state.dutyManagerIncidents ??= []
  const byRiskId = new Map(incidents.map((incident) => [incident.riskId, incident]))
  let changed = false

  for (const risk of risks) {
    let incident = byRiskId.get(risk.id)
    if (!incident) {
      incident = createIncident(risk, businessDate, nowIso)
      incidents.push(incident)
      byRiskId.set(risk.id, incident)
      changed = true
      continue
    }
    if (incident.status === 'resolved') {
      reopenIncident(incident, risk, businessDate, nowIso)
      changed = true
      continue
    }
    if (incident.status === 'deferred' && incident.deferredUntil && Date.parse(incident.deferredUntil) <= now) {
      incident.status = 'open'
      incident.deferredUntil = null
      changed = true
    }
    const shouldObserve = now - Date.parse(incident.lastDetectedAt) >= 60_000
    if (shouldObserve) {
      incident.lastDetectedAt = nowIso
      incident.observationCount += 1
      changed = true
    }
    if (
      incident.businessDate !== businessDate || incident.severity !== risk.severity || incident.title !== risk.title
      || incident.detail !== risk.detail || incident.tableCode !== risk.tableCode || incident.recommendedCommand !== risk.recommendedCommand
    ) {
      incident.businessDate = businessDate
      incident.severity = risk.severity
      incident.category = risk.category
      incident.title = risk.title
      incident.detail = risk.detail
      incident.tableCode = risk.tableCode
      incident.recommendedCommand = risk.recommendedCommand
      changed = true
    }
  }

  for (const incident of incidents) {
    if (incident.status === 'resolved' || currentRiskIds.has(incident.riskId)) continue
    incident.status = 'resolved'
    incident.resolvedAt = nowIso
    incident.resolvedBy = 'system'
    incident.resolution = incident.dismissedAt ? 'dismissed_false_positive' : 'source_cleared'
    changed = true
  }

  if (incidents.length > 2_000) {
    state.dutyManagerIncidents = incidents
      .sort((left, right) => Date.parse(right.lastDetectedAt) - Date.parse(left.lastDetectedAt))
      .slice(0, 2_000)
    changed = true
  }
  return changed
}

function activeIncidentForRisk(state: RuntimeState, riskIdValue: string) {
  return (state.dutyManagerIncidents ?? []).find((incident) => incident.riskId === riskIdValue && incident.status !== 'resolved') ?? null
}

function handledByName(state: RuntimeState, incident: DutyManagerIncident | null) {
  const actorId = incident?.acknowledgedBy ?? incident?.deferredBy ?? incident?.dismissedBy
  return actorId ? employeeName(state, actorId) : null
}

function previousBusinessDate(businessDate: string) {
  return new Date(Date.parse(`${businessDate}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
}

function median(values: number[]) {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
  return Math.round(value * 10) / 10
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round(numerator / denominator * 1_000) / 10 : null
}

function servicePerformance(state: RuntimeState, businessDate: string, now: number) {
  const tasks = state.tasks.filter((task) => configuredBusinessDate(state, task.createdAt) === businessDate)
  const completed = tasks.filter((task) => Boolean(task.completedAt) || ['completed', 'confirmed'].includes(task.status))
  const firstResponseSeconds = tasks.flatMap((task) => task.acceptedAt
    ? [Math.max(0, (Date.parse(task.acceptedAt) - Date.parse(task.createdAt)) / 1_000)]
    : [])
  const completionMinutes = completed.flatMap((task) => task.completedAt
    ? [Math.max(0, (Date.parse(task.completedAt) - Date.parse(task.createdAt)) / 60_000)]
    : [])
  const responseSample = tasks.filter((task) => Boolean(task.acceptedAt) || Date.parse(task.warningAt) <= now)
  const respondedWithinSla = responseSample.filter((task) => {
    if (!task.acceptedAt) return false
    const responseSeconds = (Date.parse(task.acceptedAt) - Date.parse(task.createdAt)) / 1_000
    const warningSeconds = task.slaSnapshot?.warningSeconds
      ?? Math.max(0, (Date.parse(task.warningAt) - Date.parse(task.createdAt)) / 1_000)
    return responseSeconds <= warningSeconds
  }).length
  const automaticallyAssigned = tasks.filter((task) => state.taskEvents.some((event) => (
    event.taskId === task.id
    && event.type === 'task.created.v1'
    && typeof event.payload.ownerId === 'string'
  ))).length
  return {
    sampleSize: tasks.length,
    responseSampleSize: responseSample.length,
    completedTasks: completed.length,
    completionRate: rate(completed.length, tasks.length),
    responseWithinSlaRate: rate(respondedWithinSla, responseSample.length),
    medianFirstResponseSeconds: median(firstResponseSeconds),
    medianCompletionMinutes: median(completionMinutes),
    escalationRate: rate(tasks.filter((task) => task.escalationLevel > 0).length, tasks.length),
    automaticAssignmentRate: rate(automaticallyAssigned, tasks.length),
  }
}

function orderBusinessDate(state: RuntimeState, value: { submittedAt: string | null; createdAt: string }) {
  return configuredBusinessDate(state, value.submittedAt ?? value.createdAt)
}

function businessPerformance(state: RuntimeState, businessDate: string) {
  const orders = state.orderDomain.orders.filter((order) => (
    order.status !== 'draft' && orderBusinessDate(state, order) === businessDate
  ))
  const paymentIntents = state.paymentDomain.paymentIntents.filter((intent) => (
    (intent.businessDate ?? configuredBusinessDate(state, intent.paidAt ?? intent.createdAt)) === businessDate
  ))
  const confirmed = paymentIntents.filter((intent) => intent.status === 'succeeded')
  const pendingReconciliation = paymentIntents.filter((intent) => intent.status === 'reported_pending_reconciliation')
  const refunds = state.paymentDomain.refunds.filter((refund) => (
    refund.status === 'succeeded'
    && refund.succeededAt
    && configuredBusinessDate(state, refund.succeededAt) === businessDate
  ))
  const grossSalesAmount = orders.reduce((total, order) => total + order.amounts.payableAmount, 0)
  const confirmedRevenueAmount = confirmed.reduce((total, intent) => total + intent.amount, 0)
  const pendingReconciliationAmount = pendingReconciliation.reduce((total, intent) => total + intent.amount, 0)
  const refundedAmount = refunds.reduce((total, refund) => total + refund.amount, 0)
  const netRevenueAmount = Math.max(0, confirmedRevenueAmount + pendingReconciliationAmount - refundedAmount)
  const costAmount = orders.reduce((total, order) => total + order.items.reduce((sum, item) => (
    sum + item.unitCostAmount * item.quantity
  ), 0), 0)
  return {
    submittedOrders: orders.length,
    fulfilledOrders: orders.filter((order) => order.status === 'fulfilled').length,
    grossSalesAmount,
    confirmedRevenueAmount,
    pendingReconciliationAmount,
    refundedAmount,
    netRevenueAmount,
    estimatedGrossProfitAmount: netRevenueAmount - costAmount,
    averageCheckAmount: orders.length > 0 ? Math.round(grossSalesAmount / orders.length) : null,
    paymentConversionRate: rate(paymentIntents.filter((intent) => (
      ['succeeded', 'reported_pending_reconciliation'].includes(intent.status)
    )).length, paymentIntents.length),
  }
}

function experiencePerformance(state: RuntimeState, businessDate: string) {
  const tasks = state.tasks.filter((task) => configuredBusinessDate(state, task.createdAt) === businessDate)
  const guestRequests = tasks.filter((task) => task.source === 'guest')
  const complaintServiceTypeIds = new Set(state.config.serviceTypes.filter((serviceType) => (
    serviceType.code === 'COMPLAINT'
  )).map((serviceType) => serviceType.id))
  const birthdayServiceTypeIds = new Set(state.config.serviceTypes.filter((serviceType) => (
    serviceType.code === 'BIRTHDAY_CARE'
  )).map((serviceType) => serviceType.id))
  const complaints = guestRequests.filter((task) => complaintServiceTypeIds.has(task.serviceTypeId))
  const resolvedComplaints = complaints.filter((task) => Boolean(task.completedAt))
  const complaintResolutionMinutes = resolvedComplaints.flatMap((task) => task.completedAt
    ? [Math.max(0, (Date.parse(task.completedAt) - Date.parse(task.createdAt)) / 60_000)]
    : [])
  const reopenedTaskIds = new Set(state.taskEvents.filter((event) => (
    event.type === 'task.reopened.v1' && configuredBusinessDate(state, event.occurredAt) === businessDate
  )).map((event) => event.taskId))
  return {
    guestRequests: guestRequests.length,
    complaints: complaints.length,
    complaintRate: rate(complaints.length, guestRequests.length),
    averageComplaintResolutionMinutes: complaintResolutionMinutes.length > 0
      ? Math.round(complaintResolutionMinutes.reduce((sum, value) => sum + value, 0) / complaintResolutionMinutes.length * 10) / 10
      : null,
    reopenedRequests: reopenedTaskIds.size,
    unresolvedArchivedRequests: guestRequests.filter((task) => task.archiveOutcome === 'unresolved').length,
    birthdayCareCompleted: guestRequests.filter((task) => (
      birthdayServiceTypeIds.has(task.serviceTypeId) && Boolean(task.completedAt)
    )).length,
    serviceRecoveryRate: rate(resolvedComplaints.length, complaints.length),
  }
}

function employeeCapacity(state: RuntimeState, employeeId: string) {
  const employee = state.employees.find((candidate) => candidate.id === employeeId)
  if (!employee) return 0
  const roleIds = new Set([employee.roleId, ...(employee.roleIds ?? [])])
  return Math.max(0, ...state.config.roles.filter((role) => (
    roleIds.has(role.id) && role.canReceiveTasks
  )).map((role) => role.maxConcurrentTasks))
}

function workforcePerformance(state: RuntimeState, businessDate: string, now: number) {
  const activeEmployees = state.employees.filter((employee) => employee.status === 'active')
  const activeLeaseIds = new Set((state.presenceLeases ?? []).filter((lease) => (
    lease.businessDate === businessDate && lease.expiresAt > now && lease.sessionExpiresAt > now
  )).map((lease) => lease.actorId))
  const onlineEmployees = activeEmployees.filter((employee) => activeLeaseIds.has(employee.id) || employee.online)
  const openTasks = state.tasks.filter((task) => (
    !task.archivedAt && openServiceStatuses.has(task.status) && configuredBusinessDate(state, task.createdAt) === businessDate
  ))
  const assignedOpenTasks = openTasks.filter((task) => Boolean(task.ownerId))
  const onlineCapacity = onlineEmployees.reduce((total, employee) => total + employeeCapacity(state, employee.id), 0)
  const loadByEmployee = new Map<string, number>()
  for (const task of assignedOpenTasks) loadByEmployee.set(task.ownerId!, (loadByEmployee.get(task.ownerId!) ?? 0) + 1)
  const overloadedEmployees = onlineEmployees.filter((employee) => {
    const capacity = employeeCapacity(state, employee.id)
    return capacity > 0 && (loadByEmployee.get(employee.id) ?? 0) >= capacity
  }).length
  return {
    activeEmployees: activeEmployees.length,
    onlineEmployees: onlineEmployees.length,
    assignedOpenTasks: assignedOpenTasks.length,
    unownedTasks: openTasks.length - assignedOpenTasks.length,
    overloadedEmployees,
    utilizationRate: rate(assignedOpenTasks.length, onlineCapacity),
    tasksPerOnlineEmployee: onlineEmployees.length > 0
      ? Math.round(openTasks.length / onlineEmployees.length * 10) / 10
      : null,
  }
}

function inventoryMovementCost(state: RuntimeState, movement: NonNullable<RuntimeState['inventoryDomain']>['movements'][number]) {
  const snapshot = movement.configurationSnapshot
  if (snapshot?.kind === 'recipe') return movement.quantity * snapshot.ingredient.costAmountPerBaseUnit
  if (snapshot?.kind === 'unit_conversion') return movement.quantity * snapshot.ingredient.costAmountPerBaseUnit
  const ingredient = state.inventoryDomain?.ingredientSkus.find((item) => item.id === movement.productId)
  if (ingredient) return movement.quantity * ingredient.costAmountPerBaseUnit
  const product = state.products.find((item) => item.id === movement.productId)
  return movement.quantity * (product?.costAmount ?? 0)
}

function lossPreventionPerformance(
  state: RuntimeState,
  businessDate: string,
  business: ReturnType<typeof businessPerformance>,
) {
  const movements = (state.inventoryDomain?.movements ?? []).filter((movement) => movement.businessDate === businessDate)
  const stockLoss = movements.filter((movement) => movement.type === 'stock_count_loss')
  const stockGain = movements.filter((movement) => movement.type === 'stock_count_gain')
  const orders = state.orderDomain.orders.filter((order) => (
    order.status !== 'draft' && orderBusinessDate(state, order) === businessDate
  ))
  const refunds = state.paymentDomain.refunds.filter((refund) => (
    configuredBusinessDate(state, refund.requestedAt) === businessDate
  ))
  const pendingRefunds = refunds.filter((refund) => ['requested', 'approved', 'processing', 'failed'].includes(refund.status))
  return {
    stockLossQuantity: Math.round(stockLoss.reduce((total, movement) => total + movement.quantity, 0) * 10_000) / 10_000,
    stockLossCostAmount: Math.round(stockLoss.reduce((total, movement) => total + inventoryMovementCost(state, movement), 0)),
    stockGainQuantity: Math.round(stockGain.reduce((total, movement) => total + movement.quantity, 0) * 10_000) / 10_000,
    complimentaryAmount: orders.reduce((total, order) => total + order.amounts.giftAmount, 0),
    discountAmount: orders.reduce((total, order) => total + order.amounts.discountAmount, 0),
    refundAmount: business.refundedAmount,
    pendingRefundAmount: pendingRefunds.reduce((total, refund) => total + refund.amount, 0),
    pendingReconciliationAmount: business.pendingReconciliationAmount,
    exceptionCount: stockLoss.length + pendingRefunds.length
      + state.orderDomain.kdsTasks.filter((task) => (
        task.exceptionEvents?.some((event) => configuredBusinessDate(state, event.occurredAt) === businessDate)
      )).length,
  }
}

export function calculateDutyManagerEffectiveness(
  state: RuntimeState,
  now = Date.now(),
): DutyManagerBriefing['effectiveness'] {
  const businessDate = configuredBusinessDate(state, now)
  const previousDate = previousBusinessDate(businessDate)
  const service = servicePerformance(state, businessDate, now)
  const previous = servicePerformance(state, previousDate, now)
  const business = businessPerformance(state, businessDate)
  const experience = experiencePerformance(state, businessDate)
  const workforce = workforcePerformance(state, businessDate, now)
  const lossPrevention = lossPreventionPerformance(state, businessDate, business)
  const sopExecutions = (state.sopExecutions ?? []).filter((execution) => (
    configuredBusinessDate(state, execution.anchorAt) === businessDate
  ))
  const completedSop = sopExecutions.filter((execution) => execution.status === 'completed').length
  const blockedSop = sopExecutions.filter((execution) => execution.status === 'blocked').length
  const responseDelta = service.responseWithinSlaRate !== null && previous.responseWithinSlaRate !== null
    ? Math.round((service.responseWithinSlaRate - previous.responseWithinSlaRate) * 10) / 10
    : null
  const medianResponseDelta = service.medianFirstResponseSeconds !== null && previous.medianFirstResponseSeconds !== null
    ? Math.round((service.medianFirstResponseSeconds - previous.medianFirstResponseSeconds) * 10) / 10
    : null
  let trend: DutyManagerBriefing['effectiveness']['trend'] = 'insufficient_data'
  if (service.responseSampleSize >= 3 && previous.responseSampleSize >= 3) {
    if ((responseDelta ?? 0) >= 5 || (medianResponseDelta ?? 0) <= -15) trend = 'improving'
    else if ((responseDelta ?? 0) <= -5 || (medianResponseDelta ?? 0) >= 15) trend = 'declining'
    else trend = 'steady'
  }
  const summary = workforce.unownedTasks > 0
    ? `${workforce.unownedTasks}项现场任务无人接手，先补齐主服务或候补再继续派单。`
    : lossPrevention.pendingReconciliationAmount > 0
      ? `有¥${(lossPrevention.pendingReconciliationAmount / 100).toFixed(2)}物理POS收款待对账，交班前必须留痕。`
    : experience.unresolvedArchivedRequests > 0
      ? `${experience.unresolvedArchivedRequests}项客户需求在翻台时仍未解决，建议复盘责任与补救。`
    : service.responseSampleSize < 3
    ? `今日已有${service.responseSampleSize}次服务形成首响结果，累计到3次后开始判断服务趋势。`
    : (service.responseWithinSlaRate ?? 0) < 90
      ? `按时响应率${service.responseWithinSlaRate ?? 0}%，建议先补足忙桌候补并检查首响SLA。`
      : (service.escalationRate ?? 0) > 20
        ? `升级率${service.escalationRate ?? 0}%，建议检查岗位负荷和候补覆盖。`
        : blockedSop > 0
          ? `${blockedSop}条SOP执行阻塞，建议先处理阻塞步骤再调整规则。`
          : '当前响应与闭环节奏稳定，继续保持并观察跨营业日趋势。'
  return {
    service,
    sop: {
      sampleSize: sopExecutions.length,
      completedExecutions: completedSop,
      blockedExecutions: blockedSop,
      completionRate: rate(completedSop, sopExecutions.length),
    },
    business,
    experience,
    workforce,
    lossPrevention,
    comparison: {
      previousBusinessDate: previousDate,
      previousSampleSize: previous.sampleSize,
      previousResponseSampleSize: previous.responseSampleSize,
      responseWithinSlaDeltaPoints: responseDelta,
      medianFirstResponseDeltaSeconds: medianResponseDelta,
    },
    trend,
    summary,
  }
}

export function buildDutyManagerBriefing(
  state: RuntimeState,
  now = Date.now(),
  actions: DutyManagerBriefing['actions'] = { canAcknowledge: false, canManage: false },
): DutyManagerBriefing {
  const rawRisks = collectDutyManagerRisks(state, now)
  const currentBusinessDate = configuredBusinessDate(state, now)
  const rolloverHour = tableOperationsConfig(state).businessDayRolloverHour ?? 6
  const decorated: DutyManagerRisk[] = rawRisks.flatMap((risk) => {
    const incident = activeIncidentForRisk(state, risk.id)
    if (incident?.status === 'dismissed') return []
    if (incident?.status === 'deferred' && incident.deferredUntil && Date.parse(incident.deferredUntil) > now) return []
    return [{
      ...risk,
      incidentIds: incident ? [incident.id] : [],
      incidentStatus: incident?.status === 'acknowledged' ? 'acknowledged' : 'open',
      handledByName: handledByName(state, incident),
    }]
  })
  const incidents = (state.dutyManagerIncidents ?? []).filter((incident) => (
    incident.status !== 'resolved' && incident.businessDate === currentBusinessDate
  ))
  const openServiceTasks = state.tasks.filter((task) => (
    !task.archivedAt
    && openServiceStatuses.has(task.status)
    && configuredBusinessDate(state, task.createdAt) === currentBusinessDate
  ))
  const overdueFulfillmentTasks = state.orderDomain.kdsTasks.filter((task) => {
    if (!isKdsTaskActiveForBusinessDate(state.orderDomain, task, currentBusinessDate, rolloverHour)) return false
    const dueAt = ['queued', 'preparing'].includes(task.status) ? task.productionSla?.dueAt
      : ['completed', 'picked_up'].includes(task.status) ? task.pickupSla?.dueAt : null
    return Boolean(dueAt && Date.parse(dueAt) <= now)
  }).length
  const counts = {
    critical: decorated.filter((risk) => risk.severity === 'critical').length,
    high: decorated.filter((risk) => risk.severity === 'high').length,
    medium: decorated.filter((risk) => risk.severity === 'medium').length,
    openServiceTasks: openServiceTasks.length,
    overdueFulfillmentTasks,
    blockedSopExecutions: (state.sopExecutions ?? []).filter((execution) => (
      execution.status === 'blocked' && configuredBusinessDate(state, execution.anchorAt) === currentBusinessDate
    )).length,
    pendingApprovals: (state.sopActionRecords ?? []).filter((record) => (
      ['awaiting_evidence', 'unconfigured', 'failed', 'rejected'].includes(record.status)
      && configuredBusinessDate(state, record.requestedAt) === currentBusinessDate
    )).length,
    activeIncidents: incidents.filter((incident) => incident.status !== 'dismissed').length,
    unacknowledgedIncidents: incidents.filter((incident) => incident.status === 'open').length,
    acknowledgedIncidents: incidents.filter((incident) => incident.status === 'acknowledged').length,
    deferredIncidents: incidents.filter((incident) => incident.status === 'deferred').length,
  }
  const unhandledCritical = decorated.filter((risk) => risk.severity === 'critical' && risk.incidentStatus === 'open').length
  const unhandledAttention = decorated.filter((risk) => risk.severity !== 'critical' && risk.incidentStatus === 'open').length
  const health = unhandledCritical > 0 ? 'critical' : unhandledAttention > 0 || counts.acknowledgedIncidents > 0 ? 'attention' : 'stable'
  const headline = unhandledCritical > 0
    ? `${unhandledCritical}项需要立即接管，先处理红色风险。`
    : unhandledAttention > 0
      ? `${unhandledAttention}项尚未接管，请按优先级处理。`
      : counts.acknowledgedIncidents > 0
        ? `${counts.acknowledgedIncidents}项已有人接管，继续跟进到关闭。`
        : '当前没有未接管的风险，现场运行平稳。'
  return {
    generatedAt: new Date(now).toISOString(),
    businessDate: currentBusinessDate,
    health,
    headline,
    counts,
    actions,
    effectiveness: calculateDutyManagerEffectiveness(state, now),
    risks: aggregateRisks(decorated).slice(0, 30),
  }
}

export function buildDutyManagerHandover(state: RuntimeState, now = Date.now()): DutyManagerHandover {
  const businessDate = configuredBusinessDate(state, now)
  const incidents = (state.dutyManagerIncidents ?? []).filter((incident) => incident.businessDate === businessDate)
  const activeIncidents = incidents.filter((incident) => !['resolved', 'dismissed'].includes(incident.status))
  const acknowledgeMinutes = incidents.flatMap((incident) => incident.acknowledgedAt
    ? [(Date.parse(incident.acknowledgedAt) - Date.parse(incident.firstDetectedAt)) / 60_000]
    : [])
  const averageAcknowledgeMinutes = acknowledgeMinutes.length > 0
    ? Math.round(acknowledgeMinutes.reduce((sum, value) => sum + value, 0) / acknowledgeMinutes.length * 10) / 10
    : null
  const oldestActiveMinutes = activeIncidents.length > 0
    ? Math.max(...activeIncidents.map((incident) => Math.max(0, Math.floor((now - Date.parse(incident.firstDetectedAt)) / 60_000))))
    : null
  const resolved = incidents.filter((incident) => incident.status === 'resolved').length
  const dismissed = incidents.filter((incident) => incident.status === 'dismissed').length
  const closed = resolved + dismissed
  const summary = activeIncidents.length > 0
    ? `${activeIncidents.length}项仍需交班跟进，今日已闭环${closed}项。`
    : `当前没有待交班风险，今日已闭环${closed}项。`
  return {
    generatedAt: new Date(now).toISOString(), businessDate, summary,
    detected: incidents.length,
    active: activeIncidents.length,
    acknowledged: incidents.filter((incident) => incident.status === 'acknowledged').length,
    deferred: incidents.filter((incident) => incident.status === 'deferred').length,
    dismissed,
    resolved,
    averageAcknowledgeMinutes,
    oldestActiveMinutes,
  }
}
