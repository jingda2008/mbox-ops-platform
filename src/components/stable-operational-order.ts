export function stabilizeOperationalOrder<T extends { id: string }>(
  rankedItems: readonly T[],
  previousIds: readonly string[],
  interactionIds: ReadonlySet<string>,
) {
  if (previousIds.length === 0 || interactionIds.size === 0) return [...rankedItems]
  const byId = new Map(rankedItems.map((item) => [item.id, item]))
  const stable = previousIds.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
  const retainedIds = new Set(stable.map((item) => item.id))
  stable.push(...rankedItems.filter((item) => !retainedIds.has(item.id)))
  return stable
}
