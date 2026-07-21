import { describe, expect, it } from 'vitest'
import type { SopActionRecord } from '../src/shared/sop-contracts.js'
import { createSeedState } from './seed.js'
import { resolveSopAction } from './sop-action-api.js'
import { signStaticTableQrToken } from './table-access.js'

const secret = 'q'.repeat(32)

function qrRecord(): SopActionRecord {
  return {
    id: 'sop-action-qr-1', executionId: 'sop-execution-1', stepId: 'step-qr', taskId: 'task-qr',
    tableSessionId: 'session-table-l01', tableId: 'table-l01', type: 'table_qr_scan', status: 'awaiting_evidence',
    recipientEmployeeIds: ['emp-lin'], requiredRoleIds: ['server', 'manager'], content: '请到L01并扫描实体桌码',
    attemptCount: 0, requestedAt: '2026-07-19T12:00:00.000Z', lastAttemptAt: null, nextAttemptAt: null,
    completedAt: null, completedBy: null, providerReference: null, failureReason: null,
    evidenceReference: null, resolutionNote: null, leaseOwner: null, leaseExpiresAt: null,
  }
}

describe('SOP evidence resolution', () => {
  it('accepts only the signed static QR for the current target table and stores only its hash', () => {
    const state = createSeedState()
    state.sopActionRecords = [qrRecord()]
    const correct = signStaticTableQrToken({
      storeId: state.store.id, tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)
    const wrongTable = signStaticTableQrToken({
      storeId: state.store.id, tableCode: 'L02', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)

    expect(() => resolveSopAction(state, 'sop-action-qr-1', 'emp-lin', {
      decision: 'approve', note: '已经到桌', tableQrToken: wrongTable, idempotencyKey: 'qr-wrong-table-1',
    }, [secret])).toThrow('L01')

    const resolved = resolveSopAction(state, 'sop-action-qr-1', 'emp-lin', {
      decision: 'approve', note: '已经到桌并扫码', tableQrToken: `https://mbox.example.com/guest?token=${encodeURIComponent(correct)}`, idempotencyKey: 'qr-correct-table-1',
    }, [secret])
    expect(resolved).toMatchObject({ status: 'completed', completedBy: 'emp-lin' })
    expect(resolved.evidenceReference).toMatch(/^table-qr-sha256:/)
    expect(JSON.stringify(state.auditEntries)).not.toContain(correct)
  })

  it('keeps manager rejection as a terminal audited result', () => {
    const state = createSeedState()
    state.sopActionRecords = [{ ...qrRecord(), id: 'sop-action-review-1', type: 'manager_review', requiredRoleIds: ['manager'] }]
    const rejected = resolveSopAction(state, 'sop-action-review-1', 'emp-chen', {
      decision: 'reject', note: '现场动作未达到标准', idempotencyKey: 'manager-reject-1',
    }, [secret])
    expect(rejected).toMatchObject({ status: 'rejected', failureReason: '现场动作未达到标准' })
    expect(state.auditEntries.at(-1)).toMatchObject({ action: 'sop.action.resolved.v1', actorId: 'emp-chen' })
  })

  it('returns a clear business error for a malformed QR link', () => {
    const state = createSeedState()
    state.sopActionRecords = [qrRecord()]
    expect(() => resolveSopAction(state, 'sop-action-qr-1', 'emp-lin', {
      decision: 'approve', note: '重新扫码', tableQrToken: 'https://[bad-link', idempotencyKey: 'qr-malformed-link-1',
    }, [secret])).toThrow('二维码链接格式不正确')
  })
})
