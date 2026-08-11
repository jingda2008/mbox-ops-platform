import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { Client } from 'pg'
import { runNormalizedMigrations } from '../server/migrate-normalized.js'
import {
  parseStoreProvisionConfig,
  provisionNormalizedStore,
} from '../server/provision-normalized-store.js'
import {
  parseNormalizedCatalog,
  provisionNormalizedCatalog,
} from '../server/provision-normalized-catalog.js'
import { createNormalizedApp } from '../server/normalized/normalized-app.js'
import { loadNormalizedRuntimeConfig } from '../server/normalized/normalized-runtime-config.js'
import { runNormalizedLoadAcceptance } from './normalized-load-acceptance.mjs'

const adminSource = process.env.TEST_NORMALIZED_ADMIN_URL
if (!adminSource) throw new Error('TEST_NORMALIZED_ADMIN_URL is required')

const storeConfigPath = resolve(process.env.STORE_CONFIG_FILE
  ?? 'deploy/normalized-store/mbox-lujiazui.store.json')
const catalogConfigPath = resolve(process.env.CATALOG_CONFIG_FILE
  ?? 'config/menu-catalog-2026-07-27.json')
const outputPath = resolve(process.env.OUTPUT_FILE ?? '/tmp/normalized-http-acceptance.json')
const commitSha = process.env.APP_COMMIT_SHA ?? '27e9cba12947456ce83f8da16aa4eca63af731cf'
const databaseName = `mbox_normalized_http_${process.pid}_${randomBytes(4).toString('hex')}`
const adminUrl = databaseUrl(adminSource, 'postgres')
const testUrl = databaseUrl(adminSource, databaseName)
const admin = new Client({ connectionString: adminUrl, application_name: 'normalized-http-acceptance-admin' })
let runtime: Awaited<ReturnType<typeof createNormalizedApp>> | null = null
let created = false

try {
  await admin.connect()
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  created = true
  await runNormalizedMigrations(testUrl)

  const store = parseStoreProvisionConfig(JSON.parse(await readFile(storeConfigPath, 'utf8')))
  const catalog = parseNormalizedCatalog(JSON.parse(await readFile(catalogConfigPath, 'utf8')))
  const pinEnvironment = Object.fromEntries(store.employees.map((employee) => [employee.pinEnv, '5210']))
  const dailyCredential = 'MBOX521'
  await provisionNormalizedStore({
    databaseUrl: testUrl,
    config: store,
    environment: { ...pinEnvironment, [store.dailyCredentialEnv ?? 'MBOX_STORE_DAILY_CREDENTIAL']: dailyCredential },
    sourceCommitSha: commitSha,
  })
  await provisionNormalizedCatalog({
    databaseUrl: testUrl,
    tenantId: store.tenant.id,
    storeId: store.store.id,
    catalog,
    sourceCommitSha: commitSha,
  })

  const port = Number(process.env.ACCEPTANCE_PORT ?? 39_127)
  const config = loadNormalizedRuntimeConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testUrl,
    MBOX_TENANT_ID: store.tenant.id,
    MBOX_STORE_ID: store.store.id,
    MBOX_NORMALIZED_SECRET: 'normalized-http-acceptance-secret-only',
    MBOX_GUEST_PAYMENT_MODE: 'simulation',
    MBOX_START_WORKERS: 'false',
    MBOX_DATABASE_POOL_MAX: process.env.MBOX_DATABASE_POOL_MAX ?? '12',
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_COMMIT_SHA: commitSha,
  })
  runtime = await createNormalizedApp({
    config,
    logger: process.env.ACCEPTANCE_DEBUG === 'true' ? true : false,
  })
  await runtime.app.listen({ host: config.host, port: config.port })
  const baseUrl = `http://${config.host}:${config.port}`

  const serviceLogin = await login(baseUrl, dailyCredential, 'liyan', '5210', 'acceptance-liyan-device')
  const productionLogin = await login(baseUrl, dailyCredential, 'lengyanzhi', '5210', 'acceptance-bartender-device')
  const fixtures = await loadFixtures(testUrl, store.tenant.id, store.store.id, {
    serviceEmployeeId: serviceLogin.employeeId,
    productionEmployeeId: productionLogin.employeeId,
  })
  const keepAlive = startStaffHeartbeat(baseUrl, [serviceLogin.token, productionLogin.token])
  let report: Awaited<ReturnType<typeof runNormalizedLoadAcceptance>>
  try {
    report = await runNormalizedLoadAcceptance({
      mode: 'http_isolated_postgres',
      baseUrl,
      serviceToken: serviceLogin.token,
      productionToken: productionLogin.token,
      fixtures,
      targetRps: Number(process.env.TARGET_RPS ?? 5),
      durationSeconds: Number(process.env.DURATION_SECONDS ?? 2),
      requestsPerScenario: process.env.REQUESTS_PER_SCENARIO
        ? Number(process.env.REQUESTS_PER_SCENARIO)
        : undefined,
    })
  } finally {
    await keepAlive.stop()
  }
  keepAlive.assertHealthy()
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ outputPath, gate: report.gate, run: report.run }, null, 2)}\n`)
  if (!report.gate.passed) process.exitCode = 1
} finally {
  await runtime?.app.close().catch(() => undefined)
  if (created) {
    await admin.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [databaseName]).catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined)
  }
  await admin.end().catch(() => undefined)
}

async function login(
  baseUrl: string,
  credential: string,
  employeeCode: string,
  pin: string,
  deviceKey: string,
): Promise<{ token: string; employeeId: string }> {
  const deviceResponse = await fetch(`${baseUrl}/api/auth/device-access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential, deviceKey }),
  })
  const deviceBody = await deviceResponse.json() as { error?: { code?: string } }
  const deviceToken = cookieToken(deviceResponse.headers.get('set-cookie'), '__Host-mbox_device_lease')
  if (!deviceResponse.ok || deviceToken === null) {
    throw new Error(`device access failed for ${employeeCode}: ${deviceResponse.status} ${deviceBody.error?.code ?? 'UNKNOWN'}`)
  }
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ employeeCode, pin }),
  })
  const loginBody = await loginResponse.json() as { data?: { employee?: { id?: string } } }
  const staffToken = cookieToken(loginResponse.headers.get('set-cookie'), '__Host-mbox_staff_session')
  const employeeId = loginBody.data?.employee?.id
  if (!loginResponse.ok || staffToken === null || !employeeId) throw new Error(`staff login failed for ${employeeCode}`)
  return { token: staffToken, employeeId }
}

