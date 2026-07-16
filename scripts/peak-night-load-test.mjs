const baseUrl = (process.env.MBOX_LOAD_BASE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '')
const storeId = process.env.MBOX_LOAD_STORE_ID ?? 'mbox-lujiazui'
const concurrency = Number(process.env.MBOX_LOAD_CONCURRENCY ?? 40)
const tableCodes = (process.env.MBOX_LOAD_TABLE_CODES ?? 'L01,L02,I01,I02,S01,W01,B01').split(',')
const actorIds = (process.env.MBOX_LOAD_ACTORS ?? 'emp-lin,emp-wu,emp-qing,emp-han,emp-tao,emp-mia,emp-chen,emp-cashier,emp-host,emp-jie,emp-owner,emp-admin').split(',')

const observations = []

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

async function measured(label, path, init = {}) {
  const startedAt = performance.now()
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, init)
    const body = await response.text()
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10
    observations.push({ label, status: response.status, elapsedMs })
    if (!response.ok) throw new Error(`${label} ${response.status}: ${body.slice(0, 240)}`)
    return body ? JSON.parse(body) : null
  } catch (error) {
    if (!response) {
      observations.push({ label, status: 0, elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10 })
    }
    throw error
  }
}

async function runPool(items, worker) {
  let cursor = 0
  const failures = []
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        await worker(items[index], index)
      } catch (error) {
        failures.push({ index, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }))
  return failures
}

function jsonBody(body) {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const health = await measured('health', '/api/health')
const sessions = new Map()
for (const tableCode of tableCodes) {
  sessions.set(tableCode, await measured('guest_session_seed', `/api/guest/session?table=${encodeURIComponent(tableCode)}`))
}

const guestVisits = Array.from({ length: 300 }, (_, index) => ({
  index,
  tableCode: tableCodes[index % tableCodes.length],
  simulatedArrivalMinute: Math.floor(index * 330 / 300),
}))
const guestReadFailures = await runPool(guestVisits, async ({ tableCode }) => {
  await measured('guest_session_read', `/api/guest/session?table=${encodeURIComponent(tableCode)}`)
})

const parties = Array.from({ length: 75 }, (_, index) => ({
  index,
  tableCode: tableCodes[index % tableCodes.length],
  guestCount: 4,
  simulatedArrivalMinute: Math.floor(index * 330 / 75),
}))
const createdOrders = new Array(parties.length)
const orderFailures = await runPool(parties, async (party, index) => {
  const session = sessions.get(party.tableCode)
  createdOrders[index] = await measured('guest_order', '/api/guest/orders', {
    method: 'POST',
    ...jsonBody({
      tableToken: session.tableToken,
      items: [{ productId: index % 3 === 0 ? 'product-fruit' : 'product-cocktail', quantity: index % 4 === 0 ? 2 : 1 }],
      idempotencyKey: `peak-night-order-${String(index).padStart(4, '0')}`,
    }),
  })
})

const checkoutFailures = await runPool(parties, async (party, index) => {
  if (!createdOrders[index]) return
  const session = sessions.get(party.tableCode)
  await measured('guest_checkout', '/api/guest/checkout', {
    method: 'POST',
    ...jsonBody({
      tableToken: session.tableToken,
      orderId: createdOrders[index].id,
      idempotencyKey: `peak-night-checkout-${String(index).padStart(4, '0')}`,
    }),
  })
})

const serviceRequests = Array.from({ length: 35 }, (_, index) => ({
  index,
  tableCode: tableCodes[index % tableCodes.length],
}))
const serviceFailures = await runPool(serviceRequests, async ({ index, tableCode }) => {
  const session = sessions.get(tableCode)
  const serviceTypes = session.serviceTypes.filter((item) => item.enabled !== false && item.code !== 'CUSTOM_REQUEST')
  const serviceType = serviceTypes[index % serviceTypes.length]
  await measured('guest_service_call', '/api/guest/tasks', {
    method: 'POST',
    ...jsonBody({
      tableToken: session.tableToken,
      serviceTypeId: serviceType.id,
      note: `300人压力测试需求 ${index + 1}`,
      idempotencyKey: `peak-night-service-${String(index).padStart(4, '0')}`,
    }),
  })
})

const staffPolls = Array.from({ length: 120 }, (_, index) => actorIds[index % actorIds.length])
const staffFailures = await runPool(staffPolls, async (actorId) => {
  await measured('staff_bootstrap', '/api/bootstrap', {
    headers: { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': storeId },
  })
})

const byLabel = Object.fromEntries([...new Set(observations.map((item) => item.label))].map((label) => {
  const rows = observations.filter((item) => item.label === label)
  const times = rows.map((item) => item.elapsedMs)
  return [label, {
    requests: rows.length,
    failures: rows.filter((item) => item.status < 200 || item.status >= 400).length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    p99Ms: percentile(times, 0.99),
    maxMs: Math.max(...times),
  }]
}))
const failures = [...guestReadFailures, ...orderFailures, ...checkoutFailures, ...serviceFailures, ...staffFailures]

const report = {
  model: {
    businessWindow: '20:30-02:00',
    durationMinutes: 330,
    guests: guestVisits.length,
    parties: parties.length,
    averagePartySize: 4,
    averageGuestArrivalsPerHour: Math.round(guestVisits.length / 5.5 * 10) / 10,
    concurrency,
  },
  health,
  totals: {
    requests: observations.length,
    failures: observations.filter((item) => item.status < 200 || item.status >= 400).length,
    workflowFailures: failures.length,
  },
  byLabel,
  failureSamples: failures.slice(0, 10),
}

console.log(JSON.stringify(report, null, 2))
if (report.totals.failures > 0 || report.totals.workflowFailures > 0) process.exitCode = 1
