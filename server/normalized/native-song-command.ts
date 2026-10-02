import type { AuditActor, JsonCodec, NormalizedCommandExecutor } from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { SongRequestRepository, SongRequestNotFoundError, SongRequestTransitionError, type SongRequest, type SongRequestStatus } from './song-request-repository.js'
import type { StoreScope } from './transaction-runner.js'

export type NativeSongAction = 'confirm' | 'reject' | 'paid' | 'performed' | 'cancel'
export interface NativeSongInput {
  scope: Readonly<StoreScope>; actor: AuditActor; businessDate: string
  idempotencyKey: string; requestFingerprint: string; requestId: string
  employeeId: string; expectedStatus: SongRequestStatus; action: NativeSongAction; reason: string
  quotedAmountMinor?: number; currency?: string; paymentId?: string; reconciliationEntryId?: string
}
export interface NativeSongReceipt {
  request: SongRequest; previousStatus: string; action: string; reason: string
  paymentId: string | null; reconciliationEntryId: string | null
}
const codec: JsonCodec<NativeSongReceipt> = {
  encode: value => JSON.parse(JSON.stringify(value)),
  decode(value) {
    if (!isRecord(value)
      || typeof value.previousStatus !== 'string' || typeof value.action !== 'string'
      || typeof value.reason !== 'string' || !isRecord(value.request) || typeof value.request.id !== 'string') throw new TypeError('点歌原回执无效')
    return value as unknown as NativeSongReceipt
  },
}
export function executeNativeSong(commands: Pick<NormalizedCommandExecutor, 'execute'>, input: NativeSongInput) {
  if (input.actor.type !== 'employee' || input.actor.employeeId !== input.employeeId
    || !/^native-business-[a-f0-9-]{36}$/.test(input.idempotencyKey)
    || input.reason.trim().length < 2 || input.reason.length > 500) throw new TypeError('点歌操作身份或原请求无效')
  const permission = input.action === 'paid' ? 'song.payment.record' : 'song.manage'
  return commands.execute({scope: input.scope, operationScope: `native.song.${input.action}`,
    idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint,
    retainReceipt: true, resultCodec: codec}, async tx => {
    const repo = new SongRequestRepository(tx)
    const before = await repo.findById(input.requestId, true)
    if (!before) throw new SongRequestNotFoundError(input.requestId)
    if (before.status !== input.expectedStatus) throw new SongRequestTransitionError(before.id, before.status, input.expectedStatus)
    let request: SongRequest
    switch (input.action) {
      case 'confirm':
        if (!Number.isSafeInteger(input.quotedAmountMinor) || input.quotedAmountMinor! < 0 || input.currency !== 'CNY') throw new TypeError('请核对人民币报价')
        request = (await repo.confirmWithResult({requestId: input.requestId, actorEmployeeId: input.employeeId,
          quotedAmountMinor: input.quotedAmountMinor!, currency: input.currency})).request
        break
      case 'paid':
        if (!input.paymentId || !input.reconciliationEntryId) throw new TypeError('缺少原付款和对账凭证')
        request = await repo.markPaid({requestId: input.requestId, actorEmployeeId: input.employeeId,
          paymentId: input.paymentId, reconciliationEntryId: input.reconciliationEntryId})
        break
      case 'reject': request = await repo.reject(input.requestId, input.employeeId); break
      case 'performed': request = await repo.markPerformed(input.requestId, input.employeeId); break
      case 'cancel': request = await repo.cancel(input.requestId); break
    }
    const result: NativeSongReceipt = {request, previousStatus: before.status, action: input.action,
      reason: input.reason, paymentId: input.paymentId ?? null, reconciliationEntryId: input.reconciliationEntryId ?? null}
    const after = {requestId: request.id, status: request.status, quotedAmountMinor: request.quotedAmountMinor,
      currency: request.currency, reason: input.reason}
    const event = `song_request.${request.status}`
    return {result, auditEvents: [{actor: input.actor, action: event, objectType: 'song_request', objectId: request.id,
      businessDate: input.businessDate, reason: input.reason, beforeData: {status: before.status}, afterData: after}],
      outboxMessages: [{eventId: `performance:${event}:${input.idempotencyKey}`, aggregateType: 'song_request',
        aggregateId: request.id, aggregateVersion: 1, eventType: `${event}.v1`, payload: after}]}
  }, async tx => {
    // Recheck even when replaying a terminal receipt; revocation must take effect immediately.
    await new StaffAccessRepository(tx).assertPermission(input.employeeId, permission)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
