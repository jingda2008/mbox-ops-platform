// WinSW may die before its child. Keep one worker in the printing loop until the
// old one finishes its current cycle; the OS releases the pipe even on a crash.
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export async function runServiceWorker(run) {
  const parent = process.ppid
  const parentAlive = () => {
    try { process.kill(parent, 0); return true }
    catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const lock = createServer(socket => socket.destroy())
  while (parentAlive()) {
    try {
      lock.listen('\\\\.\\pipe\\MBoxPrintBridge-service-worker')
      await once(lock, 'listening')
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      await delay(1000)
    }
  }
  if (!lock.listening) return
  try { await run(parentAlive) }
  finally { await new Promise(resolve => lock.close(resolve)) }
}
