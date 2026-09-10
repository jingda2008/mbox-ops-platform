import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { DEFAULT_STACKING_POLICY } from './stacking-pricing.js'
import { StackingPricingDraftRepository } from './stacking-pricing-draft-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('stacking drafts durable concurrency and isolation', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const employeeId = randomUUID()
  const approver=randomUUID(),publisher=randomUUID(),unauthorized=randomUUID(),role=randomUUID()
  const foreignStore = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query('INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,$2)', [scope.tenantId, `stack-${scope.tenantId}`])
    await pool.query('INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$4,$4),($3,$2,$5,$5)', [scope.storeId, scope.tenantId, foreignStore, `store-${scope.storeId}`, `store-${foreignStore}`])
    await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)', [employeeId, scope.tenantId, scope.storeId, `staff-${employeeId}`])
    for(const id of [approver,publisher,unauthorized])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,`staff-${id}`])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'STACKING_TEST','Stacking release test')",[role,scope.tenantId,scope.storeId])
    for(const id of [employeeId,approver,publisher])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,id,role])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN('loyalty.configuration.approve','loyalty.policy.publish')",[scope.tenantId,scope.storeId,role])
  }, 30_000)
  afterAll(async () => pool?.end())
  const input = (code: string) => ({ code, policy: DEFAULT_STACKING_POLICY, employeeId, businessDate: '2026-09-09', reason: '隔离规则试算', requestKey: randomUUID(), expectedVersion: 0 })
  const save = (command: ReturnType<typeof input>) => transactions.run(scope, transaction => new StackingPricingDraftRepository(transaction).save(command))
  it('replays a lost response without a second draft or audit event', async () => {
    const command = input('REPLAY')
    const first = await save(command)
    const replay = await save(command)
    expect(first.status).toBe('draft')
    expect(replay).toEqual({ ...first, replayed: true })
    const count = await pool.query('SELECT count(*)::integer AS count FROM mbox.audit_events WHERE object_id=$1 AND action=$2', [first.id, 'stacking_pricing.draft_saved'])
    expect(count.rows[0].count).toBe(1)
    await expect(save({ ...command, reason: '修改同一操作内容' })).rejects.toThrow('内容已变化')
  })
  it('allows only one concurrent successor; preserves prior typed version', async () => {
    const command = input('VERSIONED')
    await save(command)
    const results = await Promise.allSettled([
      save({ ...command, requestKey: randomUUID(), expectedVersion: 1 }),
      save({ ...command, requestKey: randomUUID(), expectedVersion: 1 }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const rows = await transactions.run(scope, transaction => new StackingPricingDraftRepository(transaction).list(), { readOnly: true })
    expect(rows.filter(row => row.code === 'VERSIONED').map(row => row.version)).toEqual([2, 1])
  })
  it('enforces runtime store isolation and forbids rewriting old drafts', async () => {
    await save(input('ISOLATED'))
    const rows = await transactions.run({ ...scope, storeId: foreignStore }, async transaction => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      return transaction.query('SELECT id FROM mbox.stacking_pricing_drafts')
    }, { readOnly: true })
    expect(rows.rows).toHaveLength(0)
    await expect(transactions.run(scope, async transaction => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      await transaction.query('UPDATE mbox.stacking_pricing_drafts SET minimum_payable_minor=0')
    })).rejects.toThrow('permission denied')
  })
  it('requires independent approval/publication and retains stopped promises without allowing new issuance',async()=>{
    const draft=await save({...input('RELEASE'),policy:{...DEFAULT_STACKING_POLICY,allowCheckoutUpgrade:true}})
    const decide=(action:'approve'|'publish'|'stop_issuing',actor:string)=>transactions.run(scope,tx=>new StackingPricingDraftRepository(tx).decide({versionId:draft.id,action,employeeId:actor,businessDate:'2026-09-09',reason:'验证版本独立审批'}))
    const issuance=()=>transactions.run(scope,tx=>new StackingPricingDraftRepository(tx).publishedForIssuance(draft.id))
    await expect(issuance()).rejects.toThrow('尚未发布')
    await expect(decide('approve',employeeId)).rejects.toThrow('非编辑人')
    await expect(decide('approve',unauthorized)).rejects.toThrow()
    expect((await decide('approve',approver)).status).toBe('approved')
    await expect(decide('publish',approver)).rejects.toThrow('不同于')
    const published=await decide('publish',publisher)
    expect(published.status).toBe('published')
    expect(await decide('publish',publisher)).toEqual(published)
    expect((await issuance()).policy.allowCheckoutUpgrade).toBe(true)
    expect((await decide('stop_issuing',publisher)).status).toBe('stopped')
    await expect(issuance()).rejects.toThrow('已停发')
    const retained=await transactions.run(scope,tx=>new StackingPricingDraftRepository(tx).find(draft.id))
    expect(retained.policy).toEqual(published.policy)
    expect(retained.decisions.map(d=>d.action)).toEqual(['approve','publish','stop_issuing'])
  })
  it('enforces immutable typed drafts and independent release even through direct database writes',async()=>{
    const draft=await save(input('DB_ENFORCED'))
    await expect(pool.query('UPDATE mbox.stacking_pricing_drafts SET allow_checkout_upgrade=true WHERE id=$1',[draft.id])).rejects.toThrow()
    await expect(pool.query("INSERT INTO mbox.stacking_pricing_decisions(tenant_id,store_id,version_id,action,employee_id,reason) VALUES($1,$2,$3,'publish',$4,'不允许绕过审核')",[scope.tenantId,scope.storeId,draft.id,publisher])).rejects.toThrow('three distinct')
    await expect(pool.query("INSERT INTO mbox.stacking_pricing_decisions(tenant_id,store_id,version_id,action,employee_id,reason) VALUES($1,$2,$3,'approve',$4,'不允许自己审核')",[scope.tenantId,scope.storeId,draft.id,employeeId])).rejects.toThrow('author')
  })
})
