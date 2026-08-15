import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scriptUrl = new URL('./verify-normalized-new-code.mjs', import.meta.url)

test('new normalized migration gate blocks exact legacy projection identifiers without broad operational false positives', async () => {
  const source = await readFile(scriptUrl, 'utf8')
  assert.match(source, /operational_projection_checkpoints/)
  assert.match(source, /operational_kds_tasks/)
  assert.match(source, /new RegExp\(`\\\\b\$\{forbidden\}\\\\b`\)/)
  assert.doesNotMatch(source, /\['runtime_states', 'runtime_state_versions', 'operational_'\]/)
})
