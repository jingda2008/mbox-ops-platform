import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evaluateRuntimeStateGrowth } from './runtime-state-growth-policy.mjs'

const baseUrls = (process.env.MBOX_METRICS_BASE_URLS ?? '')
  .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
const token = process.env.MBOX_METRICS_TOKEN?.trim()
const output = process.env.MBOX_METRICS_REPORT_PATH?.trim()
const eventLoopP95TargetMs = Number(process.env.MBOX_EVENT_LOOP_P95_TARGET_MS ?? 50)
const eventLoopP95LimitMs = Number(process.env.MBOX_EVENT_LOOP_P95_LIMIT_MS ?? 75)
const eventLoopP99LimitMs = Number(process.env.MBOX_EVENT_LOOP_P99_LIMIT_MS ?? 100)
const poolAcquireP95LimitMs = Number(process.env.MBOX_POOL_ACQUIRE_P95_LIMIT_MS ?? 50)
const mutationQueueDepthLimit = Number(process.env.MBOX_MUTATION_QUEUE_DEPTH_LIMIT ?? 100)
const mutationQueueUsageLimit = Number(process.env.MBOX_MUTATION_QUEUE_USAGE_LIMIT ?? 0.8)
const mutationQueueWaitP95LimitMs = Number(process.env.MBOX_MUTATION_QUEUE_WAIT_P95_LIMIT_MS ?? 100)
const mutationQueueWaitP99LimitMs = Number(process.env.MBOX_MUTATION_QUEUE_WAIT_P99_LIMIT_MS ?? 250)
const mutationServiceP95LimitMs = Number(process.env.MBOX_MUTATION_SERVICE_P95_LIMIT_MS ?? 500)
const mutationServiceP99LimitMs = Number(process.env.MBOX_MUTATION_SERVICE_P99_LIMIT_MS ?? 800)
const mutationMinimumSamples = Number(process.env.MBOX_MUTATION_MINIMUM_SAMPLES ?? 100)
const serializedStateMaxBytes = Number(process.env.MBOX_SERIALIZED_STATE_MAX_BYTES ?? 10_000_000)
const serializedStateGrowthRatioLimit = Number(process.env.MBOX_SERIALIZED_STATE_GROWTH_RATIO_LIMIT ?? 8)
const serializedStateGrowthFloorBytes = Number(process.env.MBOX_SERIALIZED_STATE_GROWTH_FLOOR_BYTES ?? 2_000_000)
const serializedStateBytesPerMutationLimit = Number(process.env.MBOX_SERIALIZED_STATE_BYTES_PER_MUTATION_LIMIT ?? 5_000)

if (baseUrls.length < 2) throw new Error('运行指标门禁至少需要两个API实例')
if (!token) throw new Error('运行指标门禁缺少MBOX_METRICS_TOKEN')
for (const [name, value] of [
  ['MBOX_EVENT_LOOP_P95_TARGET_MS', eventLoopP95TargetMs],
  ['MBOX_EVENT_LOOP_P95_LIMIT_MS', eventLoopP95LimitMs],
  ['MBOX_EVENT_LOOP_P99_LIMIT_MS', eventLoopP99LimitMs],
]) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}必须是正数`)
}
if (eventLoopP95TargetMs > eventLoopP95LimitMs) {
  throw new Error('事件循环P95理想目标不得高于发布硬上限')
}
if (!Number.isFinite(poolAcquireP95LimitMs) || poolAcquireP95LimitMs <= 0) {
  throw new Error('MBOX_POOL_ACQUIRE_P95_LIMIT_MS必须是正数')
}
if (!Number.isSafeInteger(mutationQueueDepthLimit) || mutationQueueDepthLimit <= 0) {
  throw new Error('MBOX_MUTATION_QUEUE_DEPTH_LIMIT必须是正整数')
}
for (const [name, value] of [
  ['MBOX_MUTATION_QUEUE_WAIT_P95_LIMIT_MS', mutationQueueWaitP95LimitMs],
  ['MBOX_MUTATION_QUEUE_WAIT_P99_LIMIT_MS', mutationQueueWaitP99LimitMs],
  ['MBOX_MUTATION_SERVICE_P95_LIMIT_MS', mutationServiceP95LimitMs],
  ['MBOX_MUTATION_SERVICE_P99_LIMIT_MS', mutationServiceP99LimitMs],
  ['MBOX_SERIALIZED_STATE_MAX_BYTES', serializedStateMaxBytes],
  ['MBOX_SERIALIZED_STATE_GROWTH_RATIO_LIMIT', serializedStateGrowthRatioLimit],
  ['MBOX_SERIALIZED_STATE_GROWTH_FLOOR_BYTES', serializedStateGrowthFloorBytes],
  ['MBOX_SERIALIZED_STATE_BYTES_PER_MUTATION_LIMIT', serializedStateBytesPerMutationLimit],
]) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}必须是正数`)
}
if (!Number.isFinite(mutationQueueUsageLimit) || mutationQueueUsageLimit <= 0 || mutationQueueUsageLimit > 1) {
  throw new Error('MBOX_MUTATION_QUEUE_USAGE_LIMIT必须是0至1之间的数')
}
if (!Number.isSafeInteger(mutationMinimumSamples) || mutationMinimumSamples < 0) {
  throw new Error('MBOX_MUTATION_MINIMUM_SAMPLES必须是非负整数')
}

