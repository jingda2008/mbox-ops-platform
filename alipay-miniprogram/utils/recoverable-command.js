const runtime = require('./platform')
const { randomId } = require('./id')
const { getTableSession } = require('./session')

const attempts = new Map()
const flights = new Map()

// A lookup checksum, NOT an authentication/security hash. Server command
// fingerprints still reject collisions or changed bodies; this never grants access.
function checksum(text) {
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ text.charCodeAt(i)
  }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}

function recoverableGuestCommand(operation, body, send) {
  const session = getTableSession()
  // cartScope is an opaque, non-authorizing table-session identifier. Never
  // persist QR credentials, cookies, customer text or an authorization token here.
  const principal = runtime.getStorageSync('mbox.alipay.identity.principal.v1') || {}
  const scope = JSON.stringify([session.cartScope || session.scanNonce || 'unbound', principal.principalId || principal.memberId || 'guest'])
  const storageKey = `mbox.command.v1:${checksum(scope)}:${checksum(operation + JSON.stringify(body))}`
  if (flights.has(storageKey)) return flights.get(storageKey)
  let key = attempts.get(storageKey)
  try { key = key || runtime.getStorageSync(storageKey) } catch (_error) { /* Same-runtime retry remains available. */ }
  if (typeof key !== 'string' || !key) key = randomId('guest-command')
  attempts.set(storageKey, key)
  try { runtime.setStorageSync(storageKey, key) } catch (_error) { /* No business body is stored. */ }
  const clear = () => {
    attempts.delete(storageKey)
    try { runtime.removeStorageSync(storageKey) } catch (_error) { /* Harmless stale key replays safely. */ }
  }
  const promise = Promise.resolve().then(() => send(key)).then((result) => { clear(); return result }, (error) => {
    const status = Number(error && (error.statusCode || error.status))
    if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) clear()
    throw error
  }).finally(() => flights.delete(storageKey))
  flights.set(storageKey, promise)
  return promise
}

export { recoverableGuestCommand }
