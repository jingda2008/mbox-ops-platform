import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const permittedExplicitTypes = new Set([
  'container_started', 'container_restarted', 'container_oom', 'database_pool_wait', 'database_pool_timeout',
  'deployment_started', 'deployment_succeeded', 'deployment_failed', 'cutover_succeeded', 'cutover_failed',
  'rollback_started', 'rollback_succeeded', 'rollback_failed', 'permission_denied', 'critical_audit',
])

const paymentExpression = /(?:payment|refund|callback|notify|付款|支付|退款|回调)/i
const databaseExpression = /(?:database pool|pool acquisition|connection pool|mutation queue|persistence unavailable|数据库连接池|连接池|持久化不可用)/i
const containerExpression = /(?:container|oom|out of memory|restart|容器|内存溢出|重启)/i
const permissionExpression = /(?:authorization|authentication|forbidden|permission denied|unauthorized|无权|权限拒绝|身份无效)/i

function text(value) {
  return typeof value === 'string' ? value : ''
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function unwrap(input) {
  if (typeof input === 'string') {
    try { return JSON.parse(input) } catch { return { msg: input } }
  }
  if (input && typeof input === 'object' && typeof input.log === 'string') {
    try { return { ...JSON.parse(input.log), dockerTime: input.time } } catch { return { msg: input.log, dockerTime: input.time } }
  }
  return input && typeof input === 'object' ? input : {}
}

function normalizedRoute(record) {
  const raw = text(record.route || record.req?.routeOptions?.url || record.req?.url || record.url)
  if (!raw) return undefined
  try {
    return new URL(raw, 'http://mbox.local').pathname
  } catch {
    return raw.split('?')[0]
  }
}

function eventFingerprint(event) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(event).toSorted(([a], [b]) => a.localeCompare(b))))
  return createHash('sha256').update(stable).digest('hex')
}

function baseEvent(record, eventType, logstore) {
  const statusCode = finite(record.statusCode ?? record.res?.statusCode)
  const durationMs = finite(record.durationMs ?? record.responseTime)
  const event = {
    timestamp: text(record.timestamp || record.time || record.dockerTime) || new Date().toISOString(),
    eventType,
    severity: finite(record.level) >= 50 ? 'error' : finite(record.level) >= 40 ? 'warning' : text(record.severity) || 'info',
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(normalizedRoute(record) ? { route: normalizedRoute(record) } : {}),
    ...(text(record.code) ? { code: text(record.code).slice(0, 96) } : {}),
    ...(text(record.reqId || record.requestId) ? { requestId: text(record.reqId || record.requestId).slice(0, 96) } : {}),
    ...(text(record.releaseSha) ? { releaseSha: text(record.releaseSha).slice(0, 64) } : {}),
    ...(text(record.imageDigest) ? { imageDigest: text(record.imageDigest).slice(0, 80) } : {}),
    ...(text(record.container) ? { container: text(record.container).slice(0, 96) } : {}),
    ...(text(record.outcome) ? { outcome: text(record.outcome).slice(0, 48) } : {}),
    ...(text(record.actorId) ? { actorId: text(record.actorId).slice(0, 96) } : {}),
    ...(text(record.operation) ? { operation: text(record.operation).slice(0, 128) } : {}),
    logstore,
  }
  return { ...event, fingerprint: eventFingerprint(event) }
}

export function classifySlsEvent(input) {
  const record = unwrap(input)
  const message = `${text(record.msg)} ${text(record.message)} ${text(record.code)} ${text(record.eventType)} ${normalizedRoute(record) ?? ''}`
  const explicitType = text(record.mboxAuditEvent || record.eventType)
  if (permittedExplicitTypes.has(explicitType)) {
    const logstore = explicitType.startsWith('deployment_') || explicitType.startsWith('cutover_')
      || explicitType.startsWith('rollback_') || explicitType === 'permission_denied' || explicitType === 'critical_audit'
      ? 'release-audit'
      : 'runtime-errors'
    return baseEvent(record, explicitType, logstore)
  }

  const statusCode = finite(record.statusCode ?? record.res?.statusCode) ?? 0
  const anomalous = statusCode >= 400 || finite(record.level) >= 40
  if (paymentExpression.test(message) && anomalous) {
    const eventType = /refund|退款/i.test(message)
      ? 'refund_exception'
      : /callback|notify|回调/i.test(message) ? 'callback_exception' : 'payment_exception'
    return baseEvent(record, eventType, 'payment-audit')
  }
  if (permissionExpression.test(message) && anomalous) return baseEvent(record, 'permission_denied', 'release-audit')
  if (databaseExpression.test(message) && anomalous) {
    return baseEvent(record, /timeout|超时/i.test(message) ? 'database_pool_timeout' : 'database_pool_wait', 'runtime-errors')
  }
  if (containerExpression.test(message) && anomalous) {
    return baseEvent(record, /oom|out of memory|内存溢出/i.test(message) ? 'container_oom' : 'container_restarted', 'runtime-errors')
  }
  if (statusCode >= 500) return baseEvent(record, 'http_5xx', 'runtime-errors')
  return null
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let input
    try { input = JSON.parse(line) } catch { input = line }
    const event = classifySlsEvent(input)
    if (event) process.stdout.write(`${JSON.stringify(event)}\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
