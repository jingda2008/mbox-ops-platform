import type {
  InventoryApprovalAction,
  InventoryApprovalActorSnapshot,
  InventoryApprovalRequest,
  InventoryDomainState,
} from '../src/shared/inventory-contracts.js'
import { normalizeInventoryDomainState } from './inventory-domain.js'

export interface RequestDualApprovalCommand {
  approvalId: string
  action: InventoryApprovalAction
  targetId: string
  requestPayload: Record<string, unknown>
  beforeSnapshot: unknown
  requestedBy: InventoryApprovalActorSnapshot
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface DecideDualApprovalCommand {
  decision: 'approve' | 'reject'
  decidedBy: InventoryApprovalActorSnapshot
  reason: string
  occurredAt: string
  idempotencyKey: string
}

function assertText(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error('审批时间必须是有效的ISO时间')
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return JSON.stringify(value)
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
    }
    default:
      throw new Error('审批请求包含不支持的数据类型')
  }
}

function sameRequest(existing: InventoryApprovalRequest, command: RequestDualApprovalCommand) {
  return existing.action === command.action &&
    existing.targetId === command.targetId &&
    existing.requestedBy.employeeId === command.requestedBy.employeeId &&
    existing.requestReason === command.reason &&
    canonicalize(existing.requestPayload) === canonicalize(command.requestPayload) &&
    canonicalize(existing.beforeSnapshot) === canonicalize(command.beforeSnapshot)
}

export function requestDualApproval(state: InventoryDomainState, command: RequestDualApprovalCommand) {
  normalizeInventoryDomainState(state)
  assertText(command.approvalId, '审批单ID')
  assertText(command.targetId, '审批对象ID')
  assertText(command.reason, '申请原因')
  assertText(command.idempotencyKey, '幂等键')
  assertTimestamp(command.occurredAt)
  const replay = state.approvalRequests.find((item) => item.requestIdempotencyKey === command.idempotencyKey)
  if (replay) {
    if (!sameRequest(replay, command)) throw new Error('幂等键已用于不同审批申请')
    return replay
  }
  if (state.approvalRequests.some((item) => item.id === command.approvalId)) throw new Error('审批单ID已存在')
  const approval: InventoryApprovalRequest = {
    tenantId: state.tenantId,
    storeId: state.storeId,
    id: command.approvalId,
    action: command.action,
    status: 'pending',
    targetId: command.targetId,
    requestPayload: structuredClone(command.requestPayload),
    beforeSnapshot: structuredClone(command.beforeSnapshot),
    afterSnapshot: null,
    requestedBy: structuredClone(command.requestedBy),
    requestedAt: command.occurredAt,
    requestReason: command.reason,
    requestIdempotencyKey: command.idempotencyKey,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    decisionIdempotencyKey: null,
    executedAt: null,
  }
  state.approvalRequests.push(approval)
  return approval
}

export function beginDualApprovalDecision(
  state: InventoryDomainState,
  approvalId: string,
  command: DecideDualApprovalCommand,
) {
  normalizeInventoryDomainState(state)
  assertText(command.reason, '审批意见')
  assertText(command.idempotencyKey, '幂等键')
  assertTimestamp(command.occurredAt)
  const approval = state.approvalRequests.find((item) => item.id === approvalId)
  if (!approval) throw new Error('审批单不存在')
  if (approval.requestedBy.employeeId === command.decidedBy.employeeId) throw new Error('发起人不能审批自己的申请')
  if (approval.status !== 'pending') {
    const replay = approval.decision === command.decision &&
      approval.decisionIdempotencyKey === command.idempotencyKey &&
      approval.decidedBy?.employeeId === command.decidedBy.employeeId &&
      approval.decisionReason === command.reason
    if (!replay) throw new Error('审批单已经处理，不能重复决定')
    return { approval, replay: true as const }
  }
  if (Date.parse(command.occurredAt) < Date.parse(approval.requestedAt)) {
    throw new Error('审批时间不能早于申请时间')
  }
  return { approval, replay: false as const }
}

export function completeDualApprovalDecision(
  state: InventoryDomainState,
  approvalId: string,
  command: DecideDualApprovalCommand,
  afterSnapshot: unknown,
) {
  const approval = state.approvalRequests.find((item) => item.id === approvalId)
  if (!approval || approval.status !== 'pending') throw new Error('待处理审批单不存在')
  approval.status = command.decision === 'approve' ? 'approved' : 'rejected'
  approval.decision = command.decision
  approval.decidedBy = structuredClone(command.decidedBy)
  approval.decidedAt = command.occurredAt
  approval.decisionReason = command.reason
  approval.decisionIdempotencyKey = command.idempotencyKey
  approval.afterSnapshot = structuredClone(afterSnapshot)
  approval.executedAt = command.decision === 'approve' ? command.occurredAt : null
  return approval
}
