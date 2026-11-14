import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, open, rename, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WINDOW_MS = 600000
export const STALL_MS = 120000
export const MAX_RECOVERIES = 2
const execFileAsync = promisify(execFile)
const directory = dirname(fileURLToPath(import.meta.url))
const defaultData = process.env.MBOX_PRINT_BRIDGE_DATA || join(process.env.ProgramData || 'C:\\ProgramData', 'MBOX', 'PrintBridge')

export function validateBudget(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.recoveries) || value.recoveries.length > MAX_RECOVERIES || !value.recoveries.every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(value.lastNow) || value.lastNow < 0 || typeof value.halted !== 'boolean') throw new Error('supervisor_budget_invalid')
  return value
}
export function reserveRecovery(value, now) {
  validateBudget(value)
  if (!Number.isSafeInteger(now) || now < value.lastNow || value.recoveries.some(n => n > now)) return { ...value, halted: true, reason: 'supervisor_clock_regressed' }
  if (value.halted) return { ...value, reason: 'supervisor_recovery_halted' }
  const recoveries = value.recoveries.filter(n => now - n < WINDOW_MS)
  if (recoveries.length >= MAX_RECOVERIES) return { ...value, lastNow: now, halted: true, reason: 'recovery_exhausted' }
  return { version: 1, recoveries: [...recoveries, now], lastNow: now, halted: false }
}
export function observeProgress(state, raw, now) {
  if (!Number.isSafeInteger(now) || now < state.lastNow) return { ...state, halt: true }
  const stamp = typeof raw?.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN
  const advances = Number.isFinite(stamp) && stamp >= state.startedAt && stamp <= now && stamp > state.lastStamp
  return { ...state, lastNow: now, lastStamp: advances ? stamp : state.lastStamp, lastProgressAt: advances ? stamp : state.lastProgressAt, stalled: now - (advances ? stamp : state.lastProgressAt) >= STALL_MS }
}
async function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }

export async function runSupervisor({ data = defaultData, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), start = () => spawn(process.execPath, [join(directory, 'bridge.mjs'), 'run'], { windowsHide: true, stdio: 'inherit' }), terminate = terminateTree, stopRequested = () => false } = {}) {
  await mkdir(data, { recursive: true })
  const lock = join(data, 'supervisor.lock')
  // Never guess a stale lock is safe: another bridge could still be printing.
  await mkdir(lock)
  let child = null
  const budgetPath = join(data, 'supervisor-budget.json')
  const statusPath = join(data, 'supervisor-status.json')
  const status = (kind, reason) => atomic(statusPath, { version: 1, kind, reason, updatedAt: new Date(now()).toISOString() })
  let budget
  let safeToUnlock = true
  try {
    try { budget = validateBudget(await readJson(budgetPath)) } catch (error) {
      if (error.code !== 'ENOENT') { await status('recovery_exhausted', 'supervisor_budget_invalid'); return }
      budget = { version: 1, recoveries: [], lastNow: now(), halted: false }
      await atomic(budgetPath, budget)
    }
    if (budget.halted || now() < budget.lastNow) { await status('recovery_exhausted', 'supervisor_recovery_halted'); return }
    // A supervisor restart while its old child may survive must not silently spawn a duplicate.
    let previous
    try { previous = await readJson(statusPath) } catch (error) { if (error.code !== 'ENOENT') { await status('recovery_exhausted', 'supervisor_status_invalid'); return } }
    if (previous?.kind === 'running' || previous?.kind === 'bridge_recovery' || previous?.kind === 'recovery_exhausted') { await status('recovery_exhausted', 'supervisor_unclean_shutdown'); return }
    while (!stopRequested()) {
      const startedAt = now()
      budget.lastNow = startedAt
      await atomic(budgetPath, budget)
      await status(budget.recoveries.length ? 'bridge_recovery' : 'running', 'supervisor_child_starting')
      let exited = false
      child = start()
      child.once('exit', () => { exited = true })
      child.once('error', () => { exited = true })
      let progress = { startedAt, lastStamp: startedAt - 1, lastProgressAt: startedAt, lastNow: startedAt }
      while (!exited && !stopRequested()) {
        await sleep(5000)
        let raw
        try { raw = await readJson(join(data, 'progress.json')) } catch { /* Missing/corrupt progress never counts as health. */ }
        progress = observeProgress(progress, raw, now())
        if (progress.stalled || progress.halt) break
      }
      if (!exited) {
        if (!await terminate(child)) { safeToUnlock = false; await status('recovery_exhausted', 'supervisor_termination_unconfirmed'); return }
      }
      child = null
      // An exited Node process may have left a PowerShell descendant behind.
      // A durable in-flight marker is therefore not permission to launch another worker.
      if (exited) {
        let journal
        try { journal = await readJson(join(data, 'journal.json')) } catch (error) {
          if (error.code !== 'ENOENT') { await status('recovery_exhausted', 'supervisor_journal_invalid'); return }
        }
        if (journal && (!journal.entries || typeof journal.entries !== 'object' || Array.isArray(journal.entries))) { await status('recovery_exhausted', 'supervisor_journal_invalid'); return }
        if (Object.values(journal?.entries || {}).some(entry => entry?.state === 'printing')) { await status('recovery_exhausted', 'supervisor_inflight_exit'); return }
      }
      if (stopRequested()) { await status('stopped', 'supervisor_stopped'); return }
      budget = reserveRecovery(budget, now())
      if (progress.halt) budget = { ...budget, halted: true, reason: 'supervisor_clock_regressed' }
      await atomic(budgetPath, budget)
      if (budget.halted) { await status('recovery_exhausted', budget.reason); return }
      await status('bridge_recovery', 'supervisor_restart_reserved')
      await sleep(budget.recoveries.length === 1 ? 10000 : 30000)
    }
    await status('stopped', 'supervisor_stopped')
  } finally {
    if (child) { try { safeToUnlock = await terminate(child) } catch { safeToUnlock = false } }
    if (safeToUnlock) await rmdir(lock)
  }
}
async function terminateTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false
  let closed = false
  child.once('close', () => { closed = true })
  try {
    if (process.platform === 'win32') await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 })
    else child.kill('SIGTERM')
  } catch { return false }
  const limit = Date.now() + 15000
  while (!closed && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 100))
  return closed
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stopping = false
  process.on('SIGTERM', () => { stopping = true })
  process.on('SIGINT', () => { stopping = true })
  if (process.platform !== 'win32') process.stderr.write('supervisor_windows_required\n')
  else try { await runSupervisor({ stopRequested: () => stopping }) } catch { process.stderr.write('supervisor_unavailable\n') }
  // Deliberately exit 0 on a latched failure; do not trigger WinSW crash restart loops.
}