function metricValue(text, name, labels = '') {
  const prefix = labels ? `${name}{${labels}}` : name
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${prefix} `))
  if (!line) throw new Error(`缺少运行指标 ${prefix}`)
  const value = Number(line.slice(prefix.length + 1))
  if (!Number.isFinite(value)) throw new Error(`运行指标 ${prefix} 不是有效数字`)
  return value
}

function mutationSourceOutcomes(text, source) {
  const value = (outcome) => metricValue(
    text,
    'mbox_mutation_source_outcomes_total',
    `source="${source}",outcome="${outcome}"`,
  )
  return {
    attempted: value('attempted'),
    acquired: value('acquired'),
    completed: value('completed'),
    failedAfterAcquire: value('failed_after_acquire'),
    rejected: value('rejected'),
    timeout: value('timeout'),
  }
}

function mutationSourceConservationFailures(source, outcomes) {
  const failures = []
  if (outcomes.attempted !== outcomes.acquired + outcomes.rejected + outcomes.timeout) {
    failures.push(`${source}来源写入不守恒：尝试${outcomes.attempted} != 入队${outcomes.acquired} + 拒绝${outcomes.rejected} + 超时${outcomes.timeout}`)
  }
  if (outcomes.acquired !== outcomes.completed + outcomes.failedAfterAcquire) {
    failures.push(`${source}来源执行不守恒：入队${outcomes.acquired} != 完成${outcomes.completed} + 执行失败${outcomes.failedAfterAcquire}`)
  }
  return failures
}

const observedInstances = await Promise.all(baseUrls.map(async (baseUrl) => {
  const response = await fetch(`${baseUrl}/api/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`${baseUrl}运行指标请求失败：${response.status}`)
  const text = await response.text()
  const mutationSourceOutcomesBySource = Object.fromEntries(
    ['kds', 'scheduler', 'other'].map((source) => [source, mutationSourceOutcomes(text, source)]),
  )
  const values = {
    eventLoopP95Ms: metricValue(text, 'mbox_node_event_loop_delay_ms', 'quantile="0.95"'),
    eventLoopP99Ms: metricValue(text, 'mbox_node_event_loop_delay_ms', 'quantile="0.99"'),
    apiErrors: metricValue(text, 'mbox_api_errors_total'),
    poolWaiting: metricValue(text, 'mbox_database_pool_connections', 'state="waiting"'),
    poolAcquireP95Ms: metricValue(text, 'mbox_database_pool_acquisition_wait_ms', 'quantile="0.95"'),
    poolAcquireFailures: metricValue(text, 'mbox_database_pool_acquisitions_total', 'outcome="failed"'),
    mutationQueuePending: metricValue(text, 'mbox_mutation_queue_pending'),
    mutationQueueHighWatermark: metricValue(text, 'mbox_mutation_queue_high_watermark'),
    mutationQueueCapacity: metricValue(text, 'mbox_mutation_queue_capacity'),
    mutationQueueRejected: metricValue(text, 'mbox_mutation_queue_failures_total', 'reason="rejected"'),
    mutationQueueTimeouts: metricValue(text, 'mbox_mutation_queue_failures_total', 'reason="timeout"'),
    mutationQueueWaitSamples: metricValue(text, 'mbox_mutation_queue_wait_samples'),
    mutationQueueWaitP95Ms: metricValue(text, 'mbox_mutation_queue_wait_ms', 'quantile="0.95"'),
    mutationQueueWaitP99Ms: metricValue(text, 'mbox_mutation_queue_wait_ms', 'quantile="0.99"'),
    mutationQueueWaitMaxMs: metricValue(text, 'mbox_mutation_queue_wait_ms', 'quantile="max"'),
    mutationServiceSamples: metricValue(text, 'mbox_mutation_service_samples'),
    mutationServiceP95Ms: metricValue(text, 'mbox_mutation_service_duration_ms', 'quantile="0.95"'),
    mutationServiceP99Ms: metricValue(text, 'mbox_mutation_service_duration_ms', 'quantile="0.99"'),
    mutationServiceMaxMs: metricValue(text, 'mbox_mutation_service_duration_ms', 'quantile="max"'),
    mutationRevisionLockP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="revision_lock",quantile="0.95"'),
    mutationCloneP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="clone",quantile="0.95"'),
    mutationDomainP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="domain",quantile="0.95"'),
    mutationSerializationP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="serialization",quantile="0.95"'),
    mutationStateWriteP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="state_write",quantile="0.95"'),
    mutationProjectionP95Ms: metricValue(text, 'mbox_mutation_stage_duration_ms', 'stage="projection",quantile="0.95"'),
    mutationKdsSamples: metricValue(text, 'mbox_mutation_source_samples', 'source="kds"'),
    mutationKdsWaitP95Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="kds",quantile="0.95"'),
    mutationKdsWaitP99Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="kds",quantile="0.99"'),
    mutationKdsServiceP95Ms: metricValue(text, 'mbox_mutation_source_service_duration_ms', 'source="kds",quantile="0.95"'),
    mutationSchedulerSamples: metricValue(text, 'mbox_mutation_source_samples', 'source="scheduler"'),
    mutationSchedulerWaitP95Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="scheduler",quantile="0.95"'),
    mutationSchedulerWaitP99Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="scheduler",quantile="0.99"'),
    mutationSchedulerServiceP95Ms: metricValue(text, 'mbox_mutation_source_service_duration_ms', 'source="scheduler",quantile="0.95"'),
    mutationOtherSamples: metricValue(text, 'mbox_mutation_source_samples', 'source="other"'),
    mutationOtherWaitP95Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="other",quantile="0.95"'),
    mutationOtherWaitP99Ms: metricValue(text, 'mbox_mutation_source_queue_wait_ms', 'source="other",quantile="0.99"'),
    mutationOtherServiceP95Ms: metricValue(text, 'mbox_mutation_source_service_duration_ms', 'source="other",quantile="0.95"'),
    initialSerializedStateBytes: metricValue(text, 'mbox_runtime_state_serialized_bytes', 'point="initial"'),
    serializedStateBytes: metricValue(text, 'mbox_runtime_state_serialized_bytes', 'point="current"'),
    maxSerializedStateBytes: metricValue(text, 'mbox_runtime_state_serialized_bytes', 'point="max"'),
    projectionReady: metricValue(text, 'mbox_projection_ready'),
    mutationSourceOutcomes: mutationSourceOutcomesBySource,
  }
  return { baseUrl, values }
}))

