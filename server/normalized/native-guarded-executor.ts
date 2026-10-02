import {createHash} from 'node:crypto'
import type {NormalizedCommandExecutor,IdempotentCommand,CommandOutcome,CommandExecution} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'

/** Reuse the domain command, audit and outbox contracts with a distinct native
 * namespace, permanent receipts, authorization on replay and fresh-state guards
 * only on first execution. A stale view must never replace the original input. */
export function nativeGuardedExecutor(executor:Pick<NormalizedCommandExecutor,'execute'>,input:{
  fingerprint:unknown
  authorize:(tx:ScopedTransaction)=>Promise<void>
  guard?:(tx:ScopedTransaction)=>Promise<void>
}):Pick<NormalizedCommandExecutor,'execute'> {
  return {execute<Result>(command:Readonly<IdempotentCommand<Result>>,handler:(tx:ScopedTransaction)=>Promise<CommandOutcome<Result>>,beforeClaim?:(tx:ScopedTransaction)=>Promise<void>):Promise<CommandExecution<Result>> {
    if(!/^native-business-[a-f0-9-]{36}$/.test(command.idempotencyKey))throw new TypeError('原请求编号无效')
    return executor.execute({...command,operationScope:command.operationScope+'.native',retainReceipt:true,
      requestFingerprint:createHash('sha256').update(JSON.stringify(input.fingerprint)).digest('hex')},async tx=>{await input.guard?.(tx);return handler(tx)},async tx=>{await input.authorize(tx);await beforeClaim?.(tx)})
  }}
}
