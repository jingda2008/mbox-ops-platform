import { describe, expect, it } from 'vitest'
import type { ConfigVersionRecord } from '../src/shared/config-versioning-contracts.js'
import { saveConfigDraft } from './domain.js'
import { createSeedState } from './seed.js'
import {
  listConfigVersionHistory,
  publishConfigVersion,
  rollbackConfigVersion,
} from './config-versioning.js'

const publishedAt = '2026-07-14T12:00:00.000Z'

function draftWithWaterWarning(state = createSeedState(), warningSeconds = 15) {
  saveConfigDraft(state, {
    serviceTypes: state.config.serviceTypes.map((serviceType) => ({
      id: serviceType.id,
      enabled: serviceType.enabled,
      priority: serviceType.priority,
      dispatchRoleIds: [...serviceType.dispatchRoleIds],
      customerReply: serviceType.customerReply,
      actionScript: [...serviceType.actionScript],
      sla: serviceType.id === 'water'
        ? { ...serviceType.sla, warningSeconds }
        : { ...serviceType.sla },
    })),
    roles: state.config.roles.map((role) => ({
      id: role.id,
      maxConcurrentTasks: role.maxConcurrentTasks,
      canReceiveTasks: role.canReceiveTasks,
    })),
    proactiveOrderCare: { ...state.config.proactiveOrderCare },
  }, 'emp-chen')
  return state
}

function publishCommand(idempotencyKey = 'publish-config-001') {
  return {
    actorId: 'emp-chen',
    reason: '优化加水响应SLA',
    idempotencyKey,
    occurredAt: publishedAt,
  }
}

function publishVersionTwo() {
  return publishConfigVersion(draftWithWaterWarning(), [], publishCommand())
}

describe('config version publication', () => {
  it('publishes the draft and records both the original baseline and new snapshot', () => {
    const source = draftWithWaterWarning()
    const sourceConfig = structuredClone(source.config)
    const result = publishConfigVersion(source, [], publishCommand())

    expect(result.idempotent).toBe(false)
    expect(result.state.config.version).toBe(2)
    expect(result.state.config.serviceTypes.find((item) => item.id === 'water')?.sla.warningSeconds).toBe(15)
    expect(result.state.draftConfig).toBeNull()
    expect(result.versions.map((record) => [record.version, record.operation])).toEqual([
      [1, 'baseline'],
      [2, 'publish'],
    ])
    expect(result.auditEntry).toMatchObject({
      actorId: 'emp-chen',
      action: 'config.version_published.v1',
      details: {
        sourceVersion: 1,
        newVersion: 2,
        reason: '优化加水响应SLA',
        idempotencyKey: 'publish-config-001',
      },
    })
    expect(source.config).toEqual(sourceConfig)
    expect(source.draftConfig).not.toBeNull()
  })

  it('keeps snapshots immutable after later state and returned record changes', () => {
    const result = publishVersionTwo()
    const history = result.versions
    result.state.config.serviceTypes[0]!.name = '被修改'
    result.record.snapshot.serviceTypes[0]!.name = '返回值被修改'

    expect(history.find((record) => record.version === 2)?.snapshot.serviceTypes[0]?.name).not.toBe('被修改')
    expect(history.find((record) => record.version === 2)?.snapshot.serviceTypes[0]?.name).not.toBe('返回值被修改')
    const listed = listConfigVersionHistory(result.state.store.id, history)
    listed[0]!.snapshot.serviceTypes[0]!.name = '列表被修改'
    expect(history.find((record) => record.version === 2)?.snapshot.serviceTypes[0]?.name).not.toBe('列表被修改')
  })

  it('returns the same publication for an idempotent retry without another audit', () => {
    const first = publishVersionTwo()
    const retried = publishConfigVersion(first.state, first.versions, publishCommand())

    expect(retried.idempotent).toBe(true)
    expect(retried.record.id).toBe(first.record.id)
    expect(retried.versions).toHaveLength(2)
    expect(retried.state.auditEntries).toHaveLength(first.state.auditEntries.length)
    expect(retried.state.revision).toBe(first.state.revision)
  })

  it('rejects publication without a draft and conflicting idempotency use', () => {
    expect(() => publishConfigVersion(createSeedState(), [], publishCommand())).toThrow('没有待发布草稿')
    const first = publishVersionTwo()
    expect(() => publishConfigVersion(first.state, first.versions, {
      ...publishCommand(),
      reason: '另一个发布原因',
    })).toThrow('幂等键已用于其他配置操作')
    expect(() => rollbackConfigVersion(first.state, first.versions, {
      ...publishCommand(),
      targetVersion: 1,
    })).toThrow('幂等键已用于其他配置操作')
  })
})