async function loadFixtures(
  databaseUrl: string,
  tenantId: string,
  storeId: string,
  employees: { serviceEmployeeId: string; productionEmployeeId: string },
) {
  const client = new Client({ connectionString: databaseUrl, application_name: 'normalized-http-acceptance-fixtures' })
  await client.connect()
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.store_id', $2, false)`, [
      tenantId,
      storeId,
    ])
    const tables = await client.query<{ id: string }>(`
      SELECT id FROM mbox.tables
      WHERE tenant_id=$1 AND store_id=$2 AND status='available'
      ORDER BY code LIMIT 12
    `, [tenantId, storeId])
    const product = await client.query<{ id: string }>(`
      SELECT id FROM mbox.products
      WHERE tenant_id=$1 AND store_id=$2 AND status='active'
        AND product_kind='single' AND fulfillment_station='bar'
      ORDER BY code LIMIT 1
    `, [tenantId, storeId])
    if (tables.rows.length < 2 || !product.rows[0]) {
      const inventory = await client.query<{ station: string; kind: string; status: string; count: string }>(`
        SELECT fulfillment_station AS station, product_kind AS kind, status, count(*)::text AS count
        FROM mbox.products WHERE tenant_id=$1 AND store_id=$2
        GROUP BY fulfillment_station, product_kind, status ORDER BY 1,2,3
      `, [tenantId, storeId])
      throw new Error(`acceptance fixtures are incomplete: tables=${tables.rows.length}, products=${JSON.stringify(inventory.rows)}`)
    }
    const inventoryItem = await client.query<{ id: string }>(`
      INSERT INTO mbox.inventory_items(
        tenant_id, store_id, sku, name, item_type, base_unit, low_stock_threshold)
      VALUES ($1,$2,'ACCEPTANCE-BAR-ML','验收专用酒水原料','ingredient','ml',100)
      RETURNING id
    `, [tenantId, storeId])
    const recipe = await client.query<{ id: string }>(`
      INSERT INTO mbox.recipes(
        tenant_id, store_id, product_id, version, yield_quantity,
        instructions_snapshot, status, effective_at)
      VALUES ($1,$2,$3,1,1,'{"source":"load_acceptance"}'::jsonb,'active',clock_timestamp())
      RETURNING id
    `, [tenantId, storeId, product.rows[0].id])
    await client.query(`
      INSERT INTO mbox.recipe_items(
        tenant_id, store_id, recipe_id, inventory_item_id, quantity, expected_waste_quantity)
      VALUES ($1,$2,$3,$4,1,0)
    `, [tenantId, storeId, recipe.rows[0]!.id, inventoryItem.rows[0]!.id])
    await client.query(`
      INSERT INTO mbox.inventory_balances(
        tenant_id, store_id, inventory_item_id, on_hand_quantity, reserved_quantity)
      VALUES ($1,$2,$3,100000,0)
    `, [tenantId, storeId, inventoryItem.rows[0]!.id])
    return {
      tableIds: tables.rows.map((row) => row.id),
      productId: product.rows[0].id,
      serviceEmployeeId: employees.serviceEmployeeId,
      productionEmployeeId: employees.productionEmployeeId,
      stationCode: 'bar',
    }
  } finally {
    await client.end()
  }
}

function cookieToken(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null
  const match = new RegExp(`(?:^|,\\s*)${name}=([A-Za-z0-9_-]+)`).exec(setCookie)
  return match?.[1] ?? null
}

function startStaffHeartbeat(baseUrl: string, tokens: readonly string[], intervalMs = 30_000) {
  let active = Promise.resolve()
  let failure: Error | null = null
  const run = async () => {
    for (const token of tokens) {
      const response = await fetch(`${baseUrl}/api/auth/heartbeat`, {
        method: 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`staff heartbeat failed with HTTP ${response.status}`)
    }
  }
  const timer = globalThis.setInterval(() => {
    active = active.then(run).catch((error: unknown) => {
      failure ??= error instanceof Error ? error : new Error('staff heartbeat failed')
    })
  }, intervalMs)
  return {
    async stop() {
      globalThis.clearInterval(timer)
      await active
    },
    assertHealthy() {
      if (failure !== null) throw failure
    },
  }
}

function databaseUrl(source: string, name: string): string {
  const parsed = new URL(source)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('temporary database name is invalid')
  return `"${value}"`
}
