import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { inspectCommercialReadiness } from '../verify-normalized-commercial-readiness.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl && runtimeUrl ? describe : describe.skip

integration('commercial inspection with the actual restricted login', () => {
  let pool: Pool
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    pool = new Pool({ connectionString: adminUrl })
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const tenantId = randomUUID(), storeId = randomUUID()
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Readiness test')", [tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Readiness store')", [storeId, tenantId])
    return { tenantId, storeId }
  }
  async function product(scope: Awaited<ReturnType<typeof fixture>>, kind = 'single', mode = 'not_managed') {
    const id = randomUUID()
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,inventory_control_mode)
      VALUES($1::uuid,$2,$3,$1::text,'Inspection product','test',CASE WHEN $5='tracked' THEN 'bar' ELSE 'none' END,$4,$5)`, [id, scope.tenantId, scope.storeId, kind, mode])
    return id
  }
  const inspect = (scope: Awaited<ReturnType<typeof fixture>>) => inspectCommercialReadiness({ databaseUrl: runtimeUrl!, ...scope })

  it('reads only the requested store through RLS and leaves configuration unchanged', async () => {
    const a = await fixture(), b = await fixture()
    await product(a)
    await product(b); await product(b)
    const before = (await pool.query('SELECT count(*)::text count FROM mbox.store_configuration_applications')).rows
    const report = await inspect(a)
    expect(report.snapshot.storeActive).toBe(true)
    expect(report.snapshot.activeProducts).toBe(1)
    expect((await inspect(b)).snapshot.activeProducts).toBe(2)
    expect((await pool.query('SELECT count(*)::text count FROM mbox.store_configuration_applications')).rows).toEqual(before)
  })

  it('accepts a choice-only bundle but detects insufficient active choices', async () => {
    const scope = await fixture(), bundle = await product(scope, 'bundle'), item = await product(scope), group = randomUUID()
    await pool.query(`INSERT INTO mbox.product_bundle_choice_groups(id,tenant_id,store_id,bundle_product_id,code,display_name,selection_count)
      VALUES($1,$2,$3,$4,'choice','Choose',1)`, [group,scope.tenantId,scope.storeId,bundle])
    await pool.query(`INSERT INTO mbox.product_bundle_choice_options(tenant_id,store_id,choice_group_id,component_product_id)
      VALUES($1,$2,$3,$4)`, [scope.tenantId,scope.storeId,group,item])
    let report = await inspect(scope)
    expect(report.snapshot.bundlesMissingComponents).toBe(0)
    expect(report.snapshot.invalidBundleChoiceGroups).toBe(0)
    await pool.query('UPDATE mbox.products SET guest_visible=false WHERE id=$1',[item])
    expect((await inspect(scope)).snapshot.invalidBundleChoiceGroups).toBe(1)
    await pool.query('UPDATE mbox.products SET guest_visible=true WHERE id=$1',[item])
    await pool.query('UPDATE mbox.product_bundle_choice_groups SET selection_count=2 WHERE id=$1',[group])
    report = await inspect(scope)
    expect(report.snapshot.invalidBundleChoiceGroups).toBe(1)
    expect(report.issues.map(i=>i.code)).toContain('catalog.bundle_choice_invalid')
  })

  it('detects positive stock with unverified costs and tracked products without usable recipes', async () => {
    const scope = await fixture(), inventory = randomUUID()
    await product(scope,'single','tracked')
    await product(scope,'single','not_managed')
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES($1::uuid,$2,$3,$1::text,'Stock','ingredient','g')`,[inventory,scope.tenantId,scope.storeId])
    await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,cost_status,cost_basis)
      VALUES($1,$2,$3,2,'needs_review','none')`,[scope.tenantId,scope.storeId,inventory])
    const report = await inspect(scope)
    expect(report.snapshot.inventoryCostsUnverified).toBe(1)
    expect(report.snapshot.productsMissingRecipes).toBe(1)
    expect(report.issues.map(i=>i.code)).toEqual(expect.arrayContaining(['inventory.cost_unverified','catalog.recipe_missing']))
    await pool.query('UPDATE mbox.inventory_balances SET on_hand_quantity=0 WHERE inventory_item_id=$1',[inventory])
    expect((await inspect(scope)).snapshot.inventoryCostsUnverified).toBe(0)
  })

  it('requires effective recipes, active ingredients and a balance, without demanding a recipe for untracked products', async () => {
    const scope = await fixture(), item = await product(scope,'single','tracked'), inventory = randomUUID(), recipe = randomUUID()
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES($1::uuid,$2,$3,$1::text,'Ingredient','ingredient','g')`,[inventory,scope.tenantId,scope.storeId])
    await pool.query(`INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at)
      VALUES($1,$2,$3,$4,1,'active',clock_timestamp()+interval '1 day')`,[recipe,scope.tenantId,scope.storeId,item])
    await pool.query(`INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity)
      VALUES($1,$2,$3,$4,1)`,[scope.tenantId,scope.storeId,recipe,inventory])
    expect((await inspect(scope)).snapshot.productsMissingRecipes).toBe(1)
    await pool.query("UPDATE mbox.recipes SET effective_at=clock_timestamp()-interval '1 day' WHERE id=$1",[recipe])
    expect((await inspect(scope)).snapshot.productsMissingRecipes).toBe(1)
    await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id) VALUES($1,$2,$3)',[scope.tenantId,scope.storeId,inventory])
    expect((await inspect(scope)).snapshot.productsMissingRecipes).toBe(0)
    await pool.query("UPDATE mbox.inventory_items SET status='inactive' WHERE id=$1",[inventory])
    expect((await inspect(scope)).snapshot.productsMissingRecipes).toBe(1)
  })
})
