export function validateArrivalProfile(profile) {
  const entries = Object.entries(profile)
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}必须是正数`)
  }
  if (!Number.isSafeInteger(profile.maxConcurrency)) {
    throw new Error('maxConcurrency必须是正整数')
  }
  return profile
}

function wait(milliseconds) {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const ordered = values.toSorted((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0
}

export async function runArrivalPool(items, worker, options) {
  const profile = validateArrivalProfile(options)
  const intervalMs = 1_000 / profile.requestsPerSecond
  const startedAt = performance.now()
  const active = new Set()
  const failures = []
  const schedulingDelays = []
  const launchTimes = []
  let maximumConcurrency = 0

  for (let index = 0; index < items.length; index += 1) {
    const dueAt = startedAt + index * intervalMs
    await wait(dueAt - performance.now())
    while (active.size >= profile.maxConcurrency) await Promise.race(active)
    const launchedAt = performance.now()
    schedulingDelays.push(Math.max(0, launchedAt - dueAt))
    launchTimes.push(launchedAt)
    const pending = Promise.resolve()
      .then(() => worker(items[index], index))
      .catch((error) => {
        failures.push({ index, message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => active.delete(pending))
    active.add(pending)
    maximumConcurrency = Math.max(maximumConcurrency, active.size)
  }
  await Promise.all(active)
  const durationMs = Math.max(0, performance.now() - startedAt)
  const launchDurationMs = launchTimes.length <= 1 ? 0 : launchTimes.at(-1) - launchTimes[0]
  const achievedLaunchRps = launchDurationMs === 0
    ? profile.requestsPerSecond
    : (items.length - 1) / (launchDurationMs / 1_000)
  const missedArrivalCount = schedulingDelays.filter((delay) => delay > intervalMs).length
  return {
    failures,
    metrics: {
      requests: items.length,
      targetRps: profile.requestsPerSecond,
      achievedLaunchRps,
      completionThroughputRps: durationMs === 0 ? 0 : items.length / (durationMs / 1_000),
      durationMs,
      launchDurationMs,
      arrivalIntervalMs: intervalMs,
      maximumConcurrency,
      missedArrivalCount,
      schedulingDelayP95Ms: percentile(schedulingDelays, 0.95),
      schedulingDelayP99Ms: percentile(schedulingDelays, 0.99),
      schedulingDelayMaxMs: Math.max(0, ...schedulingDelays),
    },
  }
}

export function evaluateArrivalSchedule(metricsByLabel, p95LimitMs) {
  if (!Number.isFinite(p95LimitMs) || p95LimitMs <= 0) throw new Error('p95LimitMs必须是正数')
  const failedLabels = Object.entries(metricsByLabel)
    .filter(([, metric]) => {
      const interval = metric?.arrivalIntervalMs
      const p95Limit = Number.isFinite(interval) ? Math.min(p95LimitMs, interval * 0.5) : p95LimitMs
      const p99Limit = Number.isFinite(interval) ? Math.min(p95LimitMs * 2, interval) : p95LimitMs * 2
      return !Number.isFinite(metric?.schedulingDelayP95Ms)
        || metric.schedulingDelayP95Ms > p95Limit
        || !Number.isFinite(metric?.schedulingDelayP99Ms)
        || metric.schedulingDelayP99Ms > p99Limit
        || !Number.isFinite(metric?.achievedLaunchRps)
        || metric.achievedLaunchRps < metric.targetRps * 0.98
        || metric.missedArrivalCount !== 0
    })
    .map(([label]) => label)
  return { passed: failedLabels.length === 0, failedLabels }
}

export function evaluatePhaseArrivalSchedules(measuredMetrics, setupMetrics, p95LimitMs) {
  const measuredSchedule = evaluateArrivalSchedule(measuredMetrics, p95LimitMs)
  const setupSchedule = evaluateArrivalSchedule(setupMetrics, p95LimitMs)
  return {
    measuredSchedule,
    setupSchedule,
  }
}

export function describeVenueWorkload(options = {}) {
  const guests = options.guests ?? 300
  const employees = options.employees ?? 12
  const operatingHours = options.operatingHours ?? 5.5
  const arrivalBurstMultiplier = options.arrivalBurstMultiplier ?? 10
  const testWindowSeconds = options.testWindowSeconds ?? options.compressedWindowSeconds ?? 300
  if (!Number.isFinite(testWindowSeconds) || testWindowSeconds <= 0) {
    throw new Error('testWindowSeconds必须是正数')
  }
  const guestArrivalsPerSecond = guests / (operatingHours * 60 * 60)
  const employeeHeartbeatsPerSecond = employees / 45
  return {
    modelType: 'representative_peak_window',
    guests,
    employees,
    operatingHours,
    testWindowSeconds,
    fullNightCompressionReferenceFactor: (operatingHours * 60 * 60) / testWindowSeconds,
    equivalentToCompressedFullNight: false,
    guestArrivalsPerSecond,
    tenTimesGuestArrivalBurstPerSecond: guestArrivalsPerSecond * arrivalBurstMultiplier,
    testGuestSessionArrivalPerSecond: guests / testWindowSeconds,
    employeeHeartbeatsPerSecond,
  }
}

export function describeKdsWriteProfile(options = {}) {
  const guests = options.guests ?? 300
  const operatingHours = options.operatingHours ?? 5.5
  const estimatedItemsPerGuest = options.estimatedItemsPerGuest ?? 3
  const transitionsPerItem = options.transitionsPerItem ?? 4
  const representativeRegressionRps = options.representativeRegressionRps ?? 2
  const capacityProbeRps = options.capacityProbeRps ?? 5
  for (const [name, value] of Object.entries({
    guests,
    operatingHours,
    estimatedItemsPerGuest,
    transitionsPerItem,
    representativeRegressionRps,
    capacityProbeRps,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}必须是正数`)
  }
  const estimatedFullNightTransitions = guests * estimatedItemsPerGuest * transitionsPerItem
  const estimatedFullNightAverageRps = estimatedFullNightTransitions / (operatingHours * 60 * 60)
  return {
    modelType: 'explicit_assumption_not_production_observation',
    guests,
    operatingHours,
    estimatedItemsPerGuest,
    transitionsPerItem,
    estimatedFullNightTransitions,
    estimatedFullNightAverageRps,
    representativeRegressionRps,
    capacityProbeRps,
    representativeMultiplier: representativeRegressionRps / estimatedFullNightAverageRps,
    capacityProbeMultiplier: capacityProbeRps / estimatedFullNightAverageRps,
  }
}

export function selectAuthorizedOccupiedTables(tablesByActorId, staffSessionByActorId) {
  if (!(tablesByActorId instanceof Map)) throw new Error('员工可见桌台目录必须是Map')
  if (!(staffSessionByActorId instanceof Map)) throw new Error('员工会话目录必须是Map')
  const selected = new Map()
  for (const [actorId, tables] of tablesByActorId) {
    if (!staffSessionByActorId.has(actorId) || !Array.isArray(tables)) continue
    for (const table of tables) {
      if (table?.status !== 'occupied' || typeof table.id !== 'string' || typeof table.code !== 'string') continue
      const current = selected.get(table.id)
      if (!current || table.primaryEmployeeId === actorId) {
        selected.set(table.id, { id: table.id, code: table.code, actorId })
      }
    }
  }
  return [...selected.values()]
}
