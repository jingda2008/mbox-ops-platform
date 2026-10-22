import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerRepository } from './customer-repository.js'
import { bindVerifiedWechatIdentityToMember } from './membership-enrollment-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const id = Object.freeze({
  tenant: randomUUID(),
  store: randomUUID(),
  member: randomUUID(),
  guest: randomUUID(),
  otherMember: randomUUID(),
})
const principalHash = (label: string) => createHash('sha256').update(`wechat:${label}-${id.tenant}`).digest('hex')

integration('bind verified wechat identity on membership claim', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  const scope = { tenantId: id.tenant, storeId: id.store }

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Wechat bind tenant')`, [
      id.tenant, `wxbind-${id.tenant.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Wechat bind store')`, [
      id.store, id.tenant, `wxbind-${id.store.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      SELECT customer_id,$2,$3,'wxbind-'||substr(replace(customer_id::text,'-',''),1,16),'active'
      FROM unnest($1::uuid[]) AS customer_id
    `, [[id.member, id.guest, id.otherMember], id.tenant, id.store])
    await pool.query(`
      INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no)
      VALUES($1,$2,$3,'100001'),($1,$2,$4,'100002')
    `, [id.tenant, id.store, id.member, id.otherMember])
  })

  afterAll(async () => pool?.end())

  const bind = (hash: string) => runner.run(scope, (transaction) =>
    bindVerifiedWechatIdentityToMember(transaction, id.member, hash))
  const owner = (hash: string) => runner.run(scope, async (transaction) =>
    (await new CustomerRepository(transaction).findByIdentity('wechat', hash))?.id ?? null)

  it('links an unbound verified wechat identity to the claimed member', async () => {
    const hash = principalHash('fresh')
    expect(await bind(hash)).toBe('linked')
    expect(await owner(hash)).toBe(id.member)
  })

  it('is idempotent when the identity is already bound to the same member', async () => {
    const hash = principalHash('fresh')
    expect(await bind(hash)).toBe('already_linked')
    expect(await bind(hash)).toBe('already_linked')
    expect(await owner(hash)).toBe(id.member)
  })

  it('moves the identity off a membership-less guest customer', async () => {
    const hash = principalHash('guest')
    await runner.run(scope, (transaction) =>
      new CustomerRepository(transaction).linkIdentity(id.guest, 'wechat', hash))
    expect(await bind(hash)).toBe('moved_from_guest')
    expect(await owner(hash)).toBe(id.member)
  })

  it('never steals an identity that belongs to another member', async () => {
    const hash = principalHash('other-member')
    await runner.run(scope, (transaction) =>
      new CustomerRepository(transaction).linkIdentity(id.otherMember, 'wechat', hash))
    expect(await bind(hash)).toBe('conflict_other_member')
    expect(await owner(hash)).toBe(id.otherMember)
  })

  it('rejects anything that is not a server-computed principal hash', async () => {
    await expect(bind('not-a-hash')).rejects.toThrow(/invalid wechat principal hash/)
  })
})
