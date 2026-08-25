function tableRequestScope(session) {
  const value = session && typeof session === 'object' ? session : {}
  // This value stays in memory only. Persistent cache keys use the hashed
  // scope from session.js, so a scanned credential is never written as a key.
  return `${String(value.tableToken || '')}:${String(value.tableCode || '').trim().toUpperCase()}`
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

  return { begin, current, isCurrent, invalidate }
}

module.exports = { tableRequestScope, createTableRequestGuard }
