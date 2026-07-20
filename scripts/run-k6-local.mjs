import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const apiPort = 18_788
const webPort = 15_174
const statePath = resolve('.runtime/load-state.json')
const children = []

function start(command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'inherit' })
  children.push(child)
  return child
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

await rm(statePath, { force: true })
process.on('SIGINT', () => { stopChildren(); process.exit(130) })
process.on('SIGTERM', () => { stopChildren(); process.exit(143) })

try {
  start('node', ['--import', 'tsx', 'server/index.ts'], {
    API_PORT: String(apiPort),
    MBOX_RUNTIME_MODE: 'test',
    MBOX_REPOSITORY: 'json',
    MBOX_JSON_STATE_PATH: statePath,
    MBOX_LOG_LEVEL: 'warn',
  })
  start('npx', ['vite', '--host', '127.0.0.1', '--port', String(webPort)], {
    API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    VITE_MBOX_LOCAL_ACTOR_ID: 'emp-chen',
  })
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`),
    waitFor(`http://127.0.0.1:${webPort}/guest?table=L01`),
  ])

  const k6 = spawn('k6', [
    'run',
    '-e', `BASE_URL=http://127.0.0.1:${webPort}`,
    '-e', 'LOCAL_MODE=true',
    '-e', `GUESTS=${process.env.MBOX_LOAD_GUESTS || '300'}`,
    '-e', `VUS=${process.env.MBOX_LOAD_VUS || '60'}`,
    'tests/load/night-300.k6.js',
  ], { stdio: 'inherit' })
  const exitCode = await new Promise((resolveExit) => k6.on('exit', resolveExit))
  if (exitCode !== 0) process.exitCode = typeof exitCode === 'number' ? exitCode : 1
} finally {
  stopChildren()
}