// Every API instance observes the same authoritative aggregate state, while
// mutation samples are split between instances. Use the cluster-wide sample
// count when calculating aggregate-state growth per write.
const clusterMutationServiceSamples = observedInstances.reduce((total, instance) => (
  total + instance.values.mutationServiceSamples
), 0)

const instances = observedInstances.map(({ baseUrl, values }) => {
  const stateGrowth = evaluateRuntimeStateGrowth({
    initialBytes: values.initialSerializedStateBytes,
    maxBytes: values.maxSerializedStateBytes,
    mutationSamples: clusterMutationServiceSamples,
    absoluteLimitBytes: serializedStateMaxBytes,
    ratioWarningLimit: serializedStateGrowthRatioLimit,
    significantGrowthBytes: serializedStateGrowthFloorBytes,
    bytesPerMutationLimit: serializedStateBytesPerMutationLimit,
  })
  const failures = [
    values.eventLoopP95Ms > eventLoopP95LimitMs ? `事件循环P95 ${values.eventLoopP95Ms}ms > ${eventLoopP95LimitMs}ms` : null,
    values.eventLoopP99Ms > eventLoopP99LimitMs ? `事件循环P99 ${values.eventLoopP99Ms}ms > ${eventLoopP99LimitMs}ms` : null,
    values.apiErrors !== 0 ? `5xx累计 ${values.apiErrors}` : null,
    values.poolWaiting !== 0 ? `连接池等待 ${values.poolWaiting}` : null,
    values.poolAcquireP95Ms > poolAcquireP95LimitMs
      ? `连接池获取P95 ${values.poolAcquireP95Ms}ms > ${poolAcquireP95LimitMs}ms`
      : null,
    values.poolAcquireFailures !== 0 ? `连接池获取失败 ${values.poolAcquireFailures}` : null,
    values.mutationQueuePending > mutationQueueDepthLimit
      ? `当前写队列深度 ${values.mutationQueuePending} > ${mutationQueueDepthLimit}`
      : null,
    values.mutationQueueHighWatermark > Math.floor(values.mutationQueueCapacity * mutationQueueUsageLimit)
      ? `写队列高水位 ${values.mutationQueueHighWatermark} > 容量${mutationQueueUsageLimit * 100}%`
      : null,
    values.mutationQueueCapacity > mutationQueueDepthLimit
      ? `写队列容量 ${values.mutationQueueCapacity} > ${mutationQueueDepthLimit}`
      : null,
    values.mutationQueueRejected !== 0 ? `写队列拒绝 ${values.mutationQueueRejected}` : null,
    values.mutationQueueTimeouts !== 0 ? `写队列超时 ${values.mutationQueueTimeouts}` : null,
    values.mutationQueueWaitSamples < mutationMinimumSamples
      ? `写队列等待样本 ${values.mutationQueueWaitSamples} < ${mutationMinimumSamples}` : null,
    values.mutationQueueWaitP95Ms > mutationQueueWaitP95LimitMs
      ? `写队列等待P95 ${values.mutationQueueWaitP95Ms}ms > ${mutationQueueWaitP95LimitMs}ms` : null,
    values.mutationQueueWaitP99Ms > mutationQueueWaitP99LimitMs
      ? `写队列等待P99 ${values.mutationQueueWaitP99Ms}ms > ${mutationQueueWaitP99LimitMs}ms` : null,
    values.mutationServiceSamples < mutationMinimumSamples
      ? `写服务样本 ${values.mutationServiceSamples} < ${mutationMinimumSamples}` : null,
    values.mutationServiceP95Ms > mutationServiceP95LimitMs
      ? `写服务P95 ${values.mutationServiceP95Ms}ms > ${mutationServiceP95LimitMs}ms` : null,
    values.mutationServiceP99Ms > mutationServiceP99LimitMs
      ? `写服务P99 ${values.mutationServiceP99Ms}ms > ${mutationServiceP99LimitMs}ms` : null,
    ...Object.entries(values.mutationSourceOutcomes).flatMap(([source, outcomes]) => (
      mutationSourceConservationFailures(source, outcomes)
    )),
    ...stateGrowth.failures,
    values.projectionReady !== 1 ? '规范化投影未就绪' : null,
  ].filter(Boolean)
  const warnings = [
    values.eventLoopP95Ms > eventLoopP95TargetMs
      ? `事件循环P95 ${values.eventLoopP95Ms}ms未达到${eventLoopP95TargetMs}ms理想目标`
      : null,
    ...stateGrowth.warnings,
  ].filter(Boolean)
  return { baseUrl, values, stateGrowth, warnings, failures, passed: failures.length === 0 }
})

const report = {
  thresholds: {
    eventLoopP95TargetMs,
    eventLoopP95LimitMs,
    eventLoopP99LimitMs,
    poolAcquireP95LimitMs,
    mutationQueueDepthLimit,
    mutationQueueUsageLimit,
    mutationQueueWaitP95LimitMs,
    mutationQueueWaitP99LimitMs,
    mutationServiceP95LimitMs,
    mutationServiceP99LimitMs,
    mutationMinimumSamples,
    serializedStateMaxBytes,
    serializedStateGrowthRatioLimit,
    serializedStateGrowthFloorBytes,
    serializedStateBytesPerMutationLimit,
    clusterMutationServiceSamples,
  },
  instances,
  passed: instances.every((instance) => instance.passed),
}
const serialized = `${JSON.stringify(report, null, 2)}\n`
if (output) await writeFile(resolve(output), serialized, 'utf8')
process.stdout.write(serialized)
if (!report.passed) process.exitCode = 1
