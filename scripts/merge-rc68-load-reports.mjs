import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluatePhaseArrivalSchedules } from './load-workload-model.mjs'

export const requiredRoutePhases = [
  'staff_start', 'reads', 'create_task_live', 'create_quick_order_live',
  'task_action', 'kds_start', 'kds_complete',
]

const expectedLabelsByPhase = {
  staff_start: ['staff_start_api_journey'],
  reads: [
    'bootstrap_role_coverage', 'heartbeat', 'bootstrap_live', 'bootstrap_cached',
    'reservations', 'guest_session', 'guest_session_repeat',
  ],
  create_task_live: ['create_task_live'],
  create_quick_order_live: ['create_quick_order_live'],
  task_action: ['task_action'],
  kds_start: ['kds_start'],
  kds_complete: ['kds_complete'],
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function environmentIdentity(manifest) {
  const { phase: _phase, ...sharedWorkload } = manifest?.workload ?? {}
  return JSON.stringify({
    runId: manifest?.runId,
    source: manifest?.source,
    runtime: {
      nodeVersion: manifest?.runtime?.nodeVersion,
      platform: manifest?.runtime?.platform,
      architecture: manifest?.runtime?.architecture,
      osRelease: manifest?.runtime?.osRelease,
      cpuCount: manifest?.runtime?.cpuCount,
      cpuModel: manifest?.runtime?.cpuModel,
      totalMemoryBytes: manifest?.runtime?.totalMemoryBytes,
      instances: manifest?.runtime?.instances,
      databasePoolMax: manifest?.runtime?.databasePoolMax,
      mutationQueueMax: manifest?.runtime?.mutationQueueMax,
      mutationQueueWaitMs: manifest?.runtime?.mutationQueueWaitMs,
      stateReadCacheMs: manifest?.runtime?.stateReadCacheMs,
      postgresImage: manifest?.runtime?.postgresImage,
      postgresImageId: manifest?.runtime?.postgresImageId,
      playwrightVersion: manifest?.runtime?.playwrightVersion,
      chromiumVersion: manifest?.runtime?.chromiumVersion,
    },
    inputs: manifest?.inputs,
    workload: sharedWorkload,
  })
}

export function mergeLoadReports(reports, phaseEvidence, options = {}) {
  if (!Array.isArray(reports) || reports.length !== requiredRoutePhases.length) {
    throw new Error(`独立路由报告必须恰好包含${requiredRoutePhases.length}个阶段`)
  }
  const byPhase = new Map()
  const evidenceByPhase = new Map((phaseEvidence ?? []).map((item) => [item.phase, item]))
  for (const report of reports) {
    const phase = report?.model?.phase
    if (!requiredRoutePhases.includes(phase)) throw new Error(`不允许合并阶段 ${phase ?? '(missing)'}`)
    if (report.model.schemaVersion !== 2) throw new Error(`阶段 ${phase} 的性能报告结构版本不受支持`)
    if (report.model.evidenceEligible !== true) throw new Error(`阶段 ${phase} 不具备发布证据资格`)
    const schedules = evaluatePhaseArrivalSchedules(
      report.model.arrivalMetrics,
      report.model.setupArrivalMetrics,
      report.model.schedulingDelayP95LimitMs,
    )
    if (digest(report.model.measuredSchedule) !== digest(schedules.measuredSchedule)
      || digest(report.model.setupSchedule) !== digest(schedules.setupSchedule)
      || digest(report.model.schedule) !== digest(schedules.measuredSchedule)) {
      throw new Error(`阶段 ${phase} 的到达调度门禁与原始指标不一致`)
    }
    if (byPhase.has(phase)) throw new Error(`阶段 ${phase} 重复`)
    byPhase.set(phase, report)
  }
  const missing = requiredRoutePhases.filter((phase) => !byPhase.has(phase))
  if (missing.length) throw new Error(`缺少独立阶段：${missing.join('、')}`)
  const missingEvidence = requiredRoutePhases.filter((phase) => !evidenceByPhase.has(phase))
  if (missingEvidence.length) throw new Error(`缺少阶段运行指标或日志证据：${missingEvidence.join('、')}`)

  const byLabel = {}
  const arrivalMetrics = {}
  const setupArrivalMetrics = {}
  const setupCapacityProbeGates = {}
  const failures = []
  let measured = 0
  let responseFailures = 0
  let workflowFailures = 0
  const phaseGates = {}
  for (const phase of requiredRoutePhases) {
    const report = byPhase.get(phase)
    const evidence = evidenceByPhase.get(phase)
    const runtimePassed = evidence.runtimeMetrics?.passed === true
    const logSelectionPassed = evidence.logAnalysis?.selection?.testStage === 'measured'
      && evidence.logAnalysis?.selection?.testPhase === phase
    const logsPassed = evidence.logAnalysis?.gate?.passed === true && logSelectionPassed
    const browserRequired = phase === 'staff_start' || phase === 'reads'
    const expectedBrowserMode = phase === 'staff_start' ? 'staff' : phase === 'reads' ? 'guest' : null
    const expectedBrowserPhase = phase === 'staff_start' ? 'browser_staff' : phase === 'reads' ? 'browser_guest' : null
    const browserPassed = !browserRequired || (
      evidence.browserStartup?.passed === true
      && evidence.browserStartup?.mode === expectedBrowserMode
      && evidence.browserStartup?.measurementClass === 'fresh_browser_context_page_readiness'
      && evidence.browserStartup?.testStage === 'measured'
      && evidence.browserStartup?.testPhase === expectedBrowserPhase
    )
    const sourceCommitSha = evidence.environment?.source?.commitSha ?? ''
    const expectedCommitPassed = !options.expectedCommitSha || sourceCommitSha === options.expectedCommitSha
    const runIdPassed = typeof evidence.environment?.runId === 'string'
      && evidence.environment.runId.length >= 8
      && report.model?.runId === evidence.environment.runId
    const workloadPassed = report.model?.samplesPerReadOrAction === evidence.environment?.workload?.samplesPerReadOrAction
      && report.model?.arrivalRatesPerSecond?.read === evidence.environment?.workload?.readRps
      && report.model?.arrivalRatesPerSecond?.write === evidence.environment?.workload?.writeRps
    const environmentPassed = evidence.environment?.phase === phase
      && evidence.environment?.source?.dirty === false
      && /^[0-9a-f]{40}$/.test(sourceCommitSha)
      && expectedCommitPassed
      && runIdPassed
      && workloadPassed
    phaseGates[phase] = {
      clientPassed: report.passed === true,
      runtimePassed,
      logsPassed,
      logSelectionPassed,
      browserPassed,
      environmentPassed,
      expectedCommitPassed,
      runIdPassed,
      workloadPassed,
      setupCapacityProbePassed: report.model.setupSchedule.passed === true,
      clientDigest: digest(report),
      runtimeDigest: digest(evidence.runtimeMetrics),
      logDigest: digest(evidence.logAnalysis),
      browserDigest: evidence.browserStartup ? digest(evidence.browserStartup) : null,
      environmentDigest: digest(evidence.environment),
      passed: report.passed === true && runtimePassed && logsPassed && browserPassed && environmentPassed,
    }
    setupArrivalMetrics[phase] = report.model.setupArrivalMetrics
    setupCapacityProbeGates[phase] = report.model.setupSchedule
    for (const label of expectedLabelsByPhase[phase]) {
      const metric = report.byLabel?.[label]
      if (!metric) throw new Error(`阶段 ${phase} 缺少指标 ${label}`)
      if (byLabel[label]) throw new Error(`指标 ${label} 重复`)
      byLabel[label] = metric
      if (report.model?.arrivalMetrics?.[label]) arrivalMetrics[label] = report.model.arrivalMetrics[label]
    }
    measured += report.totals?.measured ?? 0
    responseFailures += report.totals?.failures ?? 0
    workflowFailures += report.totals?.workflowFailures ?? 0
    failures.push(...(report.failureSamples ?? []).map((failure) => ({ phase, ...failure })))
  }

  const first = reports[0]
  const environmentIdentities = requiredRoutePhases.map((phase) => environmentIdentity(evidenceByPhase.get(phase).environment))
  const environmentConsistent = new Set(environmentIdentities).size === 1
  const passed = reports.every((report) => report.passed === true)
    && Object.values(byLabel).every((metric) => metric.passed === true)
    && Object.values(phaseGates).every((gate) => gate.passed === true)
    && environmentConsistent
  return {
    model: {
      profile: 'mbox-pr-route-regression-isolated-v1',
      instances: first.model.instances,
      samplesPerReadOrAction: first.model.samplesPerReadOrAction,
      phases: requiredRoutePhases,
      evidenceEligible: true,
      independentBaselinePerPhase: true,
      environmentConsistent,
      sourceCommitSha: evidenceByPhase.get(requiredRoutePhases[0]).environment?.source?.commitSha ?? null,
      runId: evidenceByPhase.get(requiredRoutePhases[0]).environment?.runId ?? null,
      arrivalMetrics,
      setupArrivalMetrics,
      setupCapacityProbeGates,
      workloadInterpretation: '提交级独立路由回归；每个阶段使用全新数据库基线，不代表正式容量上限',
    },
    phaseGates,
    totals: { measured, failures: responseFailures, workflowFailures },
    byLabel,
    failureSamples: failures.slice(0, 20),
    passed,
  }
}

async function main() {
  const outputIndex = process.argv.indexOf('--output')
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
  const phaseDirs = process.argv.flatMap((value, index) => (
    value === '--phase-dir' && process.argv[index + 1] ? [process.argv[index + 1]] : []
  ))
  const expectedCommitIndex = process.argv.indexOf('--expected-commit')
  const expectedCommitSha = expectedCommitIndex >= 0 ? process.argv[expectedCommitIndex + 1] : undefined
  if (!output || phaseDirs.length === 0) {
    throw new Error('Usage: node scripts/merge-rc68-load-reports.mjs --phase-dir <directory>... --output <file>')
  }
  const bundles = await Promise.all(phaseDirs.map(async (directory) => {
    const root = resolve(directory)
    const report = JSON.parse(await readFile(resolve(root, 'client-observed-load.json'), 'utf8'))
    const browserPath = resolve(root, 'browser-startup.json')
    return {
      report,
      evidence: {
        phase: report.model?.phase,
        runtimeMetrics: JSON.parse(await readFile(resolve(root, 'runtime-metrics.json'), 'utf8')),
        logAnalysis: JSON.parse(await readFile(resolve(root, 'server-observed-log-analysis.json'), 'utf8')),
        environment: JSON.parse(await readFile(resolve(root, 'environment-manifest.json'), 'utf8')),
        browserStartup: existsSync(browserPath) ? JSON.parse(await readFile(browserPath, 'utf8')) : null,
      },
    }
  }))
  if (expectedCommitSha && !/^[0-9a-f]{40}$/.test(expectedCommitSha)) {
    throw new Error('--expected-commit必须是40位小写Git SHA')
  }
  const merged = mergeLoadReports(
    bundles.map((bundle) => bundle.report),
    bundles.map((bundle) => bundle.evidence),
    { expectedCommitSha },
  )
  const serialized = `${JSON.stringify(merged, null, 2)}\n`
  await writeFile(resolve(output), serialized, 'utf8')
  process.stdout.write(serialized)
  if (!merged.passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
