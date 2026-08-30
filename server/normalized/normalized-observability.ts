import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { NormalizedRuntimeConfig } from './normalized-runtime-config.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ')

export function registerNormalizedObservability(
  app: FastifyInstance,
  config: Readonly<NormalizedRuntimeConfig>,
  transactions: ScopedPostgresTransactionRunner,
): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers({
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-opener-policy': 'same-origin-allow-popups',
      'cross-origin-resource-policy': crossOriginResourcePolicy(request),
      'permissions-policy': 'camera=(self), microphone=(self), geolocation=(), payment=(self), usb=()',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    if (config.nodeEnv === 'production') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })

  app.get('/api/metrics', async (request, reply) => {
    if (!hasMetricsAccess(request, config.metricsToken)) {
      return reply
        .header('www-authenticate', 'Bearer realm="mbox-metrics"')
        .code(401)
        .send({ error: { code: 'METRICS_AUTH_REQUIRED', message: '指标访问凭证无效' } })
    }
    return reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics(config, transactions))
  })
}

function crossOriginResourcePolicy(request: FastifyRequest): 'cross-origin' | 'same-site' {
  const pathname = request.url.split('?', 1)[0] ?? ''
  if (pathname.startsWith('/menu/') || pathname.startsWith('/api/public/media-assets/')) {
    return 'cross-origin'
  }
  return 'same-site'
}

function hasMetricsAccess(request: FastifyRequest, expected: string | null): boolean {
  if (expected === null) return false
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const presented = authorization.slice('Bearer '.length)
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function renderMetrics(
  config: Readonly<NormalizedRuntimeConfig>,
  transactions: ScopedPostgresTransactionRunner,
): string {
  const database = transactions.telemetrySnapshot()
  const lines = [
    '# HELP mbox_runtime_info Immutable runtime identity.',
    '# TYPE mbox_runtime_info gauge',
    `mbox_runtime_info{commit_sha="${label(config.commitSha)}",schema_flavor="${label(config.schemaFlavor)}",deployment_tier="${label(config.deploymentTier)}"} 1`,
    '# HELP mbox_process_uptime_seconds Node.js process uptime.',
    '# TYPE mbox_process_uptime_seconds gauge',
    `mbox_process_uptime_seconds ${round(process.uptime())}`,
    '# TYPE mbox_database_pool_acquisitions_total counter',
    `mbox_database_pool_acquisitions_total{outcome="success"} ${database.pool.acquisitions - database.pool.acquisitionFailures}`,
    `mbox_database_pool_acquisitions_total{outcome="failed"} ${database.pool.acquisitionFailures}`,
    '# TYPE mbox_database_pool_connections gauge',
    `mbox_database_pool_connections{state="total"} ${numberOrZero(database.pool.totalConnections)}`,
    `mbox_database_pool_connections{state="idle"} ${numberOrZero(database.pool.idleConnections)}`,
    `mbox_database_pool_connections{state="waiting"} ${numberOrZero(database.pool.waitingClients)}`,
    ...durationLines('mbox_database_pool_acquisition_wait_ms', database.pool.acquisitionWaitMs),
    '# TYPE mbox_database_transactions_total counter',
    `mbox_database_transactions_total{outcome="completed"} ${database.transactions.completed}`,
    `mbox_database_transactions_total{outcome="failed"} ${database.transactions.failed}`,
    ...durationLines('mbox_database_transaction_duration_ms', database.transactions.durationMs),
    '# TYPE mbox_database_queries_total counter',
    `mbox_database_queries_total{outcome="completed"} ${database.queries.completed}`,
    `mbox_database_queries_total{outcome="failed"} ${database.queries.failed}`,
    ...durationLines('mbox_database_query_duration_ms', database.queries.durationMs),
  ]
  return `${lines.join('\n')}\n`
}

function durationLines(
  name: string,
  summary: Readonly<{ samples: number; p50: number; p95: number; p99: number; max: number }>,
): string[] {
  return [
    `# TYPE ${name} summary`,
    `${name}{quantile="0.50"} ${round(summary.p50)}`,
    `${name}{quantile="0.95"} ${round(summary.p95)}`,
    `${name}{quantile="0.99"} ${round(summary.p99)}`,
    `${name}_count ${summary.samples}`,
    `${name}{quantile="max"} ${round(summary.max)}`,
  ]
}

function numberOrZero(value: number | null): number {
  return value ?? 0
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}
