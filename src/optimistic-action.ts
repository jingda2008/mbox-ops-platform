const actionVersions = new Map<string, number>()

export interface OptimisticActionOptions<TSnapshot, TResult> {
  key: string
  apply: () => TSnapshot
  commit: () => Promise<TResult>
  reconcile: (result: TResult) => void
  rollback: (snapshot: TSnapshot, error: unknown) => void
}

export async function runOptimisticAction<TSnapshot, TResult>({
  key,
  apply,
  commit,
  reconcile,
  rollback,
}: OptimisticActionOptions<TSnapshot, TResult>) {
  const version = (actionVersions.get(key) ?? 0) + 1
  actionVersions.set(key, version)
  const snapshot = apply()
  try {
    const result = await commit()
    if (actionVersions.get(key) === version) reconcile(result)
    return result
  } catch (error) {
    if (actionVersions.get(key) === version) rollback(snapshot, error)
    throw error
  } finally {
    if (actionVersions.get(key) === version) actionVersions.delete(key)
  }
}

export function resetOptimisticActionsForTests() {
  actionVersions.clear()
}
