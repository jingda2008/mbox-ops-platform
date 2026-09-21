import { hashRequestFingerprint, IdempotencyConflictError, type JsonCodec } from './command-executor.js'
import { hashGuestBehaviorPrincipal } from './guest-behavior-repository.js'
import { GuestAuthenticationRequiredError } from './guest-request-context.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestServiceReceiptIdentity {
  idempotencyKey: string
  tableSessionId: string
  customerId: string
  actorRef: string
  deviceFingerprint: string
  requestFingerprint: string
}

export class GuestServiceReceiptUnattributedError extends Error {
  constructor() { super('原服务记录需由服务员核对，请勿重复提交。'); this.name = 'GuestServiceReceiptUnattributedError' }
}

export async function readGuestServiceReceipt<Result>(transaction: ScopedTransaction, identity: GuestServiceReceiptIdentity, codec: JsonCodec<Result>): Promise<Result | null> {
  // Current authority is required even for an old accepted result.
  if (!await lockBoundGuestTablePosition(transaction, identity)) throw new GuestAuthenticationRequiredError()
  const selected = await transaction.query<{
    table_session_id: string | null; customer_id: string | null; actor_ref_hash: string | null; device_hash: string | null; request_sha256: string; same_customer: boolean; result: unknown
  }>(`
    SELECT table_session_id,customer_id,actor_ref_hash,device_hash,request_sha256,result,
      mbox.canonical_customer_id(tenant_id,store_id,customer_id)=mbox.canonical_customer_id(tenant_id,store_id,$4::uuid) AS same_customer
    FROM mbox.guest_service_command_receipts
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND idempotency_key=$3
  `, [transaction.scope.tenantId, transaction.scope.storeId, identity.idempotencyKey, identity.customerId])
  const row = selected.rows[0]
  if (!row) return null
  if (row.table_session_id === null) throw new GuestServiceReceiptUnattributedError()
  // Session IDs may rotate on reauthentication; retain the original actor in
  // the immutable receipt, but authorize recovery by current canonical owner.
  if (row.table_session_id !== identity.tableSessionId || row.same_customer !== true
    || row.device_hash !== hashGuestBehaviorPrincipal(identity.deviceFingerprint)
    || row.request_sha256 !== hashRequestFingerprint(identity.requestFingerprint)) {
    throw new IdempotencyConflictError('guest.service.request', identity.idempotencyKey)
  }
  return codec.decode(row.result)
}

export async function saveGuestServiceReceipt<Result>(transaction: ScopedTransaction, identity: GuestServiceReceiptIdentity, result: Result, codec: JsonCodec<Result>): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.guest_service_command_receipts
      (tenant_id,store_id,idempotency_key,table_session_id,customer_id,actor_ref_hash,device_hash,request_sha256,result)
    VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb)
  `, [transaction.scope.tenantId, transaction.scope.storeId, identity.idempotencyKey,
    identity.tableSessionId, identity.customerId, hashGuestBehaviorPrincipal(identity.actorRef),
    hashGuestBehaviorPrincipal(identity.deviceFingerprint), hashRequestFingerprint(identity.requestFingerprint), JSON.stringify(codec.encode(result))])
}
