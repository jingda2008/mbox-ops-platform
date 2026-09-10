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
import { effectiveStaffNavigation } from '../src/shared/staff-module-access.js'
import { MemberCardRepository } from '../server/normalized/member-card-repository.js'
import { CouponCalendarRepository } from '../server/normalized/coupon-calendar-repository.js'
import { StaffAccessRepository } from '../server/normalized/staff-access-repository.js'
import { MarketingContactRepository } from '../server/normalized/marketing-contact-repository.js'

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
  // Opt-in, throwaway database only. Never add these grants to the real store
  // configuration merely to make a new feature visible during acceptance.
  const memberCardFixture = process.env.NORMALIZED_E2E_MEMBER_CARDS === 'true'
  if (memberCardFixture) await runtime.transactions.run(scope, async transaction => {
    // Deterministic qualification fixture: a counted, non-stock-managed drink
    // and a bundle retaining two of that exact drink. Never a live campaign.
    const upgradeProducts=(await transaction.query<{id:string;code:string}>(`INSERT INTO mbox.products(tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode,cost_amount_minor,guest_visible,allowed_channels)
      VALUES($1,$2,'BROWSER-UPGRADE-SOURCE','隔离升级原饮品','test','single','bar','not_managed',200,true,ARRAY['guest_qr','staff_assisted']),
      ($1,$2,'BROWSER-UPGRADE-TARGET','隔离升级双份套餐','test','bundle','none','not_managed',400,true,ARRAY['guest_qr','staff_assisted']) RETURNING id,code`,[scope.tenantId,scope.storeId])).rows
    const upgradeSource=upgradeProducts.find(row=>row.code==='BROWSER-UPGRADE-SOURCE')!.id,upgradeTarget=upgradeProducts.find(row=>row.code==='BROWSER-UPGRADE-TARGET')!.id
    await transaction.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 day'),($1,$2,$4,'standard',2000,'CNY',clock_timestamp()-interval '1 day')`,[scope.tenantId,scope.storeId,upgradeSource,upgradeTarget])
    await transaction.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,2,1)',[scope.tenantId,scope.storeId,upgradeTarget,upgradeSource])
    const access = new StaffAccessRepository(transaction)
    const startsAt = new Date(Date.now()-60_000).toISOString()
    for (const permissionCode of ['member.card.manage','member.card.review']) await access.setEmployeePermissionOverride({employeeId,permissionCode,effect:'grant',reason:'隔离卡页面测试',configuredByEmployeeId:employeeId,startsAt})
    const creator = (await transaction.query<{id:string}>("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code='chenfangyu'",[scope.tenantId,scope.storeId])).rows[0]!.id
    await access.setEmployeePermissionOverride({employeeId:creator,permissionCode:'member.card.manage',effect:'grant',reason:'隔离卡项目创建',configuredByEmployeeId:employeeId,startsAt})
    await access.setEmployeePermissionOverride({employeeId,permissionCode:'loyalty.policy.publish',effect:'grant',reason:'隔离项目开放测试',configuredByEmployeeId:employeeId,startsAt})
    const repository=new MemberCardRepository(transaction)
    for(const width of [320,360]){
      const project=await repository.createProject({code:`BROWSER_CARD_${width}`,name:`测试音乐兴趣卡${width}`,terms:'免费兴趣卡，消费等级保持不变，不代表同意营销。',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:'2037-10-01T00:00:00Z',cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:creator,businessDate})
      await repository.setProjectState({projectId:project.projectId,state:'open',employeeId,businessDate,reason:'隔离项目开放'})
      const customer=(await transaction.query<{id:string}>("INSERT INTO mbox.customers(tenant_id,store_id,public_id) VALUES($1,$2,$3) RETURNING id",[scope.tenantId,scope.storeId,`browser-card-${width}`])).rows[0]!.id
      await transaction.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'gold')",[scope.tenantId,scope.storeId,customer,`MBX-CARD${width}`])
      await repository.apply({projectId:project.projectId,customerId:customer,acceptedProjectVersion:1,businessDate})
    }
    const giftProduct=(await transaction.query<{id:string}>("INSERT INTO mbox.products(tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor) VALUES($1,$2,'BROWSER-GIFT-SNACK','测试发券小食','snack','kitchen',100) RETURNING id",[scope.tenantId,scope.storeId])).rows[0]!.id
    await transaction.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,giftProduct])
    const calendar=new CouponCalendarRepository(transaction),from=new Date(Date.now()-86400000).toISOString(),until=new Date(Date.now()+30*86400000).toISOString()
    const saved=await calendar.save({code:'BROWSER_GIFT_CAL',rule:{timezone:'Asia/Shanghai',dateBasis:'natural',businessDayStartMinute:0,dateFrom:from.slice(0,10),dateThrough:until.slice(0,10),validFrom:from,validUntil:until,weekdays:[1,2,3,4,5,6,7],weekStartsOn:1,windows:[{startMinute:0,endMinute:1440}],excludedDates:[],relativeValidity:{days:3,basis:'elapsed'}},limits:{perCustomerDay:null,perCustomerWeek:null,perCustomerCampaign:null},employeeId,businessDate,reason:'隔离赠券页面规则',requestKey:'browser-gift-calendar',expectedVersion:0})
    const approver=(await transaction.query<{id:string}>("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code='hugu'",[scope.tenantId,scope.storeId])).rows[0]!.id
    await calendar.decide({versionId:saved.id,action:'approve',employeeId:approver,businessDate,reason:'隔离规则审核'})
    await calendar.decide({versionId:saved.id,action:'publish',employeeId:creator,businessDate,reason:'隔离规则发布'})
    for(const actor of [employeeId,approver,creator])for(const permissionCode of ['marketing.notice.view','marketing.notice.edit','marketing.notice.approve','marketing.notice.publish','marketing.send','marketing.refusal.record','marketing.consent.audit'])await access.setEmployeePermissionOverride({employeeId:actor,permissionCode,effect:'grant',reason:'隔离营销页面测试',configuredByEmployeeId:employeeId,startsAt})
    const marketing=new MarketingContactRepository(transaction)
    const marketingNotice=await marketing.save({code:'BROWSER_MARKETING',expectedVersion:0,employeeId,businessDate,reason:'隔离无外部发送夹具',requestKey:'browser-marketing-notice',rule:{operatorName:'隔离测试经营主体',operatorContact:'隔离测试客服',summary:'仅用于隔离浏览器测试，不联系真实客户。',withdrawalInstructions:'联系偏好中随时停止，会员与点单不受影响。',purposes:['own_activities'],channels:['sms'],dataCategories:['本人验证手机号'],validFrom:from,validUntil:until,consentDays:7,contactStartMinute:0,contactEndMinute:1440,weekdays:[1,2,3,4,5,6,7],maximumPerDay:1,maximumPerMonth:4,sharingMode:'no_partner_list'}})
    await marketing.decide({noticeId:marketingNotice.noticeId,action:'approve',employeeId:approver,businessDate,reason:'隔离告知审核'})
    await marketing.decide({noticeId:marketingNotice.noticeId,action:'publish',employeeId:creator,businessDate,reason:'隔离告知发布'})
    for(const width of [320,360]){
      const customer=(await transaction.query<{id:string}>('SELECT id FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[scope.tenantId,scope.storeId,`browser-card-${width}`])).rows[0]!.id
      await marketing.recordChoices({customerId:customer,noticeId:marketingNotice.noticeId,expectedRevision:'none',businessDate,choices:[{channel:'sms',purpose:'own_activities',decision:'granted'}]})
    }
  })
  await runtime.transactions.run(scope, async (transaction) => {
    await transaction.query(`
      INSERT INTO mbox.store_commerce_policies(
        tenant_id, store_id, online_payment_enabled, policy_version,
        reason, updated_by_employee_id, payment_reservation_minutes
      ) VALUES ($1::uuid,$2::uuid,true,1,$3,$4::uuid,10)
      ON CONFLICT (tenant_id, store_id) DO UPDATE SET
        online_payment_enabled=true,
        policy_version=mbox.store_commerce_policies.policy_version+1,
        reason=EXCLUDED.reason,
        updated_by_employee_id=EXCLUDED.updated_by_employee_id,
        payment_reservation_minutes=10,
        updated_at=clock_timestamp()
    `, [scope.tenantId, scope.storeId, '隔离浏览器验收显式启用模拟支付', employeeId])
  })
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
    const permissions = Array.from(new Set(roles.flatMap((role) => role.permissions)))
    const configuredNavigation = Array.from(new Map(roles.flatMap((role) => role.navigation ?? [])
      .map((entry) => [entry.code, {
        code: entry.code,
        label: entry.label,
        route: entry.route,
        icon: entry.icon ?? null,
        sortOrder: entry.sortOrder ?? 0,
        displayConfig: { highFrequency: entry.highFrequency ?? false },
      }])).values())
    const navigation = effectiveStaffNavigation(permissions, configuredNavigation)
    const highFrequencyEntries = navigation
      .filter((entry) => entry.displayConfig.highFrequency === true)
      .map((entry) => ({ label: entry.label, route: entry.route }))
    const navigationRoutes = navigation.map((entry) => entry.route)
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
    memberCardFixture,
    adminEmployeeCode: 'wuya',
    adminEmployeePin: '5210',
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
    const products = await client.query<{
      id: string
      name: string
      fulfillment_station: 'bar' | 'kitchen'
      inventory_control_mode: 'tracked' | 'not_managed'
      guest_visible: boolean
    }>(`
      SELECT id, name, fulfillment_station, inventory_control_mode, guest_visible FROM mbox.products
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
        AND product_kind='single' AND fulfillment_station = ANY($3::text[])
      ORDER BY fulfillment_station, code
    `, [tenantId, storeId, ['bar', 'kitchen']])
    const selected = {
      bar: products.rows.find((product) => product.fulfillment_station === 'bar' && product.guest_visible),
      kitchen: products.rows.find((product) => product.fulfillment_station === 'kitchen' && product.guest_visible),
    }
    if (!selected.bar || !selected.kitchen) throw new Error('normalized browser fixture needs guest-visible bar and kitchen products')
    for (const product of products.rows.filter((candidate) => candidate.inventory_control_mode === 'tracked')) {
      const item = await client.query<{ id: string }>(`
        INSERT INTO mbox.inventory_items(
          tenant_id, store_id, sku, name, item_type, base_unit, low_stock_threshold)
        VALUES ($1,$2,$3,$4,'ingredient','piece',10)
        RETURNING id
      `, [tenantId, storeId, `BROWSER-E2E-${product.id}`, `${product.name}浏览器验收原料`])
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
        tenant_id, store_id, code, stage_name, profile_snapshot)
      VALUES ($1,$2,'BROWSER-SINGER','林小满','{"bio":"浏览器营业日验收歌手"}'::jsonb)
      RETURNING id
    `, [tenantId, storeId])
    const songBatch = await client.query<{ id: string }>(`
      INSERT INTO mbox.performer_song_import_batches(
        tenant_id, store_id, performer_id, public_id, source_name, source_sha256,
        import_mode, status, row_count, imported_count, completed_at)
      VALUES ($1,$2,$3,'browser-e2e-song-import','browser e2e',repeat('0',64),
        'replace','completed',1,1,clock_timestamp())
      RETURNING id
    `, [tenantId, storeId, performer.rows[0]!.id])
    await client.query(`
      INSERT INTO mbox.performer_songs(
        tenant_id, store_id, performer_id, import_batch_id, code, title)
      VALUES ($1,$2,$3,$4,'BROWSER-SONG','后来')
    `, [tenantId, storeId, performer.rows[0]!.id, songBatch.rows[0]!.id])
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
