export function readPersistedCart(
  storageKey?: string,
  storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.sessionStorage,
): Record<string, number> {
  if (!storageKey || storage === undefined) return {}
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) ?? '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([productId, quantity]) => (
      productId.length > 0 && productId.length <= 128 && Number.isSafeInteger(quantity) && Number(quantity) > 0 && Number(quantity) <= 999
        ? [[productId, Number(quantity)]]
        : []
    )))
  } catch {
    return {}
  }
}

export function persistCart(storageKey: string | undefined, cart: Record<string, number>) {
  if (!storageKey || typeof window === 'undefined') return
  try {
    if (Object.keys(cart).length === 0) window.sessionStorage.removeItem(storageKey)
    else window.sessionStorage.setItem(storageKey, JSON.stringify(cart))
  } catch {
    // Browser storage restrictions must not block current-view ordering.
  }
}

export function clearPersistedCart(storageKey?: string) {
  if (!storageKey || typeof window === 'undefined') return
  try { window.sessionStorage.removeItem(storageKey) } catch { /* current-view ordering remains available */ }
}
