import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./read-queue.ps1', import.meta.url))

export async function readQueue(queue) {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-QueueName', queue,
    ], { windowsHide: true, timeout: 8000, maxBuffer: 192 * 1024 })
    const report = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
    if (report.queue !== queue || !Array.isArray(report.jobs)) throw new Error('invalid_queue_report')
    return report
  } catch {
    return { queue, checkedAt: new Date().toISOString(), readable: false, error: 'observer_unavailable',
      printerStatus: null, driver: null, port: null, count: null, truncated: false, jobs: [] }
  }
}

// The print worker never waits for the observer or retries a print to obtain diagnostics.
export function queueSampler() {
  let inFlight = false
  let latest
  return {
    latest: () => latest,
    refresh(queueNames) {
      if (inFlight) return
      inFlight = true
      Promise.all(queueNames.map(readQueue)).then(reports => { latest = reports })
        .finally(() => { inFlight = false })
    },
  }
}
