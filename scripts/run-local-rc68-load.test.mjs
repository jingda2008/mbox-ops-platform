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

test('CI reserves enough time for all seven isolated performance phases', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const performanceJob = workflow.match(/\n  performance:\n([\s\S]*?)(?=\n  [a-z_]+:\n)/)?.[1]
  assert.ok(performanceJob, 'performance job must exist')
  const timeoutMinutes = Number(performanceJob.match(/timeout-minutes:\s*(\d+)/)?.[1])
  assert.ok(timeoutMinutes >= 45, `performance timeout ${timeoutMinutes}m cannot cover the seven-phase suite`)
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

test('a load run is invalidated when source changes during measurement', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  assert.match(harness, /final_build_fingerprint="\$\(node scripts\/build-source-fingerprint\.mjs\)"/)
  assert.match(harness, /source_changed_during_measurement/)
  assert.match(harness, /source_drift_status/)
  assert.match(harness, /不得作为发布证据/)
})

test('environment fingerprint covers the scripts that define and merge the workload', async () => {
  const source = await readFile(new URL('./write-load-environment-manifest.mjs', import.meta.url), 'utf8')
  for (const path of [
    'scripts/load-workload-model.mjs',
    'scripts/build-source-fingerprint.mjs',
    'scripts/run-local-rc68-route-suite.sh',
    'scripts/prepare-rc68-load-state.mjs',
    'scripts/load-reference-time.mjs',
    'scripts/merge-rc68-load-reports.mjs',
  ]) assert.match(source, new RegExp(path.replaceAll('.', '\\.')))
  assert.match(source, /diffSha256/)
  assert.match(source, /buildInputSha256/)
  assert.match(source, /changedPaths/)
  assert.match(source, /referenceTime: process\.env\.MBOX_LOAD_REFERENCE_TIME/)
  assert.match(source, /operationalTime: process\.env\.MBOX_LOAD_OPERATIONAL_TIME/)
})

test('all isolated phases share one Shanghai business-date load reference', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  const suite = await readFile(new URL('./run-local-rc68-route-suite.sh', import.meta.url), 'utf8')
  assert.match(harness, /load_reference_time="\$\{MBOX_LOAD_REFERENCE_TIME:-\$\(node scripts\/load-reference-time\.mjs\)\}"/)
  assert.match(harness, /MBOX_LOAD_REFERENCE_TIME="\$load_reference_time"/)
  assert.match(suite, /suite_reference_time="\$\{MBOX_LOAD_REFERENCE_TIME:-\$\(node scripts\/load-reference-time\.mjs\)\}"/)
  assert.match(suite, /MBOX_LOAD_REFERENCE_TIME="\$suite_reference_time"/)
})

test('all isolated phases share one real execution anchor for active table visits', async () => {
  const harness = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  const suite = await readFile(new URL('./run-local-rc68-route-suite.sh', import.meta.url), 'utf8')
  const preparation = await readFile(new URL('./prepare-rc68-load-state.mjs', import.meta.url), 'utf8')
  assert.match(harness, /load_operational_time="\$\{MBOX_LOAD_OPERATIONAL_TIME:-/)
  assert.match(harness, /MBOX_LOAD_OPERATIONAL_TIME="\$load_operational_time"/)
  assert.match(suite, /suite_operational_time="\$\{MBOX_LOAD_OPERATIONAL_TIME:-/)
  assert.match(suite, /MBOX_LOAD_OPERATIONAL_TIME="\$suite_operational_time"/)
  assert.match(preparation, /operationalBusinessDate !== state\.store\.businessDate/)
  assert.match(preparation, /operationalTime\.getTime\(\) - 42 \* 60_000/)
})

test('browser readiness failures preserve diagnostics without logging the table token', async () => {
  const source = await readFile(new URL('./measure-browser-startup.mjs', import.meta.url), 'utf8')
  assert.match(source, /pageState=\$\{JSON\.stringify\(pageState\)\}/)
  assert.match(source, /window\.location\.pathname/)
  assert.match(source, /menuCategoryCount/)
  assert.match(source, /frozenAccountCount/)
  assert.match(source, /guest fixture entered the frozen-account protection state/)
  assert.match(source, /pageErrors=/)
  assert.doesNotMatch(source, /pageState[\s\S]{0,500}window\.location\.href/)
})

test('tracked TC artifacts use repository-relative references', async () => {
  const generator = await readFile(new URL('./build-tc-execution-register.mjs', import.meta.url), 'utf8')
  assert.match(generator, /qualitySupplementReference = 'docs\//)
  assert.doesNotMatch(generator, /`见 \$\{qualitySupplementPath\}`/)
  assert.match(generator, /must not contain checkout-specific absolute paths/)
})

test('KDS completion opens the measured metrics window after preparation', async () => {
  const source = await readFile(new URL('./rc68-mixed-load.mjs', import.meta.url), 'utf8')
  const preparation = source.indexOf("if (phase === 'kds_complete')")
  const reset = source.indexOf('await resetMeasuredMetricsWindow()', preparation)
  const measured = source.indexOf("if (measures('kds_complete'))", preparation)

  assert.ok(preparation >= 0)
  assert.ok(reset > preparation)
  assert.ok(measured > reset)
  assert.match(source, /if \(phase !== 'kds_complete'\) await resetMeasuredMetricsWindow\(\)/)
})

test('setup capacity drift is retained without replacing the measured release schedule', async () => {
  const source = await readFile(new URL('./rc68-mixed-load.mjs', import.meta.url), 'utf8')
  assert.match(source, /evaluatePhaseArrivalSchedules\(/)
  assert.match(source, /schemaVersion: 2/)
  assert.match(source, /evidenceEligible: phase !== 'all'/)
  assert.match(source, /schedule: measuredSchedule/)
})

test('the scheduler uses a cross-instance quiet window with bounded deferral', async () => {
  const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8')
  const repositorySource = await readFile(new URL('../server/postgres-repository.ts', import.meta.url), 'utf8')
  assert.match(source, /const schedulerIdleMs = 750/)
  assert.match(source, /const schedulerIdleWaitMs = 250/)
  assert.match(source, /const schedulerMaximumDeferralMs = 15_000/)
  assert.match(source, /repository\.waitForMutationIdle\(schedulerIdleMs, schedulerIdleWaitMs\)/)
  assert.match(source, /notificationsWouldDispatch/)
  assert.match(source, /sopActionsWouldDispatch/)
  assert.match(source, /minimumGlobalIdleMs/)
  assert.match(repositorySource, /pg_advisory_xact_lock_shared/)
  assert.match(repositorySource, /pg_try_advisory_xact_lock/)
})

test('dirty source paths preserve porcelain leading status columns', async () => {
  const source = await readFile(new URL('./write-load-environment-manifest.mjs', import.meta.url), 'utf8')
  assert.match(source, /status', '--porcelain'\], \{ encoding: 'utf8' \}\)\.trimEnd\(\)/)
  assert.doesNotMatch(source, /--porcelain'\], \{ encoding: 'utf8' \}\)\.trim\(\)/)
})
