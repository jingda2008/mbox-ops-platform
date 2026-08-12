import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { Client } from 'pg'
import { runNormalizedMigrations } from '../server/migrate-normalized.js'
import { createNormalizedApp } from '../server/normalized/normalized-app.js'
import { loadNormalizedRuntimeConfig } from '../server/normalized/normalized-runtime-config.js'
import { TableQrProvisioner } from '../server/normalized/table-qr-provisioner.js'
import { TableSessionCommandService } from '../server/normalized/table-session-repository.js'
import { parseNormalizedCatalog, provisionNormalizedCatalog } from '../server/provision-normalized-catalog.js'
import { parseStoreProvisionConfig, provisionNormalizedStore, shanghaiBusinessDate } from '../server/provision-normalized-store.js'

const adminSource = required('TEST_NORMALIZED_ADMIN_URL')
const storePath = resolve(process.env.STORE_CONFIG_FILE ?? 'deploy/normalized-store/mbox-lujiazui.store.json')
const catalogPath = resolve(process.env.CATALOG_CONFIG_FILE ?? 'config/menu-catalog-2026-07-27.json')
const fixturePath = resolve(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json')
const databaseName = `mbox_normalized_browser_${process.pid}_${randomBytes(4).toString('hex')}`
const admin = new Client({ connectionString: databaseUrl(adminSource, 'postgres'), application_name: 'normalized-browser-admin' })
const testUrl = databaseUrl(adminSource, databaseName)
let runtime: Awaited<ReturnType<typeof createNormalizedApp>> | null = null
let created = false

try {
  await admin.connect()
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  created = true
  await runNormalizedMigrations(testUrl)

  const store = parseStoreProvisionConfig(JSON.parse(await readFile(storePath, 'utf8')))
  const catalog = parseNormalizedCatalog(JSON.parse(await readFile(catalogPath, 'utf8')))
  const pinEnvironment = Object.fromEntries(store.employees.map((employee) => [employee.pinEnv, '5210']))
  const dailyCredential = 'MBOX521'
  const commitSha = process.env.APP_COMMIT_SHA ?? '27e9cba12947456ce83f8da16aa4eca63af731cf'
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

  const port = Number(process.env.NORMALIZED_E2E_PORT ?? 18_789)
  const secret = 'normalized-browser-e2e-secret-0123456789abcdef'
  const config = loadNormalizedRuntimeConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testUrl,
    MBOX_TENANT_ID: store.tenant.id,
    MBOX_STORE_ID: store.store.id,
    MBOX_NORMALIZED_SECRET: secret,
    MBOX_GUEST_PAYMENT_MODE: 'simulation',
    MBOX_START_WORKERS: 'false',
    MBOX_STATIC_DIR: resolve(process.env.MBOX_STATIC_DIR ?? 'dist'),
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_COMMIT_SHA: commitSha,
  })
  runtime = await createNormalizedApp({ config, logger: process.env.NORMALIZED_E2E_DEBUG === 'true' })
  const scope = { tenantId: store.tenant.id, storeId: store.store.id }
  const businessDate = shanghaiBusinessDate(new Date())
  const employeeId = await runtime.transactions.run(scope, async (transaction) => {
    const result = await transaction.query<{ id: string }>(`
      SELECT id FROM mbox.employees
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND employee_code='liyan'
    `, [scope.tenantId, scope.storeId])
    if (!result.rows[0]) throw new Error('normalized browser fixture employee is missing')
    return result.rows[0].id
  }, { readOnly: true })
  const qr = await new TableQrProvisioner(runtime.transactions, secret).provision({
    scope,
    businessDate,
    actorEmployeeId: employeeId,
    tableCodes: ['W01'],
    reason: '隔离浏览器验收签发',
  })
  const tableQrToken = qr[0]?.tableQrToken
  if (!tableQrToken) throw new Error('normalized browser table QR was not issued')
  const tableSession = await new TableSessionCommandService(runtime.commandExecutor).open({
    scope,
    actor: { type: 'employee', employeeId },
    table: { kind: 'code', value: 'W01' },
    publicId: `browser-session-${randomBytes(8).toString('hex')}`,
    businessDate,
    guestCount: 2,
    guestProfileSnapshot: { scene: 'friends', source: 'browser_acceptance' },
    openedByEmployeeId: employeeId,
    idempotencyKey: `browser-open-${randomBytes(12).toString('hex')}`,
    requestFingerprint: JSON.stringify({ table: 'W01', guestCount: 2, businessDate }),
  })
  await seedPerformance(testUrl, scope.tenantId, scope.storeId, tableSession.value.id)
  const orderableProducts = await seedOrderableInventory(testUrl, scope.tenantId, scope.storeId)
  const bundleProductName = catalog.products.find((product) => (
    product.productKind === 'bundle' && product.enabled && !product.soldOut && product.guestVisible
  ))?.name
  if (!bundleProductName) throw new Error('normalized browser fixture has no guest-visible bundle product')
  const roleByCode = new Map(store.roles.map((role) => [role.code, role]))
  const employees = store.employees.map((employee) => {
    const roles = employee.roleCodes.map((roleCode) => {
      const role = roleByCode.get(roleCode)
      if (!role) throw new Error(`normalized browser fixture role is missing: ${roleCode}`)
      return role
    })
    const highFrequencyEntries = Array.from(new Map(roles.flatMap((role) => role.navigation ?? [])
      .filter((entry) => entry.highFrequency === true)
      .map((entry) => [entry.route, { label: entry.label, route: entry.route }])).values())
    const navigationRoutes = Array.from(new Set(roles.flatMap((role) => role.navigation ?? [])
      .map((entry) => entry.route)))
    return {
      code: employee.code,
      name: employee.name,
      roleNames: roles.map((role) => role.name),
      highFrequencyEntries,
      navigationRoutes,
    }
  })

  await mkdir(dirname(fixturePath), { recursive: true })
  await writeFile(fixturePath, `${JSON.stringify({
    schemaVersion: 1,
    guestUrl: `/guest?table=W01#token=${tableQrToken}`,
    reservationUrl: '/reserve',
    staffUrl: '/',
    dailyCredential,
    employeeCode: 'liyan',
    employeePin: '5210',
    orderableProductName: orderableProducts.bar,
    kitchenProductName: orderableProducts.kitchen,
    bundleProductName,
    employees,
  }, null, 2)}\n`, { mode: 0o600 })

  await runtime.app.listen({ host: config.host, port: config.port })
  process.stdout.write(`normalized browser fixture ready on ${config.port}\n`)
  await waitForShutdown()
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

async function seedOrderableInventory(
  databaseUrlValue: string,
  tenantId: string,
  storeId: string,
): Promise<{ bar: string; kitchen: string }> {
  const client = new Client({ connectionString: databaseUrlValue, application_name: 'normalized-browser-inventory' })
  await client.connect()
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.store_id', $2, false)`, [tenantId, storeId])
    const products = await client.query<{ id: string; name: string; fulfillment_station: 'bar' | 'kitchen' }>(`
      SELECT id, name, fulfillment_station FROM mbox.products
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
        AND product_kind='single' AND fulfillment_station = ANY($3::text[])
        AND (product_snapshot->'guestVisible' IS NULL OR product_snapshot->'guestVisible'='true'::jsonb)
      ORDER BY fulfillment_station, code
    `, [tenantId, storeId, ['bar', 'kitchen']])
    const selected = {
      bar: products.rows.find((product) => product.fulfillment_station === 'bar'),
      kitchen: products.rows.find((product) => product.fulfillment_station === 'kitchen'),
    }
    if (!selected.bar || !selected.kitchen) throw new Error('normalized browser fixture needs guest-visible bar and kitchen products')
    for (const station of ['bar', 'kitchen'] as const) {
      const product = selected[station]!
      const item = await client.query<{ id: string }>(`
        INSERT INTO mbox.inventory_items(
          tenant_id, store_id, sku, name, item_type, base_unit, low_stock_threshold)
        VALUES ($1,$2,$3,$4,'ingredient','piece',10)
        RETURNING id
      `, [tenantId, storeId, `BROWSER-E2E-${station.toUpperCase()}`, `${station}浏览器验收原料`])
      const recipe = await client.query<{ id: string }>(`
        INSERT INTO mbox.recipes(
          tenant_id, store_id, product_id, version, yield_quantity,
          instructions_snapshot, status, effective_at)
        VALUES ($1,$2,$3,1,1,'{"source":"browser_e2e"}'::jsonb,'active',clock_timestamp())
        RETURNING id
      `, [tenantId, storeId, product.id])
      await client.query(`
        INSERT INTO mbox.recipe_items(
          tenant_id, store_id, recipe_id, inventory_item_id, quantity, expected_waste_quantity)
        VALUES ($1,$2,$3,$4,1,0)
      `, [tenantId, storeId, recipe.rows[0]!.id, item.rows[0]!.id])
      await client.query(`
        INSERT INTO mbox.inventory_balances(
          tenant_id, store_id, inventory_item_id, on_hand_quantity, reserved_quantity)
        VALUES ($1,$2,$3,1000,0)
      `, [tenantId, storeId, item.rows[0]!.id])
    }
    return { bar: selected.bar.name, kitchen: selected.kitchen.name }
  } finally {
    await client.end()
  }
}

