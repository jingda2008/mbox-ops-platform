import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildEnvironmentFingerprint,
  buildSourceFingerprint,
  verifyBuildProvenance,
} from './build-source-fingerprint.mjs'

test('build-input fingerprint is deterministic and content-addressed', async () => {
  const first = await buildSourceFingerprint()
  const second = await buildSourceFingerprint()
  assert.deepEqual(first, second)
  assert.match(first.digest, /^[0-9a-f]{64}$/)
  assert.ok(first.files > 100)
})

test('build provenance binds public build environment and output content', async () => {
  assert.equal(
    buildEnvironmentFingerprint({ VITE_PUBLIC_ORIGIN: 'a', IGNORED: 'one' }).digest,
    buildEnvironmentFingerprint({ VITE_PUBLIC_ORIGIN: 'a', IGNORED: 'two' }).digest,
  )
  assert.notEqual(
    buildEnvironmentFingerprint({ VITE_PUBLIC_ORIGIN: 'a' }).digest,
    buildEnvironmentFingerprint({ VITE_PUBLIC_ORIGIN: 'b' }).digest,
  )
  const current = {
    schemaVersion: 1,
    source: { digest: 'source' }, environment: { digest: 'environment' },
    output: { digest: 'output' }, provenanceToolSha256: 'tool',
  }
  assert.equal((await verifyBuildProvenance(structuredClone(current), current)).passed, true)
  const stale = structuredClone(current)
  stale.output.digest = 'stale-output'
  assert.deepEqual((await verifyBuildProvenance(stale, current)).failures, ['output'])
})

test('load harness waits until the requested database can execute a query', async () => {
  const source = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  assert.match(source, /psql -U mbox -d mbox_load -Atqc "SELECT 1"/)
  assert.doesNotMatch(source, /pg_isready -U mbox -d mbox_load/)
})

test('every isolated phase receives a docker-assigned postgres port by default', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  const suite = await readFile(new URL('./run-local-rc68-route-suite.sh', import.meta.url), 'utf8')
  assert.match(harness, /--publish "127\.0\.0\.1::5432"/)
  assert.match(harness, /docker port "\$container" 5432\/tcp/)
  assert.doesNotMatch(suite, /MBOX_LOCAL_LOAD_POSTGRES_PORT=/)
})

test('API processes use dynamic ports and readiness is bound to the tested source', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  const suite = await readFile(new URL('./run-local-rc68-route-suite.sh', import.meta.url), 'utf8')
  assert.match(harness, /api_port_1="\$\{MBOX_LOCAL_LOAD_API_PORT_1:-\}"/)
  assert.match(harness, /kill -0 "\$pid"/)
  assert.match(harness, /payload\?\.releaseSha === process\.env\.EXPECTED_SHA/)
  assert.doesNotMatch(suite, /MBOX_LOCAL_LOAD_API_PORT_[12]=/)
})

test('a reused build must match the current build-input fingerprint', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  const suite = await readFile(new URL('./run-local-rc68-route-suite.sh', import.meta.url), 'utf8')
  assert.match(harness, /build-source-fingerprint\.mjs/)
  assert.match(harness, /refusing stale build/)
  assert.match(harness, /rc68-load-build-source\.json/)
  assert.match(harness, /--expected-source/)
  assert.match(harness, /--expected-environment/)
  assert.match(harness, /--verify/)
  assert.match(suite, /if \[ "\$index" = "0" \]; then skip_build=0; fi/)
  assert.match(suite, /MBOX_LOCAL_LOAD_SKIP_BUILD="\$skip_build"/)
  assert.doesNotMatch(suite, /npm run build/)
})

test('environment fingerprint covers the scripts that define and merge the workload', async () => {
  const source = await readFile(new URL('./write-load-environment-manifest.mjs', import.meta.url), 'utf8')
  for (const path of [
    'scripts/load-workload-model.mjs',
    'scripts/build-source-fingerprint.mjs',
    'scripts/run-local-rc68-route-suite.sh',
    'scripts/prepare-rc68-load-state.mjs',
    'scripts/merge-rc68-load-reports.mjs',
  ]) assert.match(source, new RegExp(path.replaceAll('.', '\\.')))
  assert.match(source, /diffSha256/)
  assert.match(source, /buildInputSha256/)
  assert.match(source, /changedPaths/)
})

test('tracked TC artifacts use repository-relative references', async () => {
  const generator = await readFile(new URL('./build-tc-execution-register.mjs', import.meta.url), 'utf8')
  assert.match(generator, /qualitySupplementReference = 'docs\//)
  assert.doesNotMatch(generator, /`见 \$\{qualitySupplementPath\}`/)
  assert.match(generator, /must not contain checkout-specific absolute paths/)
})
