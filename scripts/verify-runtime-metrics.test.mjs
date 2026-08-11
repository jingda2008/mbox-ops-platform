import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { evaluateRuntimeStateGrowth } from './runtime-state-growth-policy.mjs'

test('runtime metric verifier keeps the commercial thresholds explicit', async () => {
  const source = await readFile(new URL('./verify-runtime-metrics.mjs', import.meta.url), 'utf8')
  assert.match(source, /MBOX_EVENT_LOOP_P95_TARGET_MS \?\? 50/)
  assert.match(source, /MBOX_EVENT_LOOP_P95_LIMIT_MS \?\? 75/)
  assert.match(source, /MBOX_EVENT_LOOP_P99_LIMIT_MS \?\? 100/)
  assert.match(source, /MBOX_POOL_ACQUIRE_P95_LIMIT_MS \?\? 50/)
  assert.match(source, /MBOX_MUTATION_QUEUE_DEPTH_LIMIT \?\? 100/)
  assert.match(source, /MBOX_MUTATION_QUEUE_USAGE_LIMIT \?\? 0\.8/)
  assert.match(source, /MBOX_MUTATION_QUEUE_WAIT_P95_LIMIT_MS \?\? 100/)
  assert.match(source, /MBOX_MUTATION_SERVICE_P95_LIMIT_MS \?\? 500/)
  assert.match(source, /MBOX_MUTATION_MINIMUM_SAMPLES \?\? 100/)
  assert.match(source, /MBOX_SERIALIZED_STATE_MAX_BYTES \?\? 10_000_000/)
  assert.match(source, /MBOX_SERIALIZED_STATE_GROWTH_FLOOR_BYTES \?\? 2_000_000/)
  assert.match(source, /MBOX_SERIALIZED_STATE_BYTES_PER_MUTATION_LIMIT \?\? 5_000/)
  assert.match(source, /evaluateRuntimeStateGrowth/)
  assert.match(source, /clusterMutationServiceSamples/)
  assert.match(source, /baseUrls\.length < 2/)
  assert.match(source, /mbox_database_pool_acquisitions_total/)
  assert.match(source, /mbox_mutation_queue_failures_total/)
  assert.match(source, /mbox_mutation_queue_high_watermark/)
  assert.match(source, /mbox_mutation_stage_duration_ms/)
  assert.match(source, /stage="revision_lock"/)
  assert.match(source, /mbox_mutation_source_samples/)
  assert.match(source, /mbox_mutation_source_queue_wait_ms/)
  assert.match(source, /mbox_mutation_source_outcomes_total/)
  assert.match(source, /mutationSourceConservationFailures/)
  assert.match(source, /mbox_projection_ready/)
  assert.match(source, /quantile="0\.99"/)
  assert.match(source, /warnings/)
  assert.match(source, /process\.exitCode = 1/)
})

const thresholds = {
  absoluteLimitBytes: 10_000_000,
  ratioWarningLimit: 8,
  significantGrowthBytes: 2_000_000,
  bytesPerMutationLimit: 5_000,
}

test('large low-baseline ratio warns but normal per-write growth does not block', () => {
  const result = evaluateRuntimeStateGrowth({
    ...thresholds,
    initialBytes: 80_000,
    maxBytes: 3_290_000,
    mutationSamples: 916,
  })

  assert.equal(result.passed, true)
  assert.equal(result.failures.length, 0)
  assert.ok(result.bytesPerMutation < 5_000)
  assert.match(result.warnings.join('\n'), /倍率只用于趋势预警/)
})

test('significant abnormal growth per business write blocks release', () => {
  const result = evaluateRuntimeStateGrowth({
    ...thresholds,
    initialBytes: 80_000,
    maxBytes: 3_290_000,
    mutationSamples: 100,
  })

  assert.equal(result.passed, false)
  assert.match(result.failures.join('\n'), /每次写入状态增量/)
})

test('absolute aggregate limit blocks even when many writes dilute the slope', () => {
  const result = evaluateRuntimeStateGrowth({
    ...thresholds,
    initialBytes: 80_000,
    maxBytes: 10_000_001,
    mutationSamples: 10_000,
  })

  assert.equal(result.passed, false)
  assert.match(result.failures.join('\n'), /聚合状态最大/)
})
