import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { qualityPolicyDigest } from './verify-quality-evidence.mjs'

const scope = process.env.MBOX_CI_SCOPE?.trim() || 'full'
const results = JSON.parse(process.env.MBOX_CI_RESULTS_JSON ?? '{}')
const releaseArtifactRequired = process.env.MBOX_CI_RELEASE_ARTIFACT_REQUIRED === 'true'
const output = resolve(process.env.MBOX_CI_EVIDENCE_PATH ?? 'artifacts/quality-evidence/ci-quality-evidence.json')
const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const qualityPolicy = JSON.parse(await readFile('docs/quality-policy-mbox-v1.json', 'utf8'))
const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const sourceHeadSha = process.env.MBOX_CI_SOURCE_HEAD_SHA?.trim() || checkedOutSha
const generatedAt = new Date().toISOString()
const environmentId = `github-actions:${process.env.GITHUB_RUN_ID ?? 'unknown'}`
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkedOutSha) {
  throw new Error(`Checked-out commit ${checkedOutSha} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`)
}

const selectedByScope = {
  docs: ['docs'],
  ui: ['fast_quality', 'normalized_browser'],
  frontend: ['fast_quality', 'normalized_browser'],
  full: ['quality', 'normalized_database', 'normalized_browser', 'performance'],
}
const selected = [...(selectedByScope[scope] ?? selectedByScope.full)]
if (releaseArtifactRequired) selected.push('image')

function normalizedRunStatus(result) {
  if (result === 'success') return 'pass'
  if (result === 'failure') return 'fail'
  if (result === 'cancelled') return 'blocked'
  return 'not_run'
}

function normalizedArtifactStatus(result) {
  if (result === 'skipped') return 'not_applicable'
  if (['success', 'failure', 'cancelled'].includes(result)) return 'available'
  return 'missing'
}

const testRuns = selected.map((id) => {
  const status = normalizedRunStatus(results[id])
  return {
    id,
    kind: id === 'performance' ? 'performance-gate' : id,
    required: true,
    status,
    artifactStatus: normalizedArtifactStatus(results[id]),
    validityStatus: 'valid',
    total: 1,
    passed: status === 'pass' ? 1 : 0,
    failed: status === 'fail' ? 1 : 0,
    blocked: status === 'blocked' ? 1 : 0,
    notRun: status === 'not_run' ? 1 : 0,
    evidence: [id === 'performance'
      ? process.env.GITHUB_EVENT_NAME === 'pull_request'
        ? `github-job:performance:${process.env.GITHUB_RUN_ID}`
        : `artifact:runtime-quality-${process.env.GITHUB_SHA}`
      : `github-job:${id}:${process.env.GITHUB_RUN_ID ?? 'unknown'}`],
  }
})

const performance = []
const encodedBrowserStartup = process.env.MBOX_CI_BROWSER_STARTUP_EVIDENCE_BASE64?.trim()
if (scope === 'full' && (results.normalized_browser === 'success' || encodedBrowserStartup)) {
  if (!encodedBrowserStartup) throw new Error('规范化浏览器任务通过但缺少启动性能证据')
  const startup = JSON.parse(Buffer.from(encodedBrowserStartup, 'base64').toString('utf8'))
  performance.push(...browserStartupRecords(startup, {
    checkedOutSha,
    environmentId,
    evidenceReference: `github-job:normalized_browser:${process.env.GITHUB_RUN_ID ?? 'unknown'}`,
  }))
}
const encodedLoad = process.env.MBOX_CI_LOAD_EVIDENCE_BASE64?.trim()
if (scope === 'full' && (results.performance === 'success' || encodedLoad)) {
  const loadPath = resolve(process.env.MBOX_CI_LOAD_EVIDENCE_PATH ?? 'artifacts/runtime-quality/client-observed-load.json')
  const load = encodedLoad
    ? JSON.parse(Buffer.from(encodedLoad, 'base64').toString('utf8'))
    : JSON.parse(await readFile(loadPath, 'utf8'))
  performance.push(...performanceRecords(load, {
    checkedOutSha,
    environmentId,
    evidenceReference: process.env.GITHUB_EVENT_NAME === 'pull_request'
      ? `github-job:performance:${process.env.GITHUB_RUN_ID}`
      : `artifact:runtime-quality-${process.env.GITHUB_SHA}/client-observed-load.json`,
  }))
}

