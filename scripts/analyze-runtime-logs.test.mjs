import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeRuntimeLog } from './analyze-runtime-logs.mjs'

function request(id, method, url) {
  return JSON.stringify({ reqId: id, req: { method, url } })
}

function response(id, statusCode, responseTime) {
  return JSON.stringify({ reqId: id, res: { statusCode }, responseTime })
}

test('normalizes entity ids and fails a measured route above its SLO', () => {
  const lines = []
  for (let index = 0; index < 20; index += 1) {
    lines.push(request(`r${index}`, 'POST', `/api/tasks/task-${index}/actions`))
    lines.push(response(`r${index}`, 200, index === 19 ? 2_000 : 900))
  }
  const report = analyzeRuntimeLog(lines.join('\n'), { minimumSloSamples: 20 })
  const route = report.routes.find((entry) => entry.route === 'POST /api/tasks/:taskId/actions')
  assert.equal(route.samples, 20)
  assert.equal(route.sloStatus, 'fail')
  assert.deepEqual(report.gate.failedRoutes, ['POST /api/tasks/:taskId/actions'])
  assert.ok(report.gate.missingRoutes.includes('POST /api/auth/presence/heartbeat'))
})

test('keeps low samples inconclusive and counts reliability signals', () => {
  const report = analyzeRuntimeLog([
    request('a', 'GET', '/api/bootstrap'),
    response('a', 200, 120),
    request('b', 'GET', '/api/bootstrap'),
    response('b', 503, 80),
    JSON.stringify({ level: 50, msg: 'timeout exceeded when trying to connect' }),
    JSON.stringify({ level: 40, msg: 'operational read revision kept advancing; served fresh aggregate fallback' }),
    JSON.stringify({ level: 50, error: { code: 'EAI_AGAIN' }, msg: 'presence lease sweep failed' }),
  ].join('\n'))

  assert.equal(report.routes[0].sloStatus, 'insufficient_sample')
  assert.deepEqual(report.signals, {
    fiveXx: 1, poolTimeouts: 1, projectionFallbacks: 1, dnsErrors: 1, prematureCloses: 0, invalidJsonLines: 0,
  })
  assert.equal(report.gate.passed, false)
})
