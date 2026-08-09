import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname

test('reviewed MBOX baseline is generated deterministically and contains only P0/P1 definitions', async () => {
  const generated = execFileSync(process.execPath, [
    'scripts/build-tc-execution-register.mjs', '--print-reviewed-baseline',
  ], { cwd: root, encoding: 'utf8' })
  const tracked = await readFile(new URL('../docs/quality/mbox-required-tc-baseline-v1.txt', import.meta.url), 'utf8')
  assert.equal(generated, tracked)
  const lines = tracked.trim().split(/\r?\n/)
  assert.ok(lines.length > 250)
  for (const line of lines) assert.match(line, /^[A-Z]{3}-\d{3}\|P[01]\|[0-9a-f]{64}$/)
})

test('tag release downloads and verifies exact CI quality and runtime artifacts', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /gh run download "\$\{VERIFIED_RUN_ID\}"/)
  assert.match(workflow, /quality-evidence-\$\{GITHUB_SHA\}/)
  assert.match(workflow, /runtime-quality-\$\{GITHUB_SHA\}/)
  assert.match(workflow, /sha256sum --check SHA256SUMS/)
  assert.match(workflow, /quality ledger CI run mismatch/)
})