function browserStartupRecords(report, context) {
  if (report.schemaVersion !== 'normalized-browser-startup-v1'
    || report.run?.mode !== 'real_browser_isolated_postgres'
    || report.run?.evidenceEligible !== true
    || report.workload?.freshBrowserContextPerSample !== true
    || report.workload?.employeeSessionPreparedOutsideMeasurement !== true
    || report.workload?.guestSessionPreparedOutsideMeasurement !== true
    || report.workload?.staticTableQrScanCoveredByCommercialFlow !== true) {
    throw new Error('规范化启动性能证据必须来自独立数据库上的全新真实浏览器上下文')
  }
  if (report.run?.sourceCommitSha !== context.checkedOutSha) {
    throw new Error(`规范化启动性能证据提交 ${report.run?.sourceCommitSha ?? '(missing)'} 与检出提交不一致`)
  }
  if (report.gate?.passed !== true) throw new Error('规范化启动性能总门禁未通过')
  const thresholds = report.gate?.thresholds ?? {}
  const entries = [
    ['normalized_employee_startup', report.metrics?.employeeStartup, 'authenticated_employee_workspace', 'browser'],
    ['normalized_guest_session_startup', report.metrics?.guestSessionStartup, 'established_guest_session_menu', 'browser'],
    ['normalized_employee_startup_api', report.metrics?.employeeStartup, 'authenticated_employee_workspace_api', 'api'],
    ['normalized_guest_session_api', report.metrics?.guestSessionStartup, 'established_guest_session_api', 'api'],
  ]
  return entries.map(([id, metric, route, measurement]) => {
    if (!metric || metric.samples < 30 || metric.failures !== 0) throw new Error(`${id} 启动性能证据不完整`)
    const latency = measurement === 'api'
      ? {
          p50Ms: metric.criticalApiPathP50Ms,
          p95Ms: metric.criticalApiPathP95Ms,
          p99Ms: metric.criticalApiPathP99Ms,
          maxMs: metric.criticalApiPathMaxMs,
        }
      : { p50Ms: metric.p50Ms, p95Ms: metric.p95Ms, p99Ms: metric.p99Ms, maxMs: metric.maxMs }
    if (Object.values(latency).some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`${id} 启动性能时钟不完整`)
    }
    return {
      id,
      required: true,
      conclusionLevel: 'regression',
      status: latency.p95Ms <= thresholds.p95Ms && latency.p99Ms <= thresholds.p99Ms ? 'pass' : 'fail',
      artifactStatus: 'available',
      validityStatus: 'valid',
      samples: metric.samples,
      successful: metric.successful,
      failures: metric.failures,
      ...latency,
      limits: { minSamples: thresholds.minimumSamples, p95Ms: thresholds.p95Ms, p99Ms: thresholds.p99Ms },
      environmentRef: context.environmentId,
      workload: {
        profile: 'mbox-normalized-browser-startup-v1',
        model: 'fresh-browser-context',
        route,
        instances: 1,
        targetRps: null,
        achievedLaunchRps: null,
        maxConcurrency: 1,
        schedulingDelayP95Ms: null,
      },
      evidence: [context.evidenceReference],
    }
  })
}

