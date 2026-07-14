import type { AuditEntry, RuntimeState, StoreConfig } from '../src/shared/contracts.js'
import {
  publishConfigVersionSchema,
  rollbackConfigVersionSchema,
  type ConfigVersionOperation,
  type ConfigVersionRecord,
  type ConfigVersioningResult,
  type PublishConfigVersionCommand,
  type RollbackConfigVersionCommand,
} from '../src/shared/config-versioning-contracts.js'

function cloneState(state: RuntimeState) {
  return structuredClone(state)
}

function cloneVersions(versions: readonly ConfigVersionRecord[]) {
  return structuredClone(versions) as ConfigVersionRecord[]
}

function recordId(storeId: string, version: number) {
  return `config_version_${storeId}_${version}`
}

function auditId(record: ConfigVersionRecord) {
  return `audit_${record.id}`
}

function assertPublishedConfig(config: StoreConfig) {
  if (config.status !== 'published' || !config.publishedAt) {
    throw new Error('只有已发布配置可以登记版本历史')
  }
}

function snapshotsEqual(left: StoreConfig, right: StoreConfig) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertHistoryIntegrity(storeId: string, versions: readonly ConfigVersionRecord[]) {
  const seen = new Set<number>()
  for (const record of versions) {
    if (record.storeId !== storeId) continue
    if (seen.has(record.version)) throw new Error(`配置版本历史存在重复版本 ${record.version}`)
    seen.add(record.version)
    if (record.snapshot.version !== record.version || record.snapshot.status !== 'published') {
      throw new Error(`配置版本 ${record.version} 的快照无效`)
    }
  }
}

function findIdempotentRecord(
  storeId: string,
  versions: readonly ConfigVersionRecord[],
  command: PublishConfigVersionCommand,
  operation: Exclude<ConfigVersionOperation, 'baseline'>,
  targetVersion: number | null,
) {
  const record = versions.find(
    (item) => item.storeId === storeId && item.idempotencyKey === command.idempotencyKey,
  )
  if (!record) return null
  if (
    record.operation !== operation ||
    record.rollbackTargetVersion !== targetVersion ||
    record.actorId !== command.actorId ||
    record.reason !== command.reason ||
    record.createdAt !== command.occurredAt
  ) {
    throw new Error('幂等键已用于其他配置操作')
  }
  return record
}

function findAuditEntry(state: RuntimeState, record: ConfigVersionRecord) {
  const entry = state.auditEntries.find((item) => item.id === auditId(record))
  if (!entry) throw new Error('幂等操作缺少对应审计记录')
  return structuredClone(entry)
}

function idempotentResult(
  state: RuntimeState,
  versions: readonly ConfigVersionRecord[],
  record: ConfigVersionRecord,
): ConfigVersioningResult {
  if (state.config.version < record.version) throw new Error('幂等操作状态与版本历史不一致')
  return {
    state: cloneState(state),
    versions: cloneVersions(versions),
    record: structuredClone(record),
    auditEntry: findAuditEntry(state, record),
    idempotent: true,
  }
}

function maxVersion(state: RuntimeState, versions: readonly ConfigVersionRecord[]) {
  return Math.max(
    state.config.version,
    ...versions.filter((record) => record.storeId === state.store.id).map((record) => record.version),
  )
}

function appendCurrentBaseline(
  state: RuntimeState,
  versions: ConfigVersionRecord[],
  actorId: string,
  reason: string,
  idempotencyKey: string,
  occurredAt: string,
) {
  assertPublishedConfig(state.config)
  const existing = versions.find(
    (record) => record.storeId === state.store.id && record.version === state.config.version,
  )
  if (existing) {
    if (!snapshotsEqual(existing.snapshot, state.config)) {
      throw new Error(`当前配置与历史版本 ${state.config.version} 不一致`)
    }
    return
  }
  versions.push({
    id: recordId(state.store.id, state.config.version),
    storeId: state.store.id,
    version: state.config.version,
    operation: 'baseline',
    sourceVersion: null,
    rollbackTargetVersion: null,
    snapshot: structuredClone(state.config),
    actorId,
    reason: `操作前基线：${reason}`,
    idempotencyKey: `${idempotencyKey}:baseline:${state.config.version}`,
    createdAt: occurredAt,
  })
}

function createRecord(
  state: RuntimeState,
  config: StoreConfig,
  operation: 'publish' | 'rollback',
  sourceVersion: number,
  rollbackTargetVersion: number | null,
  command: PublishConfigVersionCommand,
): ConfigVersionRecord {
  return {
    id: recordId(state.store.id, config.version),
    storeId: state.store.id,
    version: config.version,
    operation,
    sourceVersion,
    rollbackTargetVersion,
    snapshot: structuredClone(config),
    actorId: command.actorId,
    reason: command.reason,
    idempotencyKey: command.idempotencyKey,
    createdAt: command.occurredAt,
  }
}

