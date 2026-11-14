import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'

const kinds = new Set(['bridge_started','bridge_recovery','submission_started','spool_accepted','submission_failed','print_ambiguous','queue_unavailable','recovery_exhausted','diagnostic_gap'])
const failures = new Set(['powershell_not_found','invalid_ticket_snapshot','printer_queue_not_found','printer_unavailable','printer_spooler_failed','printer_access_denied','bridge_print_timeout','bridge_print_failed','ambiguous_previous_attempt','ambiguous_print_result'])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
export function cleanEvent(input) {
  if (!input || !kinds.has(input.kind) || !uuid.test(input.eventId) || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error('invalid_diagnostic_event')
  const event = { eventId: input.eventId, occurredAt: new Date(input.occurredAt).toISOString(), kind: input.kind }
  if (input.jobId !== undefined) { if (!uuid.test(input.jobId)) throw new Error('invalid_diagnostic_job'); event.jobId = input.jobId }
  if (input.failureCode !== undefined) { if (!failures.has(input.failureCode)) throw new Error('invalid_diagnostic_failure'); event.failureCode = input.failureCode }
  if (input.durationMs !== undefined) { if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 86400000) throw new Error('invalid_diagnostic_duration'); event.durationMs = input.durationMs }
  if (input.gapCount !== undefined) { if (input.kind !== 'diagnostic_gap' || !Number.isSafeInteger(input.gapCount) || input.gapCount < 1 || input.gapCount > 1000000) throw new Error('invalid_diagnostic_gap'); event.gapCount = input.gapCount }
  return event
}
export async function atomicState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`
  const file = await open(temporary, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}
export function createDiagnosticQueue(path, { maxEvents = 2000, now = () => new Date(), retentionMs = 7 * 86400000 } = {}) {
  let serial = Promise.resolve()
  const exclusive = action => { const result = serial.then(action); serial = result.catch(() => {}); return result }
  async function read() {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'))
      if (raw.version !== 1 || !Array.isArray(raw.events)) throw new Error('diagnostic_cache_invalid')
      return { version: 1, dropped: Number.isSafeInteger(raw.dropped) ? raw.dropped : 0, events: raw.events.map(cleanEvent) }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, dropped: 0, events: [] }
      if (error instanceof SyntaxError || ['diagnostic_cache_invalid','invalid_diagnostic_event','invalid_diagnostic_job','invalid_diagnostic_failure','invalid_diagnostic_duration','invalid_diagnostic_gap'].includes(error.message)) {
        // Preserve one local corrupt artifact, never upload raw bytes or reset the print journal.
        await unlink(`${path}.corrupt`).catch(e => { if (e.code !== 'ENOENT') throw e })
        await rename(path, `${path}.corrupt`)
        const recovered = { version: 1, dropped: 1, events: [] }
        await atomicState(path, recovered)
        return recovered
      }
      throw error
    }
  }
  return {
    append: input => exclusive(async () => {
      const state = await read()
      const event = cleanEvent({ ...input, eventId: randomUUID(), occurredAt: now().toISOString() })
      const fresh = state.events.filter(item => Date.parse(item.occurredAt) >= now().getTime() - retentionMs)
      state.dropped += state.events.length - fresh.length
      fresh.push(event)
      state.dropped += Math.max(0, fresh.length - maxEvents)
      state.events = fresh.slice(-maxEvents)
      await atomicState(path, state)
      return event
    }),
    // A lost response leaves the batch intact; the server must deduplicate event IDs.
    flush: send => exclusive(async () => {
      const state = await read()
      const fresh = state.events.filter(item => Date.parse(item.occurredAt) >= now().getTime() - retentionMs)
      state.dropped += state.events.length - fresh.length
      state.events = fresh
      if (state.dropped > 0) {
        if (state.events.length >= maxEvents) { state.events.shift(); state.dropped++ }
        state.events.push(cleanEvent({eventId:randomUUID(),occurredAt:now().toISOString(),kind:'diagnostic_gap',gapCount:Math.min(1000000, state.dropped)}))
        state.dropped = 0
        await atomicState(path, state)
      }
      const batch = state.events.slice(0, 50)
      if (!batch.length) return
      const response = await send(batch)
      if (!Array.isArray(response?.acceptedEventIds)) throw new Error('diagnostic_ack_invalid')
      const sent = new Set(batch.map(event => event.eventId))
      const accepted = new Set(response.acceptedEventIds.filter(id => sent.has(id)))
      state.events = state.events.filter(event => !accepted.has(event.eventId))
      await atomicState(path, state)
    }),
  }
}
