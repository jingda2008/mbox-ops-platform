import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const runtimeSloTargets = new Map([
  ['POST /api/auth/pilot-login', { p95: 300, p99: 500, minimumSamples: 120 }],
  ['GET /api/bootstrap', { p95: 500, p99: 800, minimumSamples: 300 }],
  ['GET /api/reservations', { p95: 500, p99: 800, minimumSamples: 300 }],
  ['POST /api/auth/presence/heartbeat', { p95: 150, p99: 300, minimumSamples: 300 }],
  ['POST /api/guest/session', { p95: 500, p99: 800, minimumSamples: 300 }],
  ['POST /api/tasks', { p95: 800, p99: 1_500, minimumSamples: 300 }],
  ['POST /api/commerce/quick-orders', { p95: 1_500, p99: 2_500, minimumSamples: 300 }],
  ['POST /api/tasks/:taskId/actions', { p95: 800, p99: 1_500, minimumSamples: 300 }],
  ['POST /api/commerce/kds/:taskId/actions', { p95: 800, p99: 1_500, minimumSamples: 300 }],
])

function normalizedPath(rawUrl) {
  const path = String(rawUrl ?? '/unknown').split('?', 1)[0]
  return path
    .replace(/^\/api\/commerce\/kds\/[^/]+\/actions$/, '/api/commerce/kds/:taskId/actions')
    .replace(/^\/api\/tasks\/[^/]+\/actions$/, '/api/tasks/:taskId/actions')
    .replace(/^\/api\/tables\/[^/]+\/session-summary$/, '/api/tables/:tableId/session-summary')
    .replace(/^\/api\/business-days\/[^/]+\//, '/api/business-days/:businessDate/')
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function rounded(value) {
  return value == null ? null : Number(value.toFixed(1))
}

export function analyzeRuntimeLog(text, { minimumSloSamples, requiredRoutes, requiredTestStage, requiredTestPhase } = {}) {
  const requiredRouteSet = new Set(requiredRoutes ?? runtimeSloTargets.keys())
  for (const route of requiredRouteSet) {
    if (!runtimeSloTargets.has(route)) throw new Error(`未知日志门禁路由 ${route}`)
  }
  const requests = new Map()
  const routes = new Map()
  const signals = {
    fiveXx: 0,
    poolTimeouts: 0,
    projectionFallbacks: 0,
    dnsErrors: 0,
    prematureCloses: 0,
    invalidJsonLines: 0,
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      signals.invalidJsonLines += 1
      continue
    }
    if (entry.reqId && entry.req?.url) {
      requests.set(entry.reqId, {
        method: String(entry.req.method ?? '?').toUpperCase(),
        path: normalizedPath(entry.req.url),
        testStage: entry.req.testStage,
        testPhase: entry.req.testPhase,
      })
    }
    if (entry.reqId && entry.res && Number.isFinite(entry.responseTime)) {
      const request = requests.get(entry.reqId) ?? { method: '?', path: '/unknown' }
      if (entry.res.statusCode >= 500) signals.fiveXx += 1
      const selected = (!requiredTestStage || request.testStage === requiredTestStage)
        && (!requiredTestPhase || request.testPhase === requiredTestPhase)
      if (selected) {
        const key = `${request.method} ${request.path}`
        const samples = routes.get(key) ?? []
        samples.push({ durationMs: Number(entry.responseTime), statusCode: Number(entry.res.statusCode) })
        routes.set(key, samples)
      }
    }
    const code = entry.error?.code ?? entry.err?.code ?? ''
    const message = `${entry.msg ?? ''} ${entry.error?.message ?? ''} ${entry.err?.message ?? ''}`
    if (message.includes('timeout exceeded when trying to connect')) signals.poolTimeouts += 1
    if (message.includes('served fresh aggregate fallback')) signals.projectionFallbacks += 1
    if (code === 'EAI_AGAIN') signals.dnsErrors += 1
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || /premature close/i.test(message)) signals.prematureCloses += 1
  }

  const routeMetrics = [...routes.entries()].map(([route, samples]) => {
    const successful = samples.filter((sample) => sample.statusCode >= 200 && sample.statusCode < 400)
    const durations = successful.map((sample) => sample.durationMs).sort((left, right) => left - right)
    const statuses = Object.fromEntries([...new Set(samples.map((sample) => sample.statusCode))]
      .sort((left, right) => left - right)
      .map((status) => [status, samples.filter((sample) => sample.statusCode === status).length]))
    const target = runtimeSloTargets.get(route)
    const p95 = percentile(durations, 0.95)
    const p99 = percentile(durations, 0.99)
    const required = requiredRouteSet.has(route)
    const requiredSamples = required ? (minimumSloSamples ?? target?.minimumSamples ?? 0) : 0
    const clientErrorSamples = samples.filter((sample) => sample.statusCode >= 400 && sample.statusCode < 500).length
    const clientErrorRate = samples.length === 0 ? 0 : clientErrorSamples / samples.length
    const sloStatus = !target || !required
      ? 'not_gated'
      : successful.length < requiredSamples
        ? 'insufficient_sample'
        : clientErrorRate > 0.01
          ? 'fail'
          : p95 <= target.p95 && p99 <= target.p99
          ? 'pass'
          : 'fail'
    return {
      route,
      samples: samples.length,
      successfulSamples: successful.length,
      p50Ms: rounded(percentile(durations, 0.5)),
      p95Ms: rounded(p95),
      p99Ms: rounded(p99),
      maxMs: rounded(durations.at(-1) ?? null),
      statuses,
      target: target ?? null,
      required,
      requiredSamples,
      clientErrorSamples,
      clientErrorRate: rounded(clientErrorRate),
      sloStatus,
    }
  }).sort((left, right) => right.samples - left.samples || left.route.localeCompare(right.route))

  const insufficientRoutes = routeMetrics
    .filter((metric) => metric.required && metric.sloStatus === 'insufficient_sample')
    .map((metric) => metric.route)
  const failedRoutes = routeMetrics.filter((metric) => metric.required && metric.sloStatus === 'fail').map((metric) => metric.route)
  const measuredRoutes = new Set(routeMetrics.map((metric) => metric.route))
  const missingRoutes = [...requiredRouteSet].filter((route) => !measuredRoutes.has(route))

  return {
    selection: {
      testStage: requiredTestStage ?? null,
      testPhase: requiredTestPhase ?? null,
      requiredRoutes: [...requiredRouteSet],
      minimumSloSamples: minimumSloSamples ?? null,
    },
    signals,
    routes: routeMetrics,
    gate: {
      passed: signals.fiveXx === 0 && signals.poolTimeouts === 0 && signals.projectionFallbacks === 0
        && signals.dnsErrors === 0 && signals.prematureCloses === 0 && signals.invalidJsonLines === 0
        && insufficientRoutes.length === 0 && failedRoutes.length === 0 && missingRoutes.length === 0,
      insufficientRoutes,
      failedRoutes,
      missingRoutes,
    },
  }
}

