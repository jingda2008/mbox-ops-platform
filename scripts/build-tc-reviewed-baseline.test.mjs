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

test('CI separates successful evidence from failed diagnostics and keeps uploads non-authoritative', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(
    workflow,
    /name: Upload successful runtime evidence\n\s+if: success\(\)\n\s+continue-on-error: true/,
  )
  assert.match(
    workflow,
    /name: Upload successful commit-scoped CI quality ledger\n\s+if: success\(\)\n\s+continue-on-error: true/,
  )
  assert.match(workflow, /name: Upload failed runtime diagnostics[\s\S]*retention-days: 7/)
  assert.match(workflow, /name: Upload failed quality diagnostics[\s\S]*retention-days: 7/)
  assert.match(workflow, /retention-days: \$\{\{ github\.event_name == 'pull_request' && 3 \|\| 14 \}\}/)
  assert.match(workflow, /cache: \$\{\{ github\.ref_type != 'tag' && 'npm' \|\| '' \}\}/)
  assert.match(workflow, /cache-to: \$\{\{ github\.ref_type != 'tag' && 'type=gha,mode=max,scope=mbox-normalized-runtime' \|\| '' \}\}/)
  assert.doesNotMatch(workflow, /github\.ref_type == 'tag' && '' \|\|/)
  assert.match(workflow, /name: Upload the exact image used by validation and deployment\n\s+if: github\.ref_type != 'tag'\n\s+continue-on-error: true/)
  assert.match(workflow, /name: Download full-scope runtime evidence[\s\S]*continue-on-error: true/)
  assert.doesNotMatch(workflow, /refs\/heads\/refs\/tags/)
  assert.match(workflow, /name: Publish pull-request quality evidence summary/)
  assert.match(workflow, /cat artifacts\/quality-evidence\/SHA256SUMS/)
  assert.match(workflow, /cat artifacts\/quality-evidence\/ci-quality-evidence\.json/)
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
})

test('tag release builds a checksummed transfer bundle without making GitHub the formal archive', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /cache: npm/)
  assert.match(workflow, /name: Build the short-lived OSS transfer bundle/)
  assert.match(workflow, /build-aliyun-evidence-bundle\.mjs/)
  assert.match(workflow, /verify-sensitive-artifacts\.mjs oss-ready-evidence/)
  assert.match(workflow, /name: Upload short-lived OSS transfer bundle\n\s+continue-on-error: true/)
  assert.match(workflow, /retention-days: 14/)
})
