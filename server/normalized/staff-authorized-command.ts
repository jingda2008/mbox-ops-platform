import type { CommandExecution, CommandOutcome, IdempotentCommand, NormalizedCommandExecutor } from './command-executor.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

/** Staff-only commands: permission checks belong before both receipt lookup and execution.
 * Actor binding deliberately rejects legacy fingerprints that cannot prove their operator;
 * clients must retain the original key and verify state instead of creating a new retry.
 */
export function staffAuthorizedCommands(
  commands: Pick<NormalizedCommandExecutor, 'execute'>,
  employeeId: string,
  permission: string | readonly string[],
): Pick<NormalizedCommandExecutor, 'execute'> {
  return {
    execute<Result>(command: Readonly<IdempotentCommand<Result>>,
      handler: (tx: ScopedTransaction) => Promise<CommandOutcome<Result>>,
      beforeClaim?: (tx: ScopedTransaction) => Promise<void>): Promise<CommandExecution<Result>> {
      return reauthorizingCommands(commands).execute({
        ...command,
        requestFingerprint: JSON.stringify({ employeeId, requestFingerprint: command.requestFingerprint }),
      }, handler, async tx => {
        const permissions = typeof permission === 'string' ? [permission] : permission
        const access = new StaffAccessRepository(tx)
        let allowed = false
        for (const code of permissions) {
          try { await access.assertPermission(employeeId, code); allowed = true; break }
          catch (error) { if (!(error instanceof StaffAccessDeniedError)) throw error }
        }
        if (!allowed) throw new StaffAccessDeniedError(permissions.join(' or '))
        await beforeClaim?.(tx)
      })
    },
  }
}

/** Only pass side-effect-free authority checks as beforeClaim. Recheck after lock waits:
 * a preflight that passed before blocking on a receipt is no longer current evidence.
 */
export function reauthorizingCommands(commands: Pick<NormalizedCommandExecutor, 'execute'>): Pick<NormalizedCommandExecutor, 'execute'> {
  return {
    execute<Result>(command: Readonly<IdempotentCommand<Result>>,
      handler: (tx: ScopedTransaction) => Promise<CommandOutcome<Result>>,
      authorize?: (tx: ScopedTransaction) => Promise<void>): Promise<CommandExecution<Result>> {
      return commands.execute({ ...command, authorizeReplay: async (tx, evidence) => {
        await authorize?.(tx)
        await command.authorizeReplay?.(tx, evidence)
      } }, async tx => {
        await authorize?.(tx)
        return handler(tx)
      }, authorize)
    },
  }
}
