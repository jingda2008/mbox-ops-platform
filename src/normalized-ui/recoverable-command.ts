type Attempt = { fingerprint: string; key: string }
const memory = new Map<string, Attempt>()
const flights = new Map<string, Promise<unknown>>()

/** Only for retrying the SAME business command, never for a new payment attempt. */
export async function executeRecoverableCommand<T>(
  namespace: string, body: unknown, proposedKey: string, send: (key: string) => Promise<T>,
): Promise<T> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))
  const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  const storageKey = `mbox.command-attempt.v1:${namespace}:${fingerprint}`
  let attempt = memory.get(storageKey)
  try {
    const stored = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(storageKey)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (parsed && typeof parsed === 'object' && 'fingerprint' in parsed && parsed.fingerprint === fingerprint
        && 'key' in parsed && typeof parsed.key === 'string') attempt = { fingerprint, key: parsed.key }
    }
  } catch { /* In-memory protection remains available when storage is restricted. */ }
  if (!attempt) attempt = { fingerprint, key: proposedKey }
  memory.set(storageKey, attempt)
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey, JSON.stringify(attempt)) } catch { /* Same-tab retry remains protected. */ }
  const running = flights.get(storageKey)
  if (running) return running as Promise<T>
  const clear = () => {
    memory.delete(storageKey)
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(storageKey) } catch { /* No sensitive body is stored. */ }
  }
  const execution = send(attempt.key).then((result) => { clear(); return result }).catch((error: unknown) => {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null
    if (typeof status === 'number' && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) clear()
    throw error
  }).finally(() => { flights.delete(storageKey) })
  flights.set(storageKey, execution)
  return execution
}
