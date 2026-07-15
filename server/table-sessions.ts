import { randomUUID } from 'node:crypto'
import type {
  MinimumSpendRule,
  MinimumSpendSnapshot,
  RuntimeState,
  SalesAttributionRecord,
  SalesAttributionSubjectType,
  TableCombinationRecord,
  TableOperationsConfig,
  TableSessionOpenSource,
  TableSessionOperation,
  TableSessionSummary,
  Table,
} from '../src/shared/contracts.js'
import type { SongTableSession } from '../src/shared/song-contracts.js'

export const DEFAULT_TABLE_OPERATIONS_CONFIG: TableOperationsConfig = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  reminder: {
    enabled: true,
    firstReminderMinutes: 60,
    repeatMinutes: 30,
    thresholdPercent: 80,
  },
  minimumSpendRules: [],
}

interface OpenTableSessionOptions {
  source?: TableSessionOpenSource
  sourceId?: string | null
}

function minuteOfDay(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return hour! * 60 + minute!
}

function localMinuteOfDay(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function businessWeekday(businessDate: string) {
  return new Date(`${businessDate}T12:00:00Z`).getUTCDay()
}

function ruleMatches(rule: MinimumSpendRule, table: Table, weekday: number, minute: number) {
  if (!rule.enabled || !rule.weekdays.includes(weekday)) return false
  if (rule.targetType === 'table' ? rule.targetId !== table.id : rule.targetId !== table.areaId) return false
  const start = minuteOfDay(rule.startTime)
  const end = minuteOfDay(rule.endTime)
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function currentConfig(state: RuntimeState) {
  return state.tableOperationsConfig ?? DEFAULT_TABLE_OPERATIONS_CONFIG
}

function minimumSpendSnapshot(state: RuntimeState, table: Table, capturedAt: string): MinimumSpendSnapshot {
  const config = currentConfig(state)
  const weekday = businessWeekday(state.store.businessDate)
  const minute = localMinuteOfDay(capturedAt, state.store.timezone)
  const rule = config.minimumSpendRules
    .filter((candidate) => ruleMatches(candidate, table, weekday, minute))
    .toSorted((left, right) => Number(right.targetType === 'table') - Number(left.targetType === 'table'))[0]
  return {
    configVersion: config.version,
    ruleId: rule?.id ?? null,
    ruleName: rule?.name ?? '未设置低消',
    targetType: rule?.targetType ?? null,
    targetId: rule?.targetId ?? null,
    weekday,
    startTime: rule?.startTime ?? null,
    endTime: rule?.endTime ?? null,
    amount: rule?.amount ?? 0,
    currency: rule?.currency ?? 'CNY',
    reminder: structuredClone(config.reminder),
    capturedAt,
  }
}

function ensureOperationCollections(state: RuntimeState) {
  state.tableSessionOperations ??= []
  state.salesAttributionRecords ??= []
  state.tableCombinationRecords ??= []
}

export function tableOperationsConfig(state: RuntimeState) {
  return structuredClone(currentConfig(state))
}

export function openTableSessions(state: RuntimeState, tableId: string) {
  return state.songState.tableSessions.filter((session) => session.tableId === tableId && session.status === 'open')
}

export function currentOpenTableSession(state: RuntimeState, tableId: string) {
  const sessions = openTableSessions(state, tableId)
  if (sessions.length !== 1) {
    throw new Error(sessions.length === 0 ? '桌台没有开放桌次' : '桌台存在重复开放桌次')
  }
  return sessions[0]!
}

export function tableSessionOperation(
  state: RuntimeState,
  session: SongTableSession,
  source: TableSessionOpenSource = 'legacy',
  sourceId: string | null = null,
) {
  ensureOperationCollections(state)
  const existing = state.tableSessionOperations!.find((operation) => operation.tableSessionId === session.id)
  if (existing) return existing
  const table = state.tables.find((candidate) => candidate.id === session.tableId)
  if (!table) throw new Error('桌次对应桌台不存在')
  const operation: TableSessionOperation = {
    tableSessionId: session.id,
    openedTableId: table.id,
    openedTableCode: table.code,
    source,
    sourceId,
    minimumSpendSnapshot: minimumSpendSnapshot(state, table, session.openedAt),
    createdAt: session.openedAt,
  }
  state.tableSessionOperations!.push(operation)
  return operation
}

export function openTableSession(
  state: RuntimeState,
  table: Table,
  openedAt: string,
  options: OpenTableSessionOptions = {},
): SongTableSession {
  if (openTableSessions(state, table.id).length > 0) throw new Error('桌台已经存在开放桌次')
  const session: SongTableSession = {
    id: `session:${table.id}:${state.store.businessDate}:${randomUUID()}`,
    tableId: table.id,
    tableCode: table.code,
    status: 'open',
    openedAt,
    closedAt: null,
  }
  state.songState.tableSessions.push(session)
  tableSessionOperation(state, session, options.source ?? 'legacy', options.sourceId ?? null)
  return session
}

export function currentSalesEmployeeId(
  state: RuntimeState,
  subjectType: SalesAttributionSubjectType,
  subjectId: string,
) {
  return (state.salesAttributionRecords ?? [])
    .findLast((record) => record.subjectType === subjectType && record.subjectId === subjectId)
    ?.salesEmployeeId ?? null
}

export function recordSalesAttribution(
  state: RuntimeState,
  input: {
    subjectType: SalesAttributionSubjectType
    subjectId: string
    salesEmployeeId: string
    actorId: string
    reason: string
    occurredAt: string
    idempotencyKey: string
  },
) {
  ensureOperationCollections(state)
  const replay = state.salesAttributionRecords!.find((record) => record.idempotencyKey === input.idempotencyKey)
  if (replay) {
    if (
      replay.subjectType !== input.subjectType || replay.subjectId !== input.subjectId ||
      replay.salesEmployeeId !== input.salesEmployeeId || replay.reason !== input.reason
    ) throw new Error('幂等键已用于不同销售归属请求')
    return replay
  }
  const employee = state.employees.find((candidate) => candidate.id === input.salesEmployeeId && candidate.status === 'active')
  if (!employee) throw new Error('销售归属员工不存在或已停用')
  const previousSalesEmployeeId = currentSalesEmployeeId(state, input.subjectType, input.subjectId)
  const record: SalesAttributionRecord = {
    id: `sales-attribution:${randomUUID()}`,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    salesEmployeeId: input.salesEmployeeId,
    previousSalesEmployeeId,
    actorId: input.actorId,
    reason: input.reason,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
  }
  state.salesAttributionRecords!.push(record)
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: input.actorId,
    action: previousSalesEmployeeId ? 'sales_attribution.changed.v1' : 'sales_attribution.assigned.v1',
    objectType: input.subjectType,
    objectId: input.subjectId,
    occurredAt: input.occurredAt,
    details: { ...structuredClone(record) },
  })
  return record
}

