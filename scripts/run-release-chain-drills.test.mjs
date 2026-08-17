import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('release drills prove preflight, migration, candidate, cutover, evidence and completion behavior', () => {
  const output = mkdtempSync(join(tmpdir(), 'mbox-release-drills-'))
  execFileSync('npx', ['tsx', 'scripts/run-release-chain-drills.ts', output], { cwd: new URL('..', import.meta.url) })
  const rejected = JSON.parse(readFileSync(join(output, 'candidate-config-rejected.json'), 'utf8'))
  const rollback = JSON.parse(readFileSync(join(output, 'candidate-post-cutover-rollback.json'), 'utf8'))
  const success = JSON.parse(readFileSync(join(output, 'candidate-happy-path.json'), 'utf8'))
  const migration = JSON.parse(readFileSync(join(output, 'candidate-migration-failed.json'), 'utf8'))
  const startup = JSON.parse(readFileSync(join(output, 'candidate-startup-failed.json'), 'utf8'))
  const interrupted = JSON.parse(readFileSync(join(output, 'candidate-cutover-interrupted.json'), 'utf8'))
  const evidence = JSON.parse(readFileSync(join(output, 'candidate-oss-verification-failed.json'), 'utf8'))
  assert.equal(rejected.assertions.databaseWrites, 0)
  assert.equal(rejected.state.current, 'artifact_verified')
  assert.equal(rollback.assertions.rollbackRebuilds, 0)
  assert.equal(rollback.outcome, 'forward-recovery-required')
  assert.equal(rollback.assertions.oldApplicationStarted, false)
  assert.equal(rollback.state.current, 'completed')
  assert.equal(migration.assertions.cutovers, 0)
  assert.equal(migration.assertions.databaseRestores, 1)
  assert.equal(migration.state.current, 'rolled_back')
  assert.equal(startup.assertions.rollbackRebuilds, 0)
  assert.equal(startup.assertions.databaseRestores, 1)
  assert.equal(interrupted.outcome, 'forward-recovery-required')
  assert.equal(interrupted.assertions.oldApplicationStarted, false)
  assert.equal(interrupted.state.current, 'cutover_started')
  assert.equal(evidence.assertions.databaseWrites, 0)
  assert.equal(success.state.current, 'completed')
  assert.match(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), /^[0-9a-f]{64}/m)
})
