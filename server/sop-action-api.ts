import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { RuntimeState, Table } from '../src/shared/contracts.js'
import { sopActionResolutionSchema, type SopActionResolutionInput } from '../src/shared/sop-contracts.js'
import { requireAnyRole, requireTableDataScope } from './authorization.js'
import type { RuntimeRepository } from './repository.js'
import { requireStaticTableQr, verifyTableAccessToken } from './table-access.js'

export class SopActionBusinessError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number) {
    super(message)
  }
}

function tableTokenVersion(table: Table) {
  const version = (table as Table & { qrTokenVersion?: number }).qrTokenVersion
  return Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : 1
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function tableTokenValue(scannedValue: string) {
  if (!/^https?:\/\//i.test(scannedValue)) return scannedValue
  let token: string | null
  try {
    const url = new URL(scannedValue)
    token = new URLSearchParams(url.hash.slice(1)).get('token')
  } catch {
    throw new SopActionBusinessError('二维码链接格式不正确，请重新扫描', 'SOP_QR_URL_INVALID', 400)
  }
  if (!token) throw new SopActionBusinessError('二维码链接中没有桌码凭证', 'SOP_QR_TOKEN_MISSING', 400)
  return token
}

function verifyEvidenceToken(state: RuntimeState, tableId: string, token: string, secrets: string[]) {
  const signedToken = tableTokenValue(token)
  let claims
  let lastError: unknown = null
  for (const secret of secrets) {
    try {
      claims = requireStaticTableQr(verifyTableAccessToken(signedToken, secret))
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!claims) throw lastError instanceof Error ? lastError : new SopActionBusinessError('实体桌码验证失败', 'SOP_QR_INVALID', 400)
  const table = state.tables.find((candidate) => candidate.id === tableId)
  if (!table) throw new SopActionBusinessError('SOP验证桌台不存在', 'SOP_TABLE_NOT_FOUND', 404)
  if (claims.storeId !== state.store.id || claims.tableCode.toLowerCase() !== table.code.toLowerCase()) {
    throw new SopActionBusinessError(`请扫描${table.code}桌面的实体二维码`, 'SOP_QR_TABLE_MISMATCH', 409)
  }
  if (claims.tokenVersion !== tableTokenVersion(table)) throw new SopActionBusinessError('这个实体桌码已经撤销，请使用当前桌码', 'SOP_QR_REVOKED', 410)
  return `table-qr-sha256:${tokenHash(signedToken)}`
}

export function resolveSopAction(
  state: RuntimeState,
  recordId: string,
  actorId: string,
  input: SopActionResolutionInput,
  qrSecrets: string[],
  now = new Date(),
) {
  const replay = state.auditEntries.find((entry) => (
    entry.action === 'sop.action.resolved.v1' && entry.details.idempotencyKey === input.idempotencyKey
  ))
  if (replay) {
    const existing = (state.sopActionRecords ?? []).find((record) => record.id === replay.objectId)
    if (!existing || existing.id !== recordId) throw new SopActionBusinessError('幂等键已被其他SOP动作使用', 'SOP_IDEMPOTENCY_CONFLICT', 409)
    return existing
  }
  const record = (state.sopActionRecords ?? []).find((candidate) => candidate.id === recordId)
  if (!record) throw new SopActionBusinessError('SOP动作记录不存在', 'SOP_ACTION_NOT_FOUND', 404)
  if (!['manager_review', 'table_qr_scan'].includes(record.type)) throw new SopActionBusinessError('这个SOP动作不支持人工确认', 'SOP_ACTION_NOT_MANUAL', 409)
  if (record.status !== 'awaiting_evidence') throw new SopActionBusinessError('这个SOP动作已经处理或当前不能处理', 'SOP_ACTION_NOT_PENDING', 409)

  let evidenceReference: string | null = null
  if (record.type === 'table_qr_scan') {
    if (input.decision !== 'approve') throw new SopActionBusinessError('桌码验证不能手工拒绝，请改由经理处理异常', 'SOP_QR_REJECT_FORBIDDEN', 409)
    if (!input.tableQrToken) throw new SopActionBusinessError('桌码验证必须扫描实体桌码', 'SOP_QR_REQUIRED', 400)
    evidenceReference = verifyEvidenceToken(state, record.tableId, input.tableQrToken, qrSecrets)
  }
  record.status = input.decision === 'approve' ? 'completed' : 'rejected'
  record.completedAt = now.toISOString()
  record.completedBy = actorId
  record.evidenceReference = evidenceReference
  record.resolutionNote = input.note
  record.failureReason = input.decision === 'reject' ? input.note : null
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'sop.action.resolved.v1',
    objectType: 'sop_action_record',
    objectId: record.id,
    occurredAt: now.toISOString(),
    details: {
      type: record.type,
      decision: input.decision,
      evidenceReference,
      idempotencyKey: input.idempotencyKey,
    },
  })
  state.revision += 1
  return record
}

export function registerSopActionRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: { qrSecret: string; qrPreviousSecret?: string },
) {
  app.post<{ Params: { recordId: string } }>('/api/sop/actions/:recordId/resolve', async (request) => {
    const input = sopActionResolutionSchema.parse(request.body)
    return repository.mutate((state) => {
      const record = (state.sopActionRecords ?? []).find((candidate) => candidate.id === request.params.recordId)
      if (!record) throw new SopActionBusinessError('SOP动作记录不存在', 'SOP_ACTION_NOT_FOUND', 404)
      const actor = requireAnyRole(request, state, record.requiredRoleIds, 'sop.action.resolve', '处理SOP验证')
      requireTableDataScope(request, state, record.tableId, 'sop.action.resolve')
      return resolveSopAction(
        state,
        record.id,
        actor.actorId,
        input,
        [options.qrSecret, options.qrPreviousSecret].filter((value): value is string => Boolean(value)),
      )
    })
  })
}
