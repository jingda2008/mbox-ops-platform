import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {KdsTransitionError} from './kds-repository.js'
import {InsufficientInventoryError,InventoryBalanceMissingError,InventoryRecipeMissingError} from './inventory-repository.js'
import {
  hashRequestFingerprint, IdempotencyConflictError,
  type IdempotentCommand, type CommandOutcome, type CommandExecution, type JsonObject,
  type NormalizedCommandExecutor,
} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'

export class NativePhysicalNotCommittedError extends Error {
  constructor(message:string){super(message);this.name='NativePhysicalNotCommittedError'}
}

/** Opt-in native protocol only. Legacy web commands retain their namespace and
 * response contract. The immutable audit receipt outlives the 24h cache; both
 * cached and durable replay reauthorize the current employee/device first. */
export function nativePhysicalExecutor(
  executor: Pick<NormalizedCommandExecutor, 'execute'>,
  context: {employeeId: string; businessDate: string},
  authorize: (tx: ScopedTransaction) => Promise<void>,
): Pick<NormalizedCommandExecutor, 'execute'> {
  return {
    async execute<Result>(command: Readonly<IdempotentCommand<Result>>,
      handler: (tx: ScopedTransaction) => Promise<CommandOutcome<Result>>,
      beforeClaim?: (tx: ScopedTransaction) => Promise<void>): Promise<CommandExecution<Result>> {
      const operationScope = `${command.operationScope}.native`
      const trace = `native-physical:${hashRequestFingerprint(`${operationScope}:${command.idempotencyKey}`)}`
      let durableReplayed = false
      const execution = await executor.execute({...command, operationScope}, async tx => {
        const original = (await tx.query<{actor_employee_id: string; after_snapshot: JsonObject; metadata: JsonObject}>(`
          SELECT actor_employee_id, after_snapshot, metadata FROM mbox.audit_events
          WHERE tenant_id=$1 AND store_id=$2 AND action='native.physical.receipt' AND trace_id=$3
          ORDER BY occurred_at,id LIMIT 1`, [command.scope.tenantId, command.scope.storeId, trace])).rows[0]
        if (original) {
          if (original.actor_employee_id !== context.employeeId
            || original.metadata.fingerprint !== command.requestFingerprint
            || original.metadata.idempotencyKey !== command.idempotencyKey) {
            throw new IdempotencyConflictError(operationScope, command.idempotencyKey)
          }
          durableReplayed = true
          return {result: command.resultCodec.decode(original.after_snapshot.result), auditEvents: [], outboxMessages: []}
        }
        let outcome: CommandOutcome<Result>
        try { outcome = await handler(tx) }
        catch(error) {
          // Only a new operation with no durable receipt can reach here. Throw
          // through the transaction runner; the API adds this marker after rollback.
          if(error instanceof ItemQuantityConflict || error instanceof KdsTransitionError
            || error instanceof InsufficientInventoryError || error instanceof InventoryBalanceMissingError
            || error instanceof InventoryRecipeMissingError) {
            throw new NativePhysicalNotCommittedError(error instanceof ItemQuantityConflict ? error.message : '制作状态或库存已变化，本次未提交，请刷新核对')
          }
          throw error
        }
        return {...outcome, auditEvents: [...outcome.auditEvents, {
          actor: {type: 'employee' as const, employeeId: context.employeeId},
          action: 'native.physical.receipt', objectType: 'native_physical_command',
          objectId: outcome.auditEvents[0]?.objectId ?? command.scope.storeId,
          businessDate: context.businessDate, traceId: trace,
          afterData: {result: command.resultCodec.encode(outcome.result)},
          metadata: {protocol: '1', idempotencyKey: command.idempotencyKey, fingerprint: command.requestFingerprint},
        }]}
      }, async tx => { await authorize(tx); await beforeClaim?.(tx) })
      return durableReplayed ? {...execution, replayed: true} : execution
    },
  }
}
export function isNativePhysicalKey(key: string) {
  return key.startsWith('native-remedy-') || key.startsWith('native-fulfillment-')
}
