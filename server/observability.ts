import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'

interface ObservabilityOptions {
  runtimeMode: RuntimeMode
  metricsToken?: string
  readiness: () => Promise<{ ready: boolean; details?: Record<string, string | number | boolean> }>
  resetRuntimeMetrics?: () => void | Promise<void>
}

interface MetricState {
  startedAt: number
  requests: number
  errors: number
  inFlight: number
  durationMsTotal: number
  routes: Map<string, RouteMetricState>
  eventLoopDelay: IntervalHistogram
}

interface RouteMetricState {
  method: string
  route: string
  statusClass: string
  count: number
  durationMsTotal: number
  bucketCounts: number[]
}

const ROUTE_DURATION_BUCKETS_MS = [25, 50, 100, 150, 250, 300, 500, 800, 1_000, 1_500, 2_500, 5_000] as const
const READINESS_CACHE_TTL_MS = 1_000

const HASHED_ASSET_PATH = /^\/assets\/.*-(?=[A-Za-z0-9_-]{8,}\.[^.]+$)(?=[A-Za-z0-9_-]*[A-Z0-9_])[A-Za-z0-9_-]{8,}\.[^.]+$/
const UPDATEABLE_MEDIA_PATH = /^\/(?:menu|brand|icons)(?:\/|$)/

function defaultCacheControl(request: FastifyRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'no-store'

  const pathname = request.url.split('?', 1)[0] ?? '/'
  if (/^\/api(?:\/|$)/.test(pathname)) return 'no-store'
  if (pathname === '/' || pathname.endsWith('.html') || pathname === '/sw.js') {
    return 'no-cache'
  }
  if (HASHED_ASSET_PATH.test(pathname)) {
    return 'public, max-age=31536000, immutable'
  }
  if (UPDATEABLE_MEDIA_PATH.test(pathname) || pathname.startsWith('/assets/')) {
    return 'public, max-age=3600, stale-while-revalidate=86400'
  }
  if (pathname === '/manifest.webmanifest' || pathname === '/favicon.svg') {
    return 'public, max-age=300, stale-while-revalidate=3600'
  }
  return 'no-store'
}

function authenticateMetrics(request: FastifyRequest, reply: FastifyReply, options: ObservabilityOptions) {
  if (options.runtimeMode === 'local' || options.runtimeMode === 'test') return true
  const supplied = request.headers.authorization
  if (supplied === `Bearer ${options.metricsToken}`) return true
  void reply.status(401).send({ code: 'METRICS_AUTHENTICATION_REQUIRED', message: '缺少有效监控凭证' })
  return false
}

function metricLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function statusClass(statusCode: number) {
  return statusCode >= 100 && statusCode < 600 ? `${Math.floor(statusCode / 100)}xx` : 'unknown'
}

function normalizedRoute(request: FastifyRequest) {
  const configured = request.routeOptions?.url
  if (configured && configured !== '*') return configured
  const pathname = request.url.split('?', 1)[0] ?? '/unknown'
  if (pathname.startsWith('/api/')) return '/api/unmatched'
  return '/static'
}

function recordRouteMetric(metrics: MetricState, request: FastifyRequest, statusCode: number, durationMs: number) {
  const method = request.method.toUpperCase()
  const route = normalizedRoute(request)
  const responseClass = statusClass(statusCode)
  const key = `${method}\u0000${route}\u0000${responseClass}`
  let metric = metrics.routes.get(key)
  if (!metric) {
    metric = {
      method,
      route,
      statusClass: responseClass,
      count: 0,
      durationMsTotal: 0,
      bucketCounts: ROUTE_DURATION_BUCKETS_MS.map(() => 0),
    }
    metrics.routes.set(key, metric)
  }
  metric.count += 1
  metric.durationMsTotal += durationMs
  ROUTE_DURATION_BUCKETS_MS.forEach((threshold, index) => {
    if (durationMs <= threshold) metric!.bucketCounts[index] = (metric!.bucketCounts[index] ?? 0) + 1
  })
}

function eventLoopMilliseconds(value: number) {
  return Number.isFinite(value) ? value / 1_000_000 : 0
}