export function activeTableCombinationLinks(state: RuntimeState) {
  const latest = new Map<string, TableCombinationRecord>()
  for (const record of state.tableCombinationRecords ?? []) latest.set(record.linkId, record)
  return [...latest.values()].filter((record) => record.action !== 'split_back')
}

export function tableSessionSummary(
  state: RuntimeState,
  session: SongTableSession,
  now = new Date(),
): TableSessionSummary {
  const operation = tableSessionOperation(state, session)
  const snapshot = operation.minimumSpendSnapshot
  const spendAmount = state.orderDomain.tableLedgerEntries
    .filter((entry) => entry.tableSessionId === session.id)
    .reduce((sum, entry) => sum + entry.amount, 0)
  const differenceAmount = Math.max(0, snapshot.amount - spendAmount)
  const progressPercent = snapshot.amount === 0 ? 100 : Math.max(0, Math.min(100, Math.floor(spendAmount / snapshot.amount * 100)))
  const firstAt = Date.parse(session.openedAt) + snapshot.reminder.firstReminderMinutes * 60_000
  const reminderRequired = snapshot.reminder.enabled && differenceAmount > 0
    && progressPercent < snapshot.reminder.thresholdPercent && now.getTime() >= firstAt
  let nextReminderAt: string | null = null
  if (snapshot.reminder.enabled && differenceAmount > 0 && progressPercent < snapshot.reminder.thresholdPercent) {
    if (now.getTime() < firstAt) nextReminderAt = new Date(firstAt).toISOString()
    else {
      const elapsed = now.getTime() - firstAt
      const next = firstAt + (Math.floor(elapsed / (snapshot.reminder.repeatMinutes * 60_000)) + 1)
        * snapshot.reminder.repeatMinutes * 60_000
      nextReminderAt = new Date(next).toISOString()
    }
  }
  return {
    tableId: session.tableId,
    tableCode: session.tableCode,
    tableSessionId: session.id,
    minimumSpendAmount: snapshot.amount,
    spendAmount,
    differenceAmount,
    progressPercent,
    currency: snapshot.currency,
    configVersion: snapshot.configVersion,
    ruleName: snapshot.ruleName,
    reminderRequired,
    nextReminderAt,
    salesEmployeeId: currentSalesEmployeeId(state, 'table_session', session.id),
  }
}
