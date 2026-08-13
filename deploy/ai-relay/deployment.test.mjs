import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import test from 'node:test'

const source = (name) => readFile(new URL(name, import.meta.url), 'utf8')

test('AI relay image has a bounded loopback healthcheck', async () => {
  const dockerfile = await source('./Dockerfile')
  assert.match(dockerfile, /HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3/)
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:.*\/health/)
  assert.match(dockerfile, /AbortSignal\.timeout\(2000\)/)
  assert.doesNotMatch(dockerfile, /MBOX_(?:RELAY_TOKEN|GEMINI_API_KEY)/)
})

test('AI relay health endpoint answers locally without calling the upstream model', async () => {
  const port = await availablePort()
  const child = spawn(process.execPath, [new URL('./index.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(port),
      MBOX_RELAY_TOKEN: 'test-relay-token-0123456789abcdef',
      MBOX_GEMINI_API_KEY: 'test-model-key-0123456789',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const response = await waitForHealth(`http://127.0.0.1:${port}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  }
  assert.equal(stderr, '')
})

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  return port
}

async function waitForHealth(url) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(250) })
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
  throw new Error('AI relay health endpoint did not become ready')
}