function appendAudit(
  state: RuntimeState,
  record: ConfigVersionRecord,
  action: 'config.version_published.v1' | 'config.version_rolled_back.v1',
) {
  const entry: AuditEntry = {
    id: auditId(record),
    actorId: record.actorId,
    action,
    objectType: 'storeConfig',
    objectId: state.store.id,
    occurredAt: record.createdAt,
    details: {
      operation: record.operation,
      sourceVersion: record.sourceVersion,
      targetVersion: record.rollbackTargetVersion,
      newVersion: record.version,
      reason: record.reason,
      idempotencyKey: record.idempotencyKey,
      versionRecordId: record.id,
    },
  }
  state.auditEntries.push(entry)
  return entry
}

export function listConfigVersionHistory(
  storeId: string,
  versions: readonly ConfigVersionRecord[],
) {
  assertHistoryIntegrity(storeId, versions)
  return cloneVersions(
    versions
      .filter((record) => record.storeId === storeId)
      .toSorted((left, right) => right.version - left.version),
  )
}

export function publishConfigVersion(
  sourceState: RuntimeState,
  sourceVersions: readonly ConfigVersionRecord[],
  input: PublishConfigVersionCommand,
): ConfigVersioningResult {
  const command = publishConfigVersionSchema.parse(input)
  assertHistoryIntegrity(sourceState.store.id, sourceVersions)
  const previous = findIdempotentRecord(
    sourceState.store.id,
    sourceVersions,
    command,
    'publish',
    null,
  )
  if (previous) return idempotentResult(sourceState, sourceVersions, previous)
  if (!sourceState.draftConfig) throw new Error('没有待发布草稿')

  const draft = structuredClone(sourceState.draftConfig)
  const state = cloneState(sourceState)
  const versions = cloneVersions(sourceVersions)
  appendCurrentBaseline(
    state,
    versions,
    command.actorId,
    command.reason,
    command.idempotencyKey,
    command.occurredAt,
  )
  const sourceVersion = state.config.version
  const config = draft
  config.version = maxVersion(state, versions) + 1
  config.status = 'published'
  config.publishedAt = command.occurredAt
  state.config = config
  state.draftConfig = null

  const record = createRecord(state, config, 'publish', sourceVersion, null, command)
  versions.push(record)
  const auditEntry = appendAudit(state, record, 'config.version_published.v1')
  state.revision += 1
  return { state, versions, record: structuredClone(record), auditEntry: structuredClone(auditEntry), idempotent: false }
}

export function rollbackConfigVersion(
  sourceState: RuntimeState,
  sourceVersions: readonly ConfigVersionRecord[],
  input: RollbackConfigVersionCommand,
): ConfigVersioningResult {
  const command = rollbackConfigVersionSchema.parse(input)
  assertHistoryIntegrity(sourceState.store.id, sourceVersions)
  const previous = findIdempotentRecord(
    sourceState.store.id,
    sourceVersions,
    command,
    'rollback',
    command.targetVersion,
  )
  if (previous) return idempotentResult(sourceState, sourceVersions, previous)
  if (command.targetVersion === sourceState.config.version) throw new Error('不能回滚到当前版本')
  if (sourceState.draftConfig) throw new Error('存在未发布草稿，不能执行回滚')
  const target = sourceVersions.find(
    (record) => record.storeId === sourceState.store.id && record.version === command.targetVersion,
  )
  if (!target) throw new Error('要回滚的配置版本不存在')

  const state = cloneState(sourceState)
  const versions = cloneVersions(sourceVersions)
  appendCurrentBaseline(
    state,
    versions,
    command.actorId,
    command.reason,
    command.idempotencyKey,
    command.occurredAt,
  )
  const sourceVersion = state.config.version
  const config = structuredClone(target.snapshot)
  config.version = maxVersion(state, versions) + 1
  config.status = 'published'
  config.publishedAt = command.occurredAt
  state.config = config

  const record = createRecord(
    state,
    config,
    'rollback',
    sourceVersion,
    command.targetVersion,
    command,
  )
  versions.push(record)
  const auditEntry = appendAudit(state, record, 'config.version_rolled_back.v1')
  state.revision += 1
  return { state, versions, record: structuredClone(record), auditEntry: structuredClone(auditEntry), idempotent: false }
}
