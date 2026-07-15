import { describe, expect, it } from 'vitest'
import { createInventoryDomainState } from './inventory-domain.js'
import {
  beginDualApprovalDecision,
  completeDualApprovalDecision,
  requestDualApproval,
} from './dual-approval.js'

const requester = {
  employeeId: 'emp-requester', displayName: '发起人', roleId: 'manager', authenticatedBy: 'signed_session' as const,
}
const approver = {
  employeeId: 'emp-approver', displayName: '审批人', roleId: 'owner', authenticatedBy: 'signed_session' as const,
}

describe('dual approval state machine', () => {
  it('rejects self approval and keeps rejected operations unexecuted with before/after evidence', () => {
    const state = createInventoryDomainState({ tenantId: 'tenant', storeId: 'store' })
    const approval = requestDualApproval(state, {
      approvalId: 'approval-1', action: 'bottle_void', targetId: 'batch-1',
      requestPayload: { reason: '登记错误' }, beforeSnapshot: { status: 'stored', remainingQuantity: 500 },
      requestedBy: requester, reason: '登记错误申请作废', occurredAt: '2026-07-15T10:00:00.000Z',
      idempotencyKey: 'approval-request-0001',
    })

    expect(() => beginDualApprovalDecision(state, approval.id, {
      decision: 'approve', decidedBy: requester, reason: '本人批准',
      occurredAt: '2026-07-15T10:01:00.000Z', idempotencyKey: 'approval-self-0001',
    })).toThrow('发起人不能审批自己的申请')

    const decision = {
      decision: 'reject' as const, decidedBy: approver, reason: '复核后应保留原批次',
      occurredAt: '2026-07-15T10:02:00.000Z', idempotencyKey: 'approval-reject-0001',
    }
    expect(beginDualApprovalDecision(state, approval.id, decision).replay).toBe(false)
    const rejected = completeDualApprovalDecision(state, approval.id, decision, approval.beforeSnapshot)

    expect(rejected).toMatchObject({ status: 'rejected', decision: 'reject', executedAt: null })
    expect(rejected.afterSnapshot).toEqual(rejected.beforeSnapshot)
    expect(beginDualApprovalDecision(state, approval.id, decision)).toMatchObject({ replay: true })
    expect(() => beginDualApprovalDecision(state, approval.id, {
      ...decision, decision: 'approve', idempotencyKey: 'approval-changed-0001',
    })).toThrow('审批单已经处理，不能重复决定')
  })
})
