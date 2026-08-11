import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { loadNormalizedMigrations, runNormalizedMigrations } from '../migrate-normalized.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const tenantOneId = '21000000-0000-4000-8000-000000000001'
const storeOneId = '21000000-0000-4000-8000-000000000002'
const areaOneId = '21000000-0000-4000-8000-000000000003'
const tableOneId = '21000000-0000-4000-8000-000000000004'
const storeOneSiblingId = '21000000-0000-4000-8000-000000000012'
const areaOneSiblingId = '21000000-0000-4000-8000-000000000013'
const tableOneSiblingId = '21000000-0000-4000-8000-000000000014'
const tenantTwoId = '22000000-0000-4000-8000-000000000001'
const storeTwoId = '22000000-0000-4000-8000-000000000002'
const areaTwoId = '22000000-0000-4000-8000-000000000003'
const tableTwoId = '22000000-0000-4000-8000-000000000004'

integration('normalized runtime role and RLS integration', () => {
  let pool: Pool

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    await pool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES
        ($1::uuid, 'rls-tenant-one', 'RLS Tenant One'),
        ($2::uuid, 'rls-tenant-two', 'RLS Tenant Two')
      ON CONFLICT (id) DO NOTHING
    `, [tenantOneId, tenantTwoId])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES
        ($1::uuid, $2::uuid, 'rls-store-one', 'RLS Store One'),
        ($3::uuid, $2::uuid, 'rls-store-one-sibling', 'RLS Store One Sibling'),
        ($4::uuid, $5::uuid, 'rls-store-two', 'RLS Store Two')
      ON CONFLICT (id) DO NOTHING
    `, [storeOneId, tenantOneId, storeOneSiblingId, storeTwoId, tenantTwoId])
    await pool.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
      VALUES
        ($1::uuid, $2::uuid, $3::uuid, 'RLS_ONE', 'RLS Area One', 'indoor'),
        ($4::uuid, $2::uuid, $5::uuid, 'RLS_ONE_SIBLING', 'RLS Area One Sibling', 'indoor'),
        ($6::uuid, $7::uuid, $8::uuid, 'RLS_TWO', 'RLS Area Two', 'indoor')
      ON CONFLICT (id) DO NOTHING
    `, [areaOneId, tenantOneId, storeOneId, areaOneSiblingId, storeOneSiblingId,
      areaTwoId, tenantTwoId, storeTwoId])
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES
        ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'RLS01', 'RLS Table One', 4),
        ($5::uuid, $2::uuid, $6::uuid, $7::uuid, 'RLS01S', 'RLS Table One Sibling', 4),
        ($8::uuid, $9::uuid, $10::uuid, $11::uuid, 'RLS02', 'RLS Table Two', 4)
      ON CONFLICT (id) DO NOTHING
    `, [tableOneId, tenantOneId, storeOneId, areaOneId, tableOneSiblingId,
      storeOneSiblingId, areaOneSiblingId, tableTwoId, tenantTwoId, storeTwoId, areaTwoId])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('can reapply the runtime-role migration without role or grant conflicts', async () => {
    const migration = (await loadNormalizedMigrations()).find((item) => item.version === '010')
    expect(migration).toBeDefined()
    await expect(pool.query(migration!.sql)).resolves.toBeDefined()
    await expect(pool.query(migration!.sql)).resolves.toBeDefined()
  })

  it('creates a passwordless non-owner runtime role with least-privilege grants', async () => {
    const role = await pool.query<{
      rolcanlogin: boolean
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolreplication: boolean
      rolbypassrls: boolean
    }>(`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'mbox_runtime'
    `)
    expect(role.rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    })

    const privileges = await pool.query<{
      schema_usage: boolean
      schema_create: boolean
      metadata_select: boolean
      audit_insert: boolean
      audit_update: boolean
      outbox_update: boolean
      outbox_delete: boolean
      payment_update: boolean
      payment_delete: boolean
      missing_table_select: string
      missing_sequence_access: string
    }>(`
      SELECT
        has_schema_privilege('mbox_runtime', 'mbox', 'USAGE') AS schema_usage,
        has_schema_privilege('mbox_runtime', 'mbox', 'CREATE') AS schema_create,
        has_table_privilege('mbox_runtime', 'mbox.normalized_schema_migrations', 'SELECT') AS metadata_select,
        has_table_privilege('mbox_runtime', 'mbox.audit_events', 'INSERT') AS audit_insert,
        has_table_privilege('mbox_runtime', 'mbox.audit_events', 'UPDATE') AS audit_update,
        has_table_privilege('mbox_runtime', 'mbox.outbox_messages', 'UPDATE') AS outbox_update,
        has_table_privilege('mbox_runtime', 'mbox.outbox_messages', 'DELETE') AS outbox_delete,
        has_table_privilege('mbox_runtime', 'mbox.payments', 'UPDATE') AS payment_update,
        has_table_privilege('mbox_runtime', 'mbox.payments', 'DELETE') AS payment_delete,
        (
          SELECT count(*)::text
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'mbox'
            AND relation.relkind = 'r'
            AND relation.relname NOT IN ('normalized_schema_metadata', 'normalized_schema_migrations')
            AND NOT has_table_privilege(
              'mbox_runtime', format('%I.%I', namespace.nspname, relation.relname), 'SELECT'
            )
        ) AS missing_table_select,
        (
          SELECT count(*)::text
          FROM pg_class sequence
          JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
          WHERE namespace.nspname = 'mbox'
            AND sequence.relkind = 'S'
            AND (
              NOT has_sequence_privilege(
                'mbox_runtime', format('%I.%I', namespace.nspname, sequence.relname), 'USAGE'
              )
              OR NOT has_sequence_privilege(
                'mbox_runtime', format('%I.%I', namespace.nspname, sequence.relname), 'SELECT'
              )
            )
        ) AS missing_sequence_access
    `)
    expect(privileges.rows[0]).toEqual({
      schema_usage: true,
      schema_create: false,
      metadata_select: false,
      audit_insert: true,
      audit_update: false,
      outbox_update: true,
      outbox_delete: false,
      payment_update: true,
      payment_delete: false,
      missing_table_select: '0',
      missing_sequence_access: '0',
    })
  })

  it('keeps FORCE RLS enabled and PUBLIC access revoked', async () => {
    const rls = await pool.query<{ missing: string }>(`
      SELECT count(*)::text AS missing
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'mbox'
        AND relation.relkind = 'r'
        AND relation.relname NOT IN ('normalized_schema_metadata', 'normalized_schema_migrations')
        AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
    `)
    expect(rls.rows[0]?.missing).toBe('0')

    const publicAccess = await pool.query<{ exposed: string }>(`
      SELECT count(*)::text AS exposed
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
      WHERE namespace.nspname = 'mbox'
        AND relation.relkind = 'r'
        AND acl.grantee = 0
    `)
    expect(publicAccess.rows[0]?.exposed).toBe('0')
  })

  it('returns no rows and rejects writes when runtime scope is absent', async () => {
    await withRuntimeRole(pool, undefined, async (client) => {
      const visible = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM mbox.tables')
      expect(visible.rows[0]?.count).toBe('0')

      await expect(client.query(`
        INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'NO_SCOPE', 'No Scope', 'indoor')
      `, [tenantOneId, storeOneId])).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('cannot read or write another tenant or store while scoped', async () => {
    await withRuntimeRole(pool, { tenantId: tenantOneId, storeId: storeOneId }, async (client) => {
      const visible = await client.query<{ id: string }>('SELECT id FROM mbox.tables ORDER BY id')
      expect(visible.rows).toEqual([{ id: tableOneId }])

      const sameTenantOtherStore = await client.query<{ id: string }>(
        'SELECT id FROM mbox.tables WHERE id = $1::uuid',
        [tableOneSiblingId],
      )
      expect(sameTenantOtherStore.rows).toEqual([])

      const crossScopeUpdate = await client.query(`
        UPDATE mbox.areas SET name = 'Must Stay Hidden' WHERE id = $1::uuid
      `, [areaTwoId])
      expect(crossScopeUpdate.rowCount).toBe(0)

      await expect(client.query(`
        INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'CROSS_SCOPE', 'Cross Scope', 'indoor')
      `, [tenantTwoId, storeTwoId])).rejects.toMatchObject({ code: '42501' })
    })

    await withRuntimeRole(pool, { tenantId: tenantOneId, storeId: storeOneId }, async (client) => {
      await expect(client.query(`
        INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'CROSS_STORE', 'Cross Store', 'indoor')
      `, [tenantOneId, storeOneSiblingId])).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('allows scoped CRUD without granting ownership or RLS bypass', async () => {
    await withRuntimeRole(pool, { tenantId: tenantOneId, storeId: storeOneId }, async (client) => {
      const identity = await client.query<{ current_user: string; owner: string }>(`
        SELECT current_user, pg_get_userbyid(relation.relowner) AS owner
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'mbox' AND relation.relname = 'areas'
      `)
      expect(identity.rows[0]?.current_user).toBe('mbox_runtime')
      expect(identity.rows[0]?.owner).not.toBe('mbox_runtime')

      const inserted = await client.query<{ id: string }>(`
        INSERT INTO mbox.areas(tenant_id, store_id, code, name, area_type)
        VALUES ($1::uuid, $2::uuid, 'RLS_CRUD', 'RLS CRUD', 'other')
        RETURNING id
      `, [tenantOneId, storeOneId])
      const id = inserted.rows[0]!.id
      await expect(client.query(
        `UPDATE mbox.areas SET name = 'RLS CRUD Updated' WHERE id = $1::uuid`,
        [id],
      )).resolves.toMatchObject({ rowCount: 1 })
      await expect(client.query(
        'DELETE FROM mbox.areas WHERE id = $1::uuid',
        [id],
      )).resolves.toMatchObject({ rowCount: 1 })
    })
  })
})

async function withRuntimeRole(
  pool: Pool,
  scope: Readonly<{ tenantId: string; storeId: string }> | undefined,
  work: (client: PoolClient) => Promise<void>,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE mbox_runtime')
    if (scope) {
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`,
        [scope.tenantId, scope.storeId],
      )
    }
    await work(client)
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
