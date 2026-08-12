import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runQualityPlan, validateQualityPlan } from './run-software-quality-plan.mjs'

const node = process.execPath

test('rejects duplicate gates and unknown profile references', () => {
  assert.throws(() => validateQualityPlan({
    schemaVersion: 1, template: true, name: 'template', gates: [{ id: 'one', command: [node, '-e', ''] }],
  }), /must be copied and adapted/)
  assert.throws(() => validateQualityPlan({
    schemaVersion: 1, name: 'bad',
    gates: [{ id: 'same', command: [node, '-e', ''] }, { id: 'same', command: [node, '-e', ''] }],
  }), /duplicate gate id/)
  assert.throws(() => validateQualityPlan({
    schemaVersion: 1, name: 'bad', gates: [{ id: 'one', command: [node, '-e', ''] }], profiles: { release: ['missing'] },
  }), /unknown gate/)
})

test('the repository product plan is fully adapted and structurally valid', async () => {
  const plan = JSON.parse(await readFile(new URL('../docs/quality/mbox-software-quality-plan-v1.json', import.meta.url)))
  assert.doesNotThrow(() => validateQualityPlan(plan))
  assert.deepEqual(plan.profiles.release.slice(-2), ['performance', 'commercial_release'])
})

test('fails closed for required gates but records optional failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'quality-plan-'))
  try {
    const report = await runQualityPlan({
      schemaVersion: 1,
      name: 'portable quality plan',
      gates: [
        { id: 'pass', command: [node, '-e', 'process.stdout.write("ok")'] },
        { id: 'optional', required: false, command: [node, '-e', 'process.exit(2)'] },
        { id: 'required', command: [node, '-e', 'process.stderr.write("broken"); process.exit(3)'] },
      ],
      profiles: { release: ['pass', 'optional', 'required'] },
    }, { cwd })
    assert.equal(report.passed, false)
    assert.deepEqual(report.summary, { total: 3, passed: 1, failed: 2, blockingFailures: 1 })
    assert.match(report.gates[2].stderrTail, /broken/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('terminates and reports timed out gates', async () => {
  const report = await runQualityPlan({
    schemaVersion: 1,
    name: 'timeout plan',
    gates: [{ id: 'slow', timeoutSeconds: 0.02, command: [node, '-e', 'setTimeout(() => {}, 5000)'] }],
  })
  assert.equal(report.passed, false)
  assert.equal(report.gates[0].timedOut, true)
})
