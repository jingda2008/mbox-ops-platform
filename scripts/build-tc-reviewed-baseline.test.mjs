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
  for (const line of lines) {
    assert.match(line, /^(?:[A-Z]{3}-\d{3}|NC-[A-Z]+-\d{3}|AR\d{2}-\d{3})\|P[01]\|[0-9a-f]{64}$/)
  }
})

test('tag release downloads and verifies exact checksummed CI evidence bundles', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /if \[\[ "\$\{version\}" == \*-rc\.\* \]\]/)
  assert.match(workflow, /npm run tc:verify/)
  assert.match(workflow, /npm run release:quality-gate/)
  assert.match(workflow, /gh release download "\$\{GITHUB_REF_NAME\}"/)
  assert.match(workflow, /quality-evidence-\$\{GITHUB_SHA\}\.tar\.gz/)
  assert.match(workflow, /runtime-quality-\$\{GITHUB_SHA\}\.tar\.gz/)
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
  assert.match(workflow, /cache: \$\{\{ github\.event_name == 'push' && github\.ref_type != 'tag' && 'npm' \|\| '' \}\}/)
  assert.match(workflow, /cache-to: \$\{\{ github\.event_name == 'push' && github\.ref_type != 'tag' && 'type=gha,mode=max,scope=mbox-normalized-runtime' \|\| '' \}\}/)
  assert.doesNotMatch(workflow, /github\.ref_type == 'tag' && '' \|\|/)
  assert.match(workflow, /name: Upload the exact image used by validation and deployment\n\s+if: github\.ref_type != 'tag'\n\s+continue-on-error: true/)
  assert.match(workflow, /name: Download full-scope runtime evidence[\s\S]*continue-on-error: true/)
  assert.match(workflow, /name: Materialize tag runtime evidence without Actions artifacts/)
  assert.match(workflow, /name: Stage checksummed tag evidence in the pre-release/)
  assert.match(workflow, /gh release upload "\$\{GITHUB_REF_NAME\}" release-evidence\/\* --clobber/)
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

test('Alibaba Cloud deployment prefers release evidence and keeps Actions artifacts as a legacy fallback', async () => {
  const deploy = await readFile(new URL('../deploy/aliyun/deploy-release.sh', import.meta.url), 'utf8')
  assert.match(deploy, /quality-evidence-\$\{release_sha\}\.tar\.gz/)
  assert.match(deploy, /runtime-quality-\$\{release_sha\}\.tar\.gz/)
  assert.match(deploy, /shasum -a 256 -c "\$\{quality_archive\}\.sha256"/)
  assert.match(deploy, /shasum -a 256 -c "\$\{runtime_archive\}\.sha256"/)
  assert.match(deploy, /gh run download "\$\{MBOX_CI_RUN_ID\}" --name "quality-evidence-\$\{release_sha\}"/)
  assert.match(deploy, /gh run download "\$\{MBOX_CI_RUN_ID\}" --name "runtime-quality-\$\{release_sha\}"/)
  assert.match(deploy, /deploymentScripts/)
  assert.match(deploy, /'\$\{remote_release_dir\}\/activate-release\.sh'/)
  assert.doesNotMatch(deploy, /< deploy\/aliyun\/activate-release\.sh/)
})

test('Alibaba Cloud activation runs only the migrator shipped by the normalized image', async () => {
  const activation = await readFile(new URL('../deploy/aliyun/activate-release.sh', import.meta.url), 'utf8')
  assert.match(activation, /node dist-normalized\/server\/migrate-normalized\.js/)
  assert.doesNotMatch(activation, /node dist-server\/server\/migrate\.js/)
})
