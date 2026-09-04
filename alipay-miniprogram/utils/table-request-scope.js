function tableRequestScope(session) {
  const value = session && typeof session === 'object' ? session : {}
  // This value stays in memory only. Persistent cache keys use the hashed
  // scope from session.js, so a scanned credential is never written as a key.
  // A scan first has only its opaque fixed-QR credential. Its local scan nonce
  // separates two rescans of the same physical QR while the server resolves a
  // concrete table session. Once returned, cartScope is an unguessable
  // table-session derivative and becomes the authoritative client scope.
  // Table code alone remains a fallback for legacy/development browsing.
  const tableToken = String(value.tableToken || '').trim()
  const cartScope = String(value.cartScope || '').trim()
  if (tableToken && cartScope) return `session:${tableToken}:${cartScope}`
  if (tableToken) return `scan:${String(value.scanNonce || '').trim()}:${tableToken}`
  return `table:${String(value.tableCode || '').trim().toUpperCase()}`
}

function createTableRequestGuard(readCurrentScope) {
  let generation = 0
  let active = null

  function begin(scope) {
    active = { scope: String(scope || ''), generation: generation + 1 }
    generation = active.generation
    return active
  }

  function current() { return active }

  function rebase(request, nextScope) {
    const scope = String(nextScope || '')
    if (!request || active === null || active.generation !== request.generation || active.scope !== request.scope) return false
    active.scope = scope
    request.scope = scope
    return true
  }

  function isCurrent(request) {
    return Boolean(request && active
      && active.generation === request.generation
      && active.scope === request.scope
      && readCurrentScope() === request.scope)
  }

  function invalidate() {
    generation += 1
    active = null
  }

  return { begin, current, rebase, isCurrent, invalidate }
}

export { tableRequestScope, createTableRequestGuard }
