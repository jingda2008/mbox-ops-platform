import assert from 'node:assert/strict'
import test from 'node:test'
import { resetRuntimeMetricsWindow } from './reset-runtime-metrics-window.mjs'

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

test('retries a busy metrics window and resets every instance', async () => {
  const calls = []
  const delays = []
  const attempts = new Map()
  const results = await resetRuntimeMetricsWindow({
    baseUrls: ['http://instance-1', 'http://instance-2'],
    token: 'metrics-token',
    phase: 'kds_start',
    sleep: async (delay) => { delays.push(delay) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const attempt = (attempts.get(url) ?? 0) + 1
      attempts.set(url, attempt)
      if (url.includes('instance-1') && attempt === 1) {
        return response(409, { code: 'METRICS_RESET_BUSY' })
      }
      return response(200, { status: 'reset', instance: url })
    },
  })

  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [25])
  assert.equal(results.length, 2)
  assert.equal(calls[0].init.headers.authorization, 'Bearer metrics-token')
  assert.equal(calls[0].init.headers['x-mbox-test-phase'], 'kds_start')
})

test('does not retry non-busy failures', async () => {
  await assert.rejects(() => resetRuntimeMetricsWindow({
    baseUrls: ['http://instance-1'],
    token: 'metrics-token',
    phase: 'kds_complete',
    fetchImpl: async () => response(403, { code: 'METRICS_RESET_DISABLED' }),
  }), /setup_reset_metrics 403/)
})

test('fails closed when the metrics window never becomes idle', async () => {
  await assert.rejects(() => resetRuntimeMetricsWindow({
    baseUrls: ['http://instance-1'],
    token: 'metrics-token',
    phase: 'kds_complete',
    maxAttempts: 2,
    sleep: async () => undefined,
    fetchImpl: async () => response(409, { code: 'METRICS_RESET_BUSY' }),
  }), /remained busy after 2 attempts/)
})