function performanceRecords(load, context) {
  if (load.schemaVersion === 'normalized-load-acceptance-v2') {
    if (load.run?.mode !== 'http_isolated_postgres'
      || load.run?.evidenceEligible !== true
      || load.workload?.independentDatabasePerRun !== true) {
      throw new Error('规范化性能证据必须来自独立新建数据库上的真实HTTP服务')
    }
    if (load.run?.sourceCommitSha !== context.checkedOutSha) {
      throw new Error(`规范化性能证据提交 ${load.run?.sourceCommitSha ?? '(missing)'} 与检出提交不一致`)
    }
    if (load.gate?.passed !== true) {
      throw new Error('规范化性能证据总门禁未通过')
    }
    const requiredServerChecks = [
      'database.pool_acquisition_failures',
      'database.pool_wait_p95',
      'database.pool_wait_p99',
      'database.pool_waiting_at_end',
      'database.transaction_failures',
      'database.transaction_p95',
      'database.transaction_p99',
      'database.query_failures',
      'database.query_p95',
      'database.query_p99',
    ]
    const checkById = new Map((load.gate?.checks ?? []).map((check) => [check.id, check]))
    if (requiredServerChecks.some((id) => checkById.get(id)?.passed !== true)) {
      throw new Error('规范化性能证据缺少已通过的服务端数据库门禁')
    }
    const database = load.serverMetrics?.database
    if (!database?.pool || !database?.transactions || !database?.queries) {
      throw new Error('规范化性能证据缺少服务端数据库指标')
    }
    const thresholds = load.gate?.thresholds ?? {}
    const routeRecords = Object.entries(load.scenarios ?? {}).map(([name, scenario]) => {
      const id = `normalized_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`
      const scenarioChecks = (load.gate?.checks ?? []).filter((check) => check.id?.startsWith(`${name}.`))
      const summary = scenario.summary ?? {}
      const latency = summary.latencyMs ?? {}
      return {
        id,
        required: true,
        conclusionLevel: 'regression',
        status: summary.errors === 0 && scenarioChecks.length > 0 && scenarioChecks.every((check) => check.passed)
          ? 'pass' : 'fail',
        artifactStatus: 'available',
        validityStatus: 'valid',
        samples: summary.requests,
        successful: summary.successes,
        failures: summary.errors,
        p50Ms: latency.p50,
        p95Ms: latency.p95,
        p99Ms: latency.p99,
        maxMs: latency.max,
        limits: {
          minSamples: load.workload?.requestsPerScenario ?? 300,
          p95Ms: thresholds.maximumP95Ms,
          p99Ms: thresholds.maximumP99Ms,
        },
        environmentRef: context.environmentId,
        workload: {
          profile: 'mbox-normalized-core-regression-v1',
          model: 'open-arrival-rate',
          route: name,
          instances: 1,
          targetRps: scenario.arrival?.targetRps,
          achievedLaunchRps: scenario.arrival?.achievedLaunchRps,
          maxConcurrency: scenario.arrival?.maximumConcurrency,
          schedulingDelayP95Ms: scenario.arrival?.schedulingDelayP95Ms,
        },
        evidence: [context.evidenceReference],
      }
    })
    return [
      ...routeRecords,
      serverMetricRecord('normalized_database_pool_acquire', database.pool.acquisitionWaitMs, {
        failures: database.pool.acquisitionFailures,
        p95Ms: 50,
        p99Ms: 100,
      }, context),
      serverMetricRecord('normalized_database_transaction', database.transactions.durationMs, {
        failures: database.transactions.failed,
        p95Ms: 500,
        p99Ms: 1_000,
      }, context),
      serverMetricRecord('normalized_database_query', database.queries.durationMs, {
        failures: database.queries.failed,
        p95Ms: 250,
        p99Ms: 500,
      }, context),
    ]
  }

  if (load.model?.evidenceEligible !== true || load.model?.independentBaselinePerPhase !== true) {
    throw new Error('性能发布证据必须来自独立数据库基线的分阶段路由套件')
  }
  return Object.entries(load.byLabel ?? {}).map(([id, metric]) => {
    const arrival = load.model?.arrivalMetrics?.[id]
    return {
      id,
      required: true,
      conclusionLevel: 'regression',
      status: metric.passed ? 'pass' : 'fail',
      artifactStatus: 'available',
      validityStatus: 'valid',
      samples: metric.samples,
      successful: metric.successful,
      failures: metric.failures,
      p50Ms: metric.p50Ms,
      p95Ms: metric.p95Ms,
      p99Ms: metric.p99Ms,
      maxMs: metric.maxMs,
      limits: { minSamples: metric.target?.minSamples ?? load.model?.samplesPerReadOrAction ?? 300, p95Ms: metric.target.p95, p99Ms: metric.target.p99 },
      environmentRef: context.environmentId,
      workload: {
        profile: 'mbox-pr-route-regression-v1',
        model: id === 'bootstrap_role_coverage'
          ? 'bounded-role-coverage'
          : arrival ? 'open-arrival-rate' : 'bounded-independent-request',
        route: id,
        instances: load.model?.instances ?? null,
        targetRps: arrival?.targetRps ?? null,
        achievedLaunchRps: arrival?.achievedLaunchRps ?? null,
        maxConcurrency: arrival?.maximumConcurrency ?? null,
        schedulingDelayP95Ms: arrival?.schedulingDelayP95Ms ?? null,
      },
      evidence: [context.evidenceReference],
    }
  })
}

function serverMetricRecord(id, duration, limits, context) {
  const samples = Number(duration?.samples ?? 0)
  const failures = Number(limits.failures ?? 0)
  return {
    id,
    required: true,
    conclusionLevel: 'regression',
    status: samples > 0 && failures === 0
      && duration.p95 <= limits.p95Ms && duration.p99 <= limits.p99Ms ? 'pass' : 'fail',
    artifactStatus: 'available',
    validityStatus: 'valid',
    samples,
    successful: Math.max(0, samples - failures),
    failures,
    p50Ms: duration.p50,
    p95Ms: duration.p95,
    p99Ms: duration.p99,
    maxMs: duration.max,
    limits: { minSamples: 1, p95Ms: limits.p95Ms, p99Ms: limits.p99Ms },
    environmentRef: context.environmentId,
    workload: {
      profile: 'mbox-normalized-core-regression-v1',
      model: 'server-telemetry',
      route: id,
      instances: 1,
      targetRps: null,
      achievedLaunchRps: null,
      maxConcurrency: null,
      schedulingDelayP95Ms: null,
    },
    evidence: [context.evidenceReference],
  }
}

const allSelectedPassed = testRuns.every((run) => run.status === 'pass')
  && performance.every((metric) => metric.status === 'pass')
const document = {
  schemaVersion: 2,
  project: process.env.GITHUB_REPOSITORY ?? packageDocument.name,
  version: packageDocument.version,
  qualityProfile: {
    id: `mbox-${scope}-release-v1`,
    policyRef: `${qualityPolicy.id}@sha256:${qualityPolicyDigest(qualityPolicy)}`,
  },
  generatedAt,
  decision: allSelectedPassed ? 'ALLOW' : 'DENY',
  source: {
    commitSha: checkedOutSha,
    proposedHeadSha: sourceHeadSha,
    dirty,
    ref: process.env.GITHUB_REF ?? null,
  },
  environment: { id: environmentId, name: 'github-actions', scope },
  ci: {
    provider: 'github-actions',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
  },
  requiredGateIds: [...selected, ...performance.map((metric) => metric.id)],
  testRuns,
  performance,
  notes: releaseArtifactRequired
    ? ['CI image bundle is produced separately and contains its immutable image digest.']
    : ['This ledger proves source-level CI gates; it is not deployment or field-acceptance evidence.'],
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
