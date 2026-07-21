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
