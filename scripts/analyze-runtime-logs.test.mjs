import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeRuntimeLog } from './analyze-runtime-logs.mjs'

function request(id, method, url, metadata = {}) {
  return JSON.stringify({ reqId: id, req: { method, url, ...metadata } })
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

test('isolated phase gates only its declared routes while keeping global reliability signals', () => {
  const lines = []
  for (let index = 0; index < 120; index += 1) {
    lines.push(request(`login-${index}`, 'POST', '/api/auth/pilot-login'))
    lines.push(response(`login-${index}`, 200, 40))
    lines.push(request(`bootstrap-${index}`, 'GET', '/api/bootstrap'))
    lines.push(response(`bootstrap-${index}`, 200, 35))
  }
  const report = analyzeRuntimeLog(lines.join('\n'), {
    requiredRoutes: ['POST /api/auth/pilot-login', 'GET /api/bootstrap'],
    minimumSloSamples: 120,
  })
  assert.equal(report.gate.passed, true)
  assert.deepEqual(report.gate.missingRoutes, [])
  assert.ok(report.routes.every((route) => route.required))
})

test('separates setup traffic from measured traffic without hiding setup failures', () => {
  const lines = []
  for (let index = 0; index < 20; index += 1) {
    lines.push(request(`setup-${index}`, 'POST', '/api/tasks/task-setup/actions', {
      testStage: 'setup', testPhase: 'task_action',
    }))
    lines.push(response(`setup-${index}`, index === 0 ? 500 : 200, 2_000))
    lines.push(request(`measured-${index}`, 'POST', '/api/tasks/task-measured/actions', {
      testStage: 'measured', testPhase: 'task_action',
    }))
    lines.push(response(`measured-${index}`, 200, 80))
  }
  const report = analyzeRuntimeLog(lines.join('\n'), {
    requiredRoutes: ['POST /api/tasks/:taskId/actions'],
    minimumSloSamples: 20,
    requiredTestStage: 'measured',
    requiredTestPhase: 'task_action',
  })
  assert.equal(report.routes[0].samples, 20)
  assert.equal(report.routes[0].p95Ms, 80)
  assert.equal(report.signals.fiveXx, 1)
  assert.equal(report.gate.passed, false)
})

test('rejects an unknown phase route instead of silently skipping it', () => {
  assert.throws(() => analyzeRuntimeLog('', { requiredRoutes: ['POST /api/not-real'] }), /未知日志门禁路由/)
})

test('rejects malformed log lines because missing evidence can hide failures', () => {
  const report = analyzeRuntimeLog('{not-json}\n', { requiredRoutes: [] })
  assert.equal(report.signals.invalidJsonLines, 1)
  assert.equal(report.gate.passed, false)
})

test('permits empty input only when no route evidence is required', () => {
  const report = analyzeRuntimeLog('', { requiredRoutes: [] })
  assert.equal(report.signals.invalidJsonLines, 0)
  assert.equal(report.gate.passed, true)
})
