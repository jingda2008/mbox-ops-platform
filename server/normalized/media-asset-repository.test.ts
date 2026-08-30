import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { MediaAssetRepository } from './media-asset-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
}
const publicId = 'MA00000000000000000000000000000001'

describe('media asset publication boundary', () => {
  it('serves a menu asset only when its product is customer-visible', async () => {
    const query = vi.fn(async () => ({ rows: [assetRow()] }))
    const repository = new MediaAssetRepository({ scope, query } as never)

    await expect(repository.publicBytes(publicId)).resolves.toEqual({
      mimeType: 'image/png', bytes: Buffer.from('menu image'), sha256: 'a'.repeat(64),
    })

    const [sql, values] = query.mock.calls[0]!
    expect(sql).toContain('FROM mbox.products AS product')
    expect(sql).toContain("product.status='active'")
    expect(sql).toContain('product.guest_visible=true')
    expect(sql).toContain("'guest_qr'=ANY(product.allowed_channels)")
    expect(sql).toContain('menu_category.guest_visible=true')
    expect(values).toEqual([scope.tenantId, scope.storeId, publicId])
  })

  it('does not expose an asset when no published reference is found', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const repository = new MediaAssetRepository({ scope, query } as never)

    await expect(repository.publicBytes(publicId)).resolves.toBeNull()
  })
})

function assetRow() {
  return {
    public_id: publicId,
    purpose: 'menu',
    original_file_name: 'menu.png',
    mime_type: 'image/png',
    byte_length: 10,
    sha256: 'a'.repeat(64),
    bytes: Buffer.from('menu image'),
    created_at: '2026-08-30T00:00:00.000Z',
  }
}

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const integrationIds = {
  tenantId: randomUUID(), storeId: randomUUID(), employeeId: randomUUID(), productId: randomUUID(),
} as const
const integrationScope = { tenantId: integrationIds.tenantId, storeId: integrationIds.storeId }
const integrationAssetId = `MA${randomUUID().replaceAll('-', '').toUpperCase()}`

integration('media asset publication PostgreSQL integration', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const suffix = integrationIds.tenantId.replaceAll('-', '').slice(0, 10)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'菜单图片测试租户')`, [
      integrationIds.tenantId, `media-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'菜单图片测试门店')`, [
      integrationIds.storeId, integrationIds.tenantId, `media-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,$4,'图片管理员')`, [
      integrationIds.employeeId, integrationIds.tenantId, integrationIds.storeId, `MEDIA-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.media_assets(
      tenant_id,store_id,public_id,purpose,original_file_name,mime_type,byte_length,sha256,bytes,created_by_employee_id
    ) VALUES($1,$2,$3,'menu','published-menu.png','image/png',8,$4,$5,$6)`, [
      integrationIds.tenantId, integrationIds.storeId, integrationAssetId, 'b'.repeat(64),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), integrationIds.employeeId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot,status,guest_visible,allowed_channels
    ) VALUES($1,$2,$3,'MEDIA-MENU-1','公开菜单图片','other','none',$4::jsonb,'active',true,ARRAY['guest_qr']::text[])`, [
      integrationIds.productId, integrationIds.tenantId, integrationIds.storeId,
      JSON.stringify({ imageUrl: `/api/public/media-assets/${integrationAssetId}` }),
    ])
  })

  afterAll(async () => pool?.end())

  it('returns an image for a published menu product and hides it immediately when the product is stopped', async () => {
    const available = await transactions.run(integrationScope, (transaction) => (
      new MediaAssetRepository(transaction).publicBytes(integrationAssetId)
    ), { readOnly: true })
    expect(available).toMatchObject({ mimeType: 'image/png', sha256: 'b'.repeat(64) })
    expect(available?.bytes).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    await pool.query(`UPDATE mbox.products SET status='inactive' WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [
      integrationIds.tenantId, integrationIds.storeId, integrationIds.productId,
    ])
    const stopped = await transactions.run(integrationScope, (transaction) => (
      new MediaAssetRepository(transaction).publicBytes(integrationAssetId)
    ), { readOnly: true })
    expect(stopped).toBeNull()
  })
})