function options(name) {
  return process.argv.flatMap((value, index) => (
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []
  ))
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const inputs = options('--input')
  if (!inputs.length) throw new Error('Usage: node scripts/analyze-runtime-logs.mjs --input <pino-log-file> [--input <pino-log-file>] [--fail-on-slo]')
  const requiredRoutes = options('--required-route')
  const minimumSampleValues = options('--minimum-slo-samples')
  const requiredTestStageValues = options('--test-stage')
  const requiredTestPhaseValues = options('--test-phase')
  const minimumSloSamples = minimumSampleValues.length ? Number(minimumSampleValues.at(-1)) : undefined
  if (minimumSloSamples !== undefined && (!Number.isSafeInteger(minimumSloSamples) || minimumSloSamples < 1)) {
    throw new Error('--minimum-slo-samples必须是正整数')
  }
  const report = analyzeRuntimeLog(inputs.map((input) => readFileSync(resolve(input), 'utf8')).join('\n'), {
    requiredRoutes: requiredRoutes.length ? requiredRoutes : undefined,
    minimumSloSamples,
    requiredTestStage: requiredTestStageValues.at(-1),
    requiredTestPhase: requiredTestPhaseValues.at(-1),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes('--fail-on-slo') && !report.gate.passed) process.exitCode = 1
}