describe('config version rollback', () => {
  it('rolls back through a new monotonically increasing version and audits the reason', () => {
    const published = publishVersionTwo()
    const result = rollbackConfigVersion(published.state, published.versions, {
      actorId: 'emp-chen',
      reason: '新SLA导致现场误报，恢复稳定配置',
      idempotencyKey: 'rollback-config-001',
      occurredAt: '2026-07-14T12:30:00.000Z',
      targetVersion: 1,
    })

    expect(result.state.config.version).toBe(3)
    expect(result.state.config.serviceTypes.find((item) => item.id === 'water')?.sla.warningSeconds).toBe(30)
    expect(result.record).toMatchObject({
      version: 3,
      operation: 'rollback',
      sourceVersion: 2,
      rollbackTargetVersion: 1,
    })
    expect(result.versions.map((record) => record.version)).toEqual([1, 2, 3])
    expect(result.auditEntry).toMatchObject({
      actorId: 'emp-chen',
      action: 'config.version_rolled_back.v1',
      details: {
        sourceVersion: 2,
        targetVersion: 1,
        newVersion: 3,
        reason: '新SLA导致现场误报，恢复稳定配置',
      },
    })
  })

  it('returns the original rollback result for a duplicate idempotent command', () => {
    const published = publishVersionTwo()
    const command = {
      actorId: 'emp-chen',
      reason: '恢复稳定配置',
      idempotencyKey: 'rollback-config-002',
      occurredAt: '2026-07-14T12:30:00.000Z',
      targetVersion: 1,
    }
    const first = rollbackConfigVersion(published.state, published.versions, command)
    const retried = rollbackConfigVersion(first.state, first.versions, command)

    expect(retried.idempotent).toBe(true)
    expect(retried.record.version).toBe(3)
    expect(retried.versions).toHaveLength(3)
    expect(retried.state.auditEntries).toHaveLength(first.state.auditEntries.length)
  })

  it('rejects missing and current versions without changing inputs', () => {
    const published = publishVersionTwo()
    const historyBefore = structuredClone(published.versions)
    const stateBefore = structuredClone(published.state)
    const base = {
      actorId: 'emp-chen',
      reason: '验证错误路径',
      idempotencyKey: 'rollback-error-001',
      occurredAt: '2026-07-14T12:30:00.000Z',
    }

    expect(() => rollbackConfigVersion(published.state, published.versions, {
      ...base,
      targetVersion: 99,
    })).toThrow('要回滚的配置版本不存在')
    expect(() => rollbackConfigVersion(published.state, published.versions, {
      ...base,
      idempotencyKey: 'rollback-error-002',
      targetVersion: 2,
    })).toThrow('不能回滚到当前版本')
    expect(published.state).toEqual(stateBefore)
    expect(published.versions).toEqual(historyBefore)
  })

  it('rejects rollback while an unpublished draft exists', () => {
    const published = publishVersionTwo()
    const withDraft = draftWithWaterWarning(published.state, 10)
    expect(() => rollbackConfigVersion(withDraft, published.versions, {
      actorId: 'emp-chen',
      reason: '尝试直接回滚',
      idempotencyKey: 'rollback-draft-001',
      occurredAt: '2026-07-14T12:30:00.000Z',
      targetVersion: 1,
    })).toThrow('存在未发布草稿，不能执行回滚')
  })

  it('rejects corrupted duplicate history', () => {
    const published = publishVersionTwo()
    const duplicate = structuredClone(published.versions[0]) as ConfigVersionRecord
    expect(() => listConfigVersionHistory(published.state.store.id, [...published.versions, duplicate]))
      .toThrow('配置版本历史存在重复版本 1')
  })
})