function readinessNumber(details: Record<string, string | number | boolean> | undefined, key: string) {
  const value = details?.[key]
  if (typeof value === 'boolean') return value ? 1 : 0
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function renderPrometheus(metrics: MetricState, readinessDetails?: Record<string, string | number | boolean>) {
  const uptimeSeconds = Math.max(0, (Date.now() - metrics.startedAt) / 1000)
  const output = [
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
    '# HELP mbox_node_event_loop_delay_ms Node.js event loop delay percentiles.',
    '# TYPE mbox_node_event_loop_delay_ms gauge',
    `mbox_node_event_loop_delay_ms{quantile="0.50"} ${eventLoopMilliseconds(metrics.eventLoopDelay.percentile(50)).toFixed(3)}`,
    `mbox_node_event_loop_delay_ms{quantile="0.95"} ${eventLoopMilliseconds(metrics.eventLoopDelay.percentile(95)).toFixed(3)}`,
    `mbox_node_event_loop_delay_ms{quantile="0.99"} ${eventLoopMilliseconds(metrics.eventLoopDelay.percentile(99)).toFixed(3)}`,
    '# HELP mbox_database_latency_ms Database health-check latency.',
    '# TYPE mbox_database_latency_ms gauge',
    `mbox_database_latency_ms ${readinessNumber(readinessDetails, 'databaseLatencyMs')}`,
    '# HELP mbox_database_clock_skew_ms Absolute application to PostgreSQL clock skew.',
    '# TYPE mbox_database_clock_skew_ms gauge',
    `mbox_database_clock_skew_ms ${readinessNumber(readinessDetails, 'databaseClockSkewMs')}`,
    '# HELP mbox_database_pool_connections PostgreSQL connection-pool counts.',
    '# TYPE mbox_database_pool_connections gauge',
    `mbox_database_pool_connections{state="total"} ${readinessNumber(readinessDetails, 'databasePoolTotal')}`,
    `mbox_database_pool_connections{state="idle"} ${readinessNumber(readinessDetails, 'databasePoolIdle')}`,
    `mbox_database_pool_connections{state="waiting"} ${readinessNumber(readinessDetails, 'databasePoolWaiting')}`,
    '# HELP mbox_database_pool_acquisition_wait_ms Recent PostgreSQL pool acquisition wait percentiles.',
    '# TYPE mbox_database_pool_acquisition_wait_ms gauge',
    `mbox_database_pool_acquisition_wait_ms{quantile="0.50"} ${readinessNumber(readinessDetails, 'databasePoolAcquireP50Ms')}`,
    `mbox_database_pool_acquisition_wait_ms{quantile="0.95"} ${readinessNumber(readinessDetails, 'databasePoolAcquireP95Ms')}`,
    `mbox_database_pool_acquisition_wait_ms{quantile="0.99"} ${readinessNumber(readinessDetails, 'databasePoolAcquireP99Ms')}`,
    '# HELP mbox_database_pool_acquisitions_total PostgreSQL pool acquisition outcomes.',
    '# TYPE mbox_database_pool_acquisitions_total counter',
    `mbox_database_pool_acquisitions_total{outcome="success"} ${readinessNumber(readinessDetails, 'databasePoolAcquireCount')}`,
    `mbox_database_pool_acquisitions_total{outcome="failed"} ${readinessNumber(readinessDetails, 'databasePoolAcquireFailedTotal')}`,
    '# HELP mbox_mutation_queue_pending Pending aggregate mutations.',
    '# TYPE mbox_mutation_queue_pending gauge',
    `mbox_mutation_queue_pending ${readinessNumber(readinessDetails, 'mutationQueuePending')}`,
    '# HELP mbox_mutation_queue_high_watermark Maximum aggregate mutation queue depth since process start.',
    '# TYPE mbox_mutation_queue_high_watermark gauge',
    `mbox_mutation_queue_high_watermark ${readinessNumber(readinessDetails, 'mutationQueueHighWatermark')}`,
    '# HELP mbox_mutation_queue_capacity Aggregate mutation queue capacity.',
    '# TYPE mbox_mutation_queue_capacity gauge',
    `mbox_mutation_queue_capacity ${readinessNumber(readinessDetails, 'mutationQueueCapacity')}`,
    '# HELP mbox_mutation_queue_failures_total Aggregate mutation queue rejected and timed out writes.',
    '# TYPE mbox_mutation_queue_failures_total counter',
    `mbox_mutation_queue_failures_total{reason="rejected"} ${readinessNumber(readinessDetails, 'mutationQueueRejectedTotal')}`,
    `mbox_mutation_queue_failures_total{reason="timeout"} ${readinessNumber(readinessDetails, 'mutationQueueTimeoutTotal')}`,
    '# HELP mbox_mutation_queue_wait_ms Recent aggregate mutation queue wait.',
    '# TYPE mbox_mutation_queue_wait_ms gauge',
    `mbox_mutation_queue_wait_ms{quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationQueueWaitP95Ms')}`,
    `mbox_mutation_queue_wait_ms{quantile="0.99"} ${readinessNumber(readinessDetails, 'mutationQueueWaitP99Ms')}`,
    `mbox_mutation_queue_wait_ms{quantile="max"} ${readinessNumber(readinessDetails, 'mutationQueueWaitMaxMs')}`,
    '# HELP mbox_mutation_queue_wait_samples Recent aggregate mutation queue wait sample count.',
    '# TYPE mbox_mutation_queue_wait_samples gauge',
    `mbox_mutation_queue_wait_samples ${readinessNumber(readinessDetails, 'mutationQueueWaitSamples')}`,
    '# HELP mbox_mutation_service_duration_ms Recent serialized aggregate mutation service time.',
    '# TYPE mbox_mutation_service_duration_ms gauge',
    `mbox_mutation_service_duration_ms{quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationServiceP95Ms')}`,
    `mbox_mutation_service_duration_ms{quantile="0.99"} ${readinessNumber(readinessDetails, 'mutationServiceP99Ms')}`,
    `mbox_mutation_service_duration_ms{quantile="max"} ${readinessNumber(readinessDetails, 'mutationServiceMaxMs')}`,
    '# HELP mbox_mutation_service_samples Recent serialized aggregate mutation service sample count.',
    '# TYPE mbox_mutation_service_samples gauge',
    `mbox_mutation_service_samples ${readinessNumber(readinessDetails, 'mutationServiceSamples')}`,
    '# HELP mbox_mutation_stage_duration_ms Recent aggregate mutation stage duration.',
    '# TYPE mbox_mutation_stage_duration_ms gauge',
    `mbox_mutation_stage_duration_ms{stage="revision_lock",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationRevisionLockP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="revision_lock",quantile="max"} ${readinessNumber(readinessDetails, 'mutationRevisionLockMaxMs')}`,
    `mbox_mutation_stage_duration_ms{stage="clone",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationCloneP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="clone",quantile="max"} ${readinessNumber(readinessDetails, 'mutationCloneMaxMs')}`,
    `mbox_mutation_stage_duration_ms{stage="domain",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationDomainP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="domain",quantile="max"} ${readinessNumber(readinessDetails, 'mutationDomainMaxMs')}`,
    `mbox_mutation_stage_duration_ms{stage="serialization",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationSerializationP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="serialization",quantile="max"} ${readinessNumber(readinessDetails, 'mutationSerializationMaxMs')}`,
    `mbox_mutation_stage_duration_ms{stage="state_write",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationStateWriteP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="state_write",quantile="max"} ${readinessNumber(readinessDetails, 'mutationStateWriteMaxMs')}`,
    `mbox_mutation_stage_duration_ms{stage="projection",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationProjectionP95Ms')}`,
    `mbox_mutation_stage_duration_ms{stage="projection",quantile="max"} ${readinessNumber(readinessDetails, 'mutationProjectionMaxMs')}`,
    '# HELP mbox_mutation_source_samples Recent aggregate mutations by bounded source.',
    '# TYPE mbox_mutation_source_samples gauge',
    `mbox_mutation_source_samples{source="kds"} ${readinessNumber(readinessDetails, 'mutationKdsSamples')}`,
    `mbox_mutation_source_samples{source="scheduler"} ${readinessNumber(readinessDetails, 'mutationSchedulerSamples')}`,
    `mbox_mutation_source_samples{source="other"} ${readinessNumber(readinessDetails, 'mutationOtherSamples')}`,
    '# HELP mbox_mutation_source_queue_wait_ms Recent aggregate mutation queue wait by bounded source.',
    '# TYPE mbox_mutation_source_queue_wait_ms gauge',
    `mbox_mutation_source_queue_wait_ms{source="kds",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationKdsWaitP95Ms')}`,
    `mbox_mutation_source_queue_wait_ms{source="kds",quantile="0.99"} ${readinessNumber(readinessDetails, 'mutationKdsWaitP99Ms')}`,
    `mbox_mutation_source_queue_wait_ms{source="scheduler",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationSchedulerWaitP95Ms')}`,
    `mbox_mutation_source_queue_wait_ms{source="scheduler",quantile="0.99"} ${readinessNumber(readinessDetails, 'mutationSchedulerWaitP99Ms')}`,
    `mbox_mutation_source_queue_wait_ms{source="other",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationOtherWaitP95Ms')}`,
    `mbox_mutation_source_queue_wait_ms{source="other",quantile="0.99"} ${readinessNumber(readinessDetails, 'mutationOtherWaitP99Ms')}`,
    '# HELP mbox_mutation_source_service_duration_ms Recent aggregate mutation service P95 by bounded source.',
    '# TYPE mbox_mutation_source_service_duration_ms gauge',
    `mbox_mutation_source_service_duration_ms{source="kds",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationKdsServiceP95Ms')}`,
    `mbox_mutation_source_service_duration_ms{source="scheduler",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationSchedulerServiceP95Ms')}`,
    `mbox_mutation_source_service_duration_ms{source="other",quantile="0.95"} ${readinessNumber(readinessDetails, 'mutationOtherServiceP95Ms')}`,
    '# HELP mbox_mutation_source_outcomes_total Aggregate mutation outcomes by bounded source.',
    '# TYPE mbox_mutation_source_outcomes_total counter',
    ...(['kds', 'scheduler', 'other'] as const).flatMap((source) => {
      const prefix = source === 'kds' ? 'mutationKds' : source === 'scheduler' ? 'mutationScheduler' : 'mutationOther'
      return [
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="attempted"} ${readinessNumber(readinessDetails, `${prefix}Attempted`)}`,
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="acquired"} ${readinessNumber(readinessDetails, `${prefix}Acquired`)}`,
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="completed"} ${readinessNumber(readinessDetails, `${prefix}Completed`)}`,
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="failed_after_acquire"} ${readinessNumber(readinessDetails, `${prefix}FailedAfterAcquire`)}`,
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="rejected"} ${readinessNumber(readinessDetails, `${prefix}Rejected`)}`,
        `mbox_mutation_source_outcomes_total{source="${source}",outcome="timeout"} ${readinessNumber(readinessDetails, `${prefix}Timeout`)}`,
      ]
    }),
    '# HELP mbox_runtime_state_serialized_bytes Last serialized aggregate state size.',
    '# TYPE mbox_runtime_state_serialized_bytes gauge',
    `mbox_runtime_state_serialized_bytes{point="initial"} ${readinessNumber(readinessDetails, 'initialSerializedStateBytes')}`,
    `mbox_runtime_state_serialized_bytes{point="current"} ${readinessNumber(readinessDetails, 'serializedStateBytes')}`,
    `mbox_runtime_state_serialized_bytes{point="max"} ${readinessNumber(readinessDetails, 'maxSerializedStateBytes')}`,
    '# HELP mbox_projection_ready Whether normalized projections are current.',
    '# TYPE mbox_projection_ready gauge',
    `mbox_projection_ready ${readinessNumber(readinessDetails, 'projectionReady')}`,
    '# HELP mbox_api_route_requests_total Completed requests by normalized route and status class.',
    '# TYPE mbox_api_route_requests_total counter',
    '# HELP mbox_api_route_request_duration_ms Request duration by normalized route.',
    '# TYPE mbox_api_route_request_duration_ms histogram',
  ]
  const orderedRoutes = [...metrics.routes.values()].sort((left, right) => (
    `${left.method}:${left.route}:${left.statusClass}`.localeCompare(`${right.method}:${right.route}:${right.statusClass}`)
  ))
  for (const metric of orderedRoutes) {
    const labels = `method="${metricLabel(metric.method)}",route="${metricLabel(metric.route)}",status_class="${metricLabel(metric.statusClass)}"`
    output.push(`mbox_api_route_requests_total{${labels}} ${metric.count}`)
    ROUTE_DURATION_BUCKETS_MS.forEach((threshold, index) => {
      output.push(`mbox_api_route_request_duration_ms_bucket{${labels},le="${threshold}"} ${metric.bucketCounts[index]}`)
    })
    output.push(`mbox_api_route_request_duration_ms_bucket{${labels},le="+Inf"} ${metric.count}`)
    output.push(`mbox_api_route_request_duration_ms_sum{${labels}} ${metric.durationMsTotal.toFixed(3)}`)
    output.push(`mbox_api_route_request_duration_ms_count{${labels}} ${metric.count}`)
  }
  output.push('')
  return output.join('\n')
}

export async function registerObservability(app: FastifyInstance, options: ObservabilityOptions) {
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  const metrics: MetricState = {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    inFlight: 0,
    durationMsTotal: 0,
    routes: new Map(),
    eventLoopDelay,
  }
  let readinessCache: { expiresAt: number; value: Awaited<ReturnType<ObservabilityOptions['readiness']>> } | null = null
  let readinessPending: Promise<Awaited<ReturnType<ObservabilityOptions['readiness']>>> | null = null
  const readiness = async (forceFresh = false) => {
    const now = Date.now()
    if (!forceFresh && readinessCache && readinessCache.expiresAt > now) return readinessCache.value
    if (forceFresh) {
      const value = await options.readiness()
      readinessCache = { expiresAt: Date.now() + READINESS_CACHE_TTL_MS, value }
      return value
    }
    if (!readinessPending) {
      readinessPending = options.readiness()
        .then((value) => {
          readinessCache = { expiresAt: Date.now() + READINESS_CACHE_TTL_MS, value }
          return value
        })
        .finally(() => { readinessPending = null })
    }
    return readinessPending
  }
  app.addHook('onClose', async () => eventLoopDelay.disable())

  app.addHook('onRequest', async (request, reply) => {
    metrics.inFlight += 1
    request.startTime = performance.now()
    request.defaultCacheControl = defaultCacheControl(request)
    void reply.header('cache-control', request.defaultCacheControl)
  })
  app.addHook('onResponse', async (request, reply) => {
    metrics.inFlight = Math.max(0, metrics.inFlight - 1)
    metrics.requests += 1
    if (reply.statusCode >= 500) metrics.errors += 1
    const durationMs = Math.max(0, performance.now() - request.startTime)
    metrics.durationMsTotal += durationMs
    recordRouteMetric(metrics, request, reply.statusCode, durationMs)
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff')
    void reply.header('x-frame-options', 'DENY')
    void reply.header('referrer-policy', 'no-referrer')
    // Staff voice control is same-origin and user initiated; camera remains available for the planned event-validation flow.
    void reply.header('permissions-policy', 'camera=(self), microphone=(self), geolocation=()')
    void reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    if (options.runtimeMode === 'production') {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }
    const currentCacheControl = reply.getHeader('cache-control')
    // fastify-static emits this framework default after onRequest; normalize only that value.
    // Every route-specific policy (for example private bootstrap revalidation) remains authoritative.
    if (!reply.hasHeader('cache-control') || currentCacheControl === 'public, max-age=0') {
      void reply.header('cache-control', _request.defaultCacheControl)
    } else if (reply.statusCode >= 400 && currentCacheControl === _request.defaultCacheControl) {
      void reply.header('cache-control', 'no-store')
    }
    return payload
  })

  app.get('/api/live', async () => ({ status: 'ok', time: new Date().toISOString() }))
  app.get('/api/ready', async (_request, reply) => {
    const status = await readiness()
    return reply.status(status.ready ? 200 : 503).send({
      status: status.ready ? 'ready' : 'not_ready',
      time: new Date().toISOString(),
      ...status.details,
    })
  })
  app.get('/api/metrics', async (request, reply) => {
    if (!authenticateMetrics(request, reply, options)) return reply
    // Runtime gates inspect counters that can change on every request. A cached
    // readiness snapshot can under-count a just-finished load window and create
    // a false release failure, so metrics always use a fresh repository sample.
    const status = await readiness(true)
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheus(metrics, status.details))
  })
  app.post('/api/metrics/reset', async (request, reply) => {
    if (!authenticateMetrics(request, reply, options)) return reply
    if (options.runtimeMode === 'production') {
      return reply.status(403).send({
        code: 'METRICS_RESET_DISABLED',
        message: '生产环境禁止重置性能指标窗口',
      })
    }
    if (metrics.inFlight > 1) {
      return reply.status(409).send({
        code: 'METRICS_RESET_BUSY',
        message: '仍有其他请求执行中，不能重置性能指标窗口',
      })
    }
    await options.resetRuntimeMetrics?.()
    metrics.startedAt = Date.now()
    metrics.requests = 0
    metrics.errors = 0
    metrics.durationMsTotal = 0
    metrics.routes.clear()
    metrics.eventLoopDelay.reset()
    readinessCache = null
    return { status: 'reset', resetAt: new Date().toISOString() }
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime: number
    defaultCacheControl: string
  }
}
