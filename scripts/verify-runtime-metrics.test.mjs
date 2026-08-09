import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('runtime metric verifier keeps the commercial thresholds explicit', async () => {
  const source = await readFile(new URL('./verify-runtime-metrics.mjs', import.meta.url), 'utf8')
  assert.match(source, /MBOX_EVENT_LOOP_P95_TARGET_MS \?\? 50/)
  assert.match(source, /MBOX_EVENT_LOOP_P95_LIMIT_MS \?\? 75/)
  assert.match(source, /MBOX_EVENT_LOOP_P99_LIMIT_MS \?\? 100/)
  assert.match(source, /MBOX_POOL_ACQUIRE_P95_LIMIT_MS \?\? 50/)
  assert.match(source, /MBOX_MUTATION_QUEUE_DEPTH_LIMIT \?\? 100/)
  assert.match(source, /baseUrls\.length < 2/)
  assert.match(source, /mbox_database_pool_acquisitions_total/)
  assert.match(source, /mbox_mutation_queue_failures_total/)
  assert.match(source, /mbox_mutation_queue_high_watermark/)
  assert.match(source, /mbox_projection_ready/)
  assert.match(source, /quantile="0\.99"/)
  assert.match(source, /warnings/)
  assert.match(source, /process\.exitCode = 1/)
})
