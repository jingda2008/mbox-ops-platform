export class RecoveryJournalError extends Error {}
type StorageReader = Pick<Storage, 'getItem'>

/** An unreadable existing journal is not evidence that no command was sent. */
export function readRecoveryJournal<T>(storage: StorageReader | undefined, key: string,
  valid: (value: unknown) => value is T, fallback: T | null): T | null {
  let raw: string | null
  try { raw = storage?.getItem(key) ?? null }
  catch { throw new RecoveryJournalError('原操作记录暂时无法读取，请恢复存储访问后核对，勿重新提交') }
  if (raw === null) return fallback
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new RecoveryJournalError('原操作记录损坏，请保留记录并核对原业务，勿重新提交') }
  if (!valid(value)) throw new RecoveryJournalError('原操作记录损坏，请保留记录并核对原业务，勿重新提交')
  return value
}
