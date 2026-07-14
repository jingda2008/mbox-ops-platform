import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'

interface ObservabilityOptions {
  runtimeMode: RuntimeMode
  metricsToken?: string
  readiness: () => Promise<{ ready: boolean; details?: Record<string, string | number | boolean> }>
}

interface MetricState {
  startedAt: number
  requests: number
  errors: number
  inFlight: number
  durationMsTotal: number
}

function authenticateMetrics(request: FastifyRequest, reply: FastifyReply, options: ObservabilityOptions) {
  if (options.runtimeMode === 'local' || options.runtimeMode === 'test') return true
  const supplied = request.headers.authorization
  if (supplied === `Bearer ${options.metricsToken}`) return true
  void reply.status(401).send({ code: 'METRICS_AUTHENTICATION_REQUIRED', message: '缺少有效监控凭证' })
  return false
}

function renderPrometheus(metrics: MetricState) {
  const uptimeSeconds = Math.max(0, (Date.now() - metrics.startedAt) / 1000)
  return [
    '# HELP mbox_api_uptime_seconds API process uptime.',
    '# TYPE mbox_api_uptime_seconds gauge',
    `mbox_api_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
    '# HELP mbox_api_requests_total Completed API requests.',
    '# TYPE mbox_api_requests_total counter',
    `mbox_api_requests_total ${metrics.requests}`,
    '# HELP mbox_api_errors_total Completed 5xx API requests.',
    '# TYPE mbox_api_errors_total counter',
    `mbox_api_errors_total ${metrics.errors}`,
    '# HELP mbox_api_in_flight_requests Current requests.',
    '# TYPE mbox_api_in_flight_requests gauge',
    `mbox_api_in_flight_requests ${metrics.inFlight}`,
    '# HELP mbox_api_request_duration_ms_total Cumulative request duration.',
    '# TYPE mbox_api_request_duration_ms_total counter',
    `mbox_api_request_duration_ms_total ${metrics.durationMsTotal.toFixed(3)}`,
    '',
  ].join('\n')
}

export async function registerObservability(app: FastifyInstance, options: ObservabilityOptions) {
  const metrics: MetricState = { startedAt: Date.now(), requests: 0, errors: 0, inFlight: 0, durationMsTotal: 0 }

  app.addHook('onRequest', async (request) => {
    metrics.inFlight += 1
    request.startTime = performance.now()
  })
  app.addHook('onResponse', async (request, reply) => {
    metrics.inFlight = Math.max(0, metrics.inFlight - 1)
    metrics.requests += 1
    if (reply.statusCode >= 500) metrics.errors += 1
    metrics.durationMsTotal += Math.max(0, performance.now() - request.startTime)
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff')
    void reply.header('x-frame-options', 'DENY')
    void reply.header('referrer-policy', 'no-referrer')
    void reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    void reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    if (options.runtimeMode === 'production') {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }
    void reply.header('cache-control', 'no-store')
    return payload
  })

  app.get('/api/live', async () => ({ status: 'ok', time: new Date().toISOString() }))
  app.get('/api/ready', async (_request, reply) => {
    const readiness = await options.readiness()
    return reply.status(readiness.ready ? 200 : 503).send({
      status: readiness.ready ? 'ready' : 'not_ready',
      time: new Date().toISOString(),
      ...readiness.details,
    })
  })
  app.get('/api/metrics', async (request, reply) => {
    if (!authenticateMetrics(request, reply, options)) return reply
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheus(metrics))
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime: number
  }
}
