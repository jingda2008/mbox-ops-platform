import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { mediaAssetApiPlugin } from './media-asset-api.js'
import { MediaAssetRepository } from './media-asset-repository.js'
import { MemberCardRepository } from './member-card-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('interest-card menu images use the existing card visibility rules', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const employeeId = randomUUID(), publisherId = randomUUID(), customerId = randomUUID(), roleId = randomUUID()
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=', 'base64')
  let pool: Pool, transactions: ScopedPostgresTransactionRunner
  const app = Fastify()
  const read = (assetId: string, storeId = scope.storeId) => transactions.run({ ...scope, storeId }, async tx => {
    await tx.query('SET LOCAL ROLE mbox_runtime')
    return new MediaAssetRepository(tx).publicBytes(assetId)
  }, { readOnly: true })

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'card media test')", [scope.tenantId, `media-${scope.tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'media','card media test')", [scope.storeId, scope.tenantId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'media','media')", [employeeId, scope.tenantId, scope.storeId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'publisher','publisher')", [publisherId, scope.tenantId, scope.storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MEDIA','media')", [roleId, scope.tenantId, scope.storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')", [scope.tenantId, scope.storeId, employeeId, roleId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')", [scope.tenantId, scope.storeId, publisherId, roleId])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('member.card.manage','member.card.review','loyalty.policy.publish')", [scope.tenantId, scope.storeId, roleId])
    await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'media-member')", [customerId, scope.tenantId, scope.storeId])
    await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'200001')", [scope.tenantId, scope.storeId, customerId])
    await app.register(mediaAssetApiPlugin, {
      transactions: { run: (storeScope, fn, options) => transactions.run(storeScope, async tx => {
        await tx.query('SET LOCAL ROLE mbox_runtime')
        return fn(tx)
      }, options) },
      service: {} as never, resolveScope: () => scope,
      resolveStaffContext: () => { throw new Error('Public image request must not use a staff account') },
    })
  }, 30_000)
  afterAll(async () => { await app.close(); await pool?.end() })

  async function fixture(options: { flowMode?: 'simple' | 'legacy'; approve?: boolean; draft?: boolean } = {}) {
    const productId = randomUUID(), assetId = `MA${randomUUID().replaceAll('-', '').toUpperCase()}`
    const category = `C${randomUUID().replaceAll('-', '')}`
    await pool.query("INSERT INTO mbox.media_assets(tenant_id,store_id,public_id,purpose,original_file_name,mime_type,byte_length,sha256,bytes,created_by_employee_id) VALUES($1,$2,$3,'menu','card-menu.png','image/png',$4,$5,$6,$7)", [scope.tenantId, scope.storeId, assetId, bytes.length, createHash('sha256').update(assetId).digest('hex'), bytes, employeeId])
    await pool.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,display_name) VALUES($1,$2,$3,'专属菜品分类')", [scope.tenantId, scope.storeId, category])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible,allowed_channels,product_snapshot) VALUES($1,$2,$3,$4,'专属菜品',$5,'none',false,ARRAY['guest_qr'],$6)", [productId, scope.tenantId, scope.storeId, `P${productId}`, category, { imageUrl: `/api/public/media-assets/${assetId}` }])
    const projectId = await transactions.run(scope, async tx => {
      const repo = new MemberCardRepository(tx)
      const project = await repo.createProject({ flowMode: options.flowMode ?? 'simple', code: `CARD_${productId.replaceAll('-', '').toUpperCase()}`, name: '图片测试卡', terms: '沿用持卡权益', kind: 'interest', availableFrom: new Date(Date.now() - 60_000).toISOString(), availableUntil: options.flowMode === 'legacy' ? new Date(Date.now() + 86_400_000).toISOString() : null, cooperationConfirmed: false, cooperationValidUntil: null, cooperationReference: null, employeeId, businessDate: '2026-10-24' })
      if (!options.draft) {
        await repo.setProjectState({ projectId: project.projectId, state: 'open', employeeId: publisherId, businessDate: '2026-10-24', reason: '图片测试开放' })
        if (options.approve !== false) {
          const application = await repo.apply({ projectId: project.projectId, customerId, acceptedProjectVersion: 1, businessDate: '2026-10-24' })
          await repo.review({ applicationId: application.applicationId, decision: 'approve', employeeId, businessDate: '2026-10-24', reason: '符合条件' })
        }
      }
      return project.projectId
    })
    await pool.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive) VALUES($1,$2,$3,$4,true)', [scope.tenantId, scope.storeId, projectId, productId])
    return { productId, assetId, projectId, category }
  }

  it('serves original and menu thumbnails while the product remains hidden from non-holders', async () => {
    const item = await fixture()
    for (const suffix of ['', '?variant=menu320']) {
      const response = await app.inject(`/public/media-assets/${item.assetId}${suffix}`)
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toMatch(/^image\//)
      expect(response.rawPayload.length).toBeGreaterThan(0)
    }
    const visibility = await transactions.run(scope, async tx => {
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return (await tx.query('SELECT guest_visible,mbox.product_visible_now(tenant_id,store_id,id,$2) AS holder,mbox.product_visible_now(tenant_id,store_id,id,NULL) AS visitor FROM mbox.products WHERE id=$1', [item.productId, customerId])).rows[0]
    })
    expect(visibility).toEqual({ guest_visible: false, holder: true, visitor: false })
    expect(await read(item.assetId, randomUUID())).toBeNull()
  })

  it.each(['paused', 'closed'] as const)('keeps issued simple-card image rights when new applications are %s', async status => {
    const item = await fixture()
    await transactions.run(scope, tx => new MemberCardRepository(tx).setProjectState({ projectId: item.projectId, state: status, employeeId, businessDate: '2026-10-24', reason: '停止新申请，保留已有权益' }))
    expect(await read(item.assetId)).not.toBeNull()
  })

  it.each(['draft', 'no-holder', 'suspended', 'revoked', 'removed', 'not-exclusive', 'inactive', 'channel', 'category', 'legacy-paused'] as const)('does not publish an inaccessible card image: %s', async scenario => {
    const item = await fixture({ draft: scenario === 'draft', approve: scenario !== 'no-holder', flowMode: scenario === 'legacy-paused' ? 'legacy' : 'simple' })
    if (scenario === 'suspended' || scenario === 'revoked') await pool.query('UPDATE mbox.member_cards SET status=$2 WHERE project_id=$1', [item.projectId, scenario])
    if (scenario === 'removed') await pool.query('UPDATE mbox.member_card_menu_items SET active=false WHERE project_id=$1', [item.projectId])
    if (scenario === 'not-exclusive') await pool.query('UPDATE mbox.member_card_menu_items SET exclusive=false WHERE project_id=$1', [item.projectId])
    if (scenario === 'inactive') await pool.query("UPDATE mbox.products SET status='inactive' WHERE id=$1", [item.productId])
    if (scenario === 'channel') await pool.query("UPDATE mbox.products SET allowed_channels=ARRAY['staff_assisted'] WHERE id=$1", [item.productId])
    if (scenario === 'category') await pool.query('UPDATE mbox.menu_categories SET guest_visible=false WHERE tenant_id=$1 AND store_id=$2 AND code=$3', [scope.tenantId, scope.storeId, item.category])
    if (scenario === 'legacy-paused') await transactions.run(scope, tx => new MemberCardRepository(tx).setProjectState({ projectId: item.projectId, state: 'paused', employeeId, businessDate: '2026-10-24', reason: '沿用旧卡暂停规则' }))
    expect(await read(item.assetId)).toBeNull()
  })

  it('inherits the base visible window, then respects the card-specific override without using sale time', async () => {
    const item = await fixture()
    const addWindow = async (projectId: string | null, future: boolean) => pool.query(`INSERT INTO mbox.product_service_windows(tenant_id,store_id,product_id,card_project_id,date_from,weekdays,sale_start_minute,sale_end_minute,visible_start_minute,visible_end_minute)
      VALUES($1,$2,$3,$4,CASE WHEN $5 THEN CURRENT_DATE+2 ELSE NULL END,ARRAY[1,2,3,4,5,6,7],0,1440,0,1440)`, [scope.tenantId, scope.storeId, item.productId, projectId, future])
    await addWindow(null, true)
    expect(await read(item.assetId)).toBeNull()
    await addWindow(item.projectId, false)
    expect(await read(item.assetId)).not.toBeNull()
    await pool.query('UPDATE mbox.product_service_windows SET date_from=CURRENT_DATE+2 WHERE product_id=$1 AND card_project_id=$2', [item.productId, item.projectId])
    expect(await read(item.assetId)).toBeNull()
  })

  it('rechecks card rights before responding to a conditional cached-image request', async () => {
    const item = await fixture()
    const first = await app.inject(`/public/media-assets/${item.assetId}`)
    expect(first.statusCode).toBe(200)
    await pool.query("UPDATE mbox.member_cards SET status='revoked' WHERE project_id=$1", [item.projectId])
    const stopped = await app.inject({ url: `/public/media-assets/${item.assetId}`, headers: { 'if-none-match': String(first.headers.etag) } })
    expect(stopped.statusCode).toBe(404)
    expect(stopped.json().error.code).toBe('MEDIA_ASSET_NOT_PUBLIC')
  })
})