async function seedPerformance(
  databaseUrlValue: string,
  tenantId: string,
  storeId: string,
  tableSessionId: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrlValue, application_name: 'normalized-browser-performance' })
  await client.connect()
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.store_id', $2, false)`, [tenantId, storeId])
    const performer = await client.query<{ id: string }>(`
      INSERT INTO mbox.performers(
        tenant_id, store_id, code, stage_name, profile_snapshot, song_catalog)
      VALUES ($1,$2,'BROWSER-SINGER','林小满','{"bio":"浏览器营业日验收歌手"}'::jsonb,
        '[{"code":"BROWSER-SONG","title":"后来"}]'::jsonb)
      RETURNING id
    `, [tenantId, storeId])
    const now = Date.now()
    const schedule = await client.query<{ id: string }>(`
      INSERT INTO mbox.schedules(
        tenant_id, store_id, performer_id, starts_at, ends_at, status, sort_order)
      VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,'performing',1)
      RETURNING id
    `, [
      tenantId,
      storeId,
      performer.rows[0]!.id,
      new Date(now - 15 * 60_000).toISOString(),
      new Date(now + 30 * 60_000).toISOString(),
    ])
    await client.query(`
      INSERT INTO mbox.song_requests(
        tenant_id, store_id, table_session_id, performer_id, schedule_id,
        song_title, request_type, status, note)
      VALUES ($1,$2,$3,$4,$5,'后来','catalog','requested','营业日验收点歌需求')
    `, [tenantId, storeId, tableSessionId, performer.rows[0]!.id, schedule.rows[0]!.id])
  } finally {
    await client.end()
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const stop = () => resolveShutdown()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
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
