import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { ownerFinanceApiPlugin } from './owner-finance-api.js'
import { commercialOpsApiPlugin } from './commercial-ops-api.js'
import { ProfitQueryService } from './profit-query-service.js'
import { StaffAccessRepository } from './staff-access-repository.js'

const database = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database && runtimeUrl ? describe : describe.skip)('finance dashboard with restricted database login', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const financeId = randomUUID(), deniedId = randomUUID(), roleId = randomUUID()
  let admin: Pool, runtime: Pool, app: FastifyInstance, actor = financeId
  let transactions: ScopedPostgresTransactionRunner
  const body = { displayName: '财务录入租金', category: 'rent', recognitionState: 'actual', allocationPeriod: 'month', serviceStartDate: '2026-10-01', serviceEndDate: '2026-10-31', cashPaidOn: '2026-10-20', amountMinor: 10600, currency: 'CNY', sourceType: 'lease' }
  const send = (path: string, payload: object, key = randomUUID()) => app.inject({ method: 'POST', url: '/api/commercial-ops' + path, headers: { 'idempotency-key': key }, payload })
  const get = async () => {
    const response = await app.inject('/api/commercial-ops/owner-finance?startDate=2026-10-01&endDate=2026-10-31')
    expect(response.statusCode, response.body).toBe(200)
    return response.json().data
  }
  beforeAll(async () => {
    await runNormalizedMigrations(database!)
    admin = new Pool({ connectionString: database }); runtime = new Pool({ connectionString: runtimeUrl })
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Finance dashboard')", [scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Finance dashboard')", [scope.storeId, scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'FINANCE','财务'),($4,$2,$3,'NOACCESS','无权限')", [financeId, scope.tenantId, scope.storeId, deniedId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'FINANCE','财务')", [roleId, scope.tenantId, scope.storeId])
    await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)', [scope.tenantId, scope.storeId, financeId, roleId])
    transactions = new ScopedPostgresTransactionRunner(runtime)
    const common = { transactions, commandExecutor: new NormalizedCommandExecutor(transactions), resolveContext: () => ({ scope, employeeId: actor, businessDate: '2026-10-20', capabilities: [] }) }
    app = Fastify()
    await app.register(ownerFinanceApiPlugin, { ...common, prefix: '/api' })
    await app.register(commercialOpsApiPlugin, { ...common, prefix: '/api', queryService: new ProfitQueryService(transactions) })
    await app.ready()
  })
  afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end() })

  it('grants expense read and management without granting payroll or inventory writes', async () => {
    const access = await transactions.run(scope, tx => new StaffAccessRepository(tx).resolve(financeId))
    expect(access.permissions).toEqual(expect.arrayContaining(['commercial.cost.view', 'commercial.cost.manage']))
    for (const permission of ['commercial.payroll.view', 'commercial.payroll.manage', 'commercial.payroll.post', 'inventory.receive', 'staff.access.manage']) expect(access.permissions).not.toContain(permission)
    expect(await get()).toMatchObject({ canViewCost: true, canViewPayroll: false, employees: [], compensationRules: [], payrollRuns: [], payrollLines: [] })
  })
  it('repairs an existing finance role with exactly the two expense grants', async () => {
    await admin.query(`DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p
      WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code IN ('commercial.cost.view','commercial.cost.manage')`, [roleId])
    const before = await transactions.run(scope, tx => new StaffAccessRepository(tx).resolve(financeId))
    const migration = await readFile('database/normalized-migrations/271_finance_cost_management.sql', 'utf8')
    const backfill = migration.match(/INSERT INTO mbox.role_permission_assignments[\s\S]+?DO NOTHING;/)![0]
    await admin.query(backfill)
    await admin.query(backfill)
    const after = await transactions.run(scope, tx => new StaffAccessRepository(tx).resolve(financeId))
    expect(after.permissions.filter(p => !before.permissions.includes(p)).sort()).toEqual(['commercial.cost.manage','commercial.cost.view'])
    expect(before.permissions.every(p => after.permissions.includes(p))).toBe(true)
  })
  it('records one amount, rereads it and corrects it once while preserving the old entry', async () => {
    const key = randomUUID()
    const first = await send('/costs', body, key)
    expect(first.statusCode, first.body).toBe(201)
    const id = first.json().data.id
    expect((await send('/costs', body, key)).json()).toMatchObject({ replayed: true, data: { id } })
    expect((await get()).costs.find((x: any) => x.id === id)).toMatchObject({ grossAmountMinor: 10600, netAmountMinor: 10600, taxAmountMinor: 0, corrected: false })
    const update = { ...body, amountMinor: 12000, correctionReason: '核对原票据后修改' }
    const updated = await send(`/costs/${id}/corrections`, update)
    expect(updated.statusCode, updated.body).toBe(201)
    const costs = (await get()).costs
    expect(costs.find((x: any) => x.id === id)).toMatchObject({ grossAmountMinor: 10600, corrected: true })
    expect(costs.find((x: any) => x.id === updated.json().data.id)).toMatchObject({ grossAmountMinor: 12000, taxAmountMinor: 0, correctsCostEntryId: id, correctionReason: update.correctionReason })
    expect(costs.filter((x: any) => !x.corrected).reduce((sum: number, x: any) => sum + x.grossAmountMinor, 0)).toBe(12000)
    expect((await send(`/costs/${id}/corrections`, update)).statusCode).toBe(409)
  })
  it('keeps a historic split amount intact when edited through the single amount contract', async () => {
    const { amountMinor: _, ...legacy } = body
    const response = await send('/costs', { ...legacy, netAmountMinor: 10000, taxAmountMinor: 600 })
    expect(response.statusCode, response.body).toBe(201)
    const updated = await send(`/costs/${response.json().data.id}/corrections`, { ...body, correctionReason: '仅改备注保留总金额', note: '金额未变' })
    expect(updated.statusCode, updated.body).toBe(201)
    expect(updated.json().data).toMatchObject({ grossAmountMinor: 10600, taxAmountMinor: 0 })
  })
  it('materializes recurring single amounts without a tax calculation or duplicate entries', async () => {
    const board = await get()
    const response = await send('/recurring-costs', { name: '单金额周期', categoryDefinitionId: board.categories.find((x: any) => x.code === 'rent').id, costCenterId: board.costCenters[0].id, recurrence: 'day', recognitionState: 'accrual', startsOn: '2026-10-20', amountMinor: 8888, sourceType: 'lease' })
    expect(response.statusCode, response.body).toBe(201)
    const first = await send('/recurring-costs/materialize', { throughDate: '2026-10-20' })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().data.createdCount).toBe(1)
    expect((await send('/recurring-costs/materialize', { throughDate: '2026-10-20' })).json().data.createdCount).toBe(0)
    expect((await get()).costs.find((x: any) => x.recurringRuleId === response.json().data.id)).toMatchObject({ grossAmountMinor: 8888, taxAmountMinor: 0 })
    const ruleId = response.json().data.id
    const update = { ruleId, expectedVersion: 1, changeReason: '下次金额调整', name: '单金额周期已修改', categoryDefinitionId: board.categories.find((x: any) => x.code === 'rent').id, costCenterId: board.costCenters[0].id, recurrence: 'day', recognitionState: 'accrual', startsOn: '2026-10-20', amountMinor: 9900, sourceType: 'lease' }
    const key = randomUUID()
    expect((await send('/recurring-costs', update, key)).statusCode).toBe(201)
    expect((await send('/recurring-costs', update, key)).json().replayed).toBe(true)
    expect((await send('/recurring-costs', update)).statusCode).toBe(409)
    expect((await send('/recurring-costs', { ...update, expectedVersion: 2, startsOn: '2026-10-19' })).statusCode).toBe(400)
    expect((await send('/recurring-costs/materialize', { throughDate: '2026-10-21' })).json().data.createdCount).toBe(1)
    const generated = (await get()).costs.filter((x: any) => x.recurringRuleId === ruleId)
    expect(generated.map((x: any) => x.grossAmountMinor).sort()).toEqual([8888, 9900])
    expect((await get()).recurringRules.find((x: any) => x.id === ruleId)).toMatchObject({ name: update.name, version: 2, grossAmountMinor: 9900 })

  })
  it('does not let expense management bypass payroll or purchasing workflows', async () => {
    expect((await send('/costs', { ...body, sourceType: 'payroll', category: 'personnel' })).statusCode).toBe(403)
    expect((await send('/costs', { ...body, sourceType: 'inventory_purchase', category: 'beverage_purchase' })).statusCode).toBe(403)
    const protectedId = randomUUID()
    await admin.query(`INSERT INTO mbox.operating_cost_entries(id,tenant_id,store_id,public_id,category,recognition_state,allocation_period,service_start_date,service_end_date,net_amount_minor,tax_amount_minor,currency,source_type,recorded_business_date,recorded_by_employee_id)
      VALUES($1::uuid,$2,$3,$1::text,'personnel','actual','month','2026-10-01','2026-10-31',30000,0,'CNY','payroll','2026-10-20',$4)`, [protectedId, scope.tenantId, scope.storeId, financeId])
    expect((await send(`/costs/${protectedId}/corrections`, { ...body, correctionReason: '不能将工资改成租金' })).statusCode).toBe(403)
  })
  it('protects legacy payroll rules from reclassification, state changes and generation', async () => {
    const board = await get(), protectedRule = randomUUID()
    const categoryId = board.categories.find((x: any) => x.code === 'rent').id
    const costCenterId = board.costCenters[0].id
    // The legacy schema allows payroll rules even though new creation now uses
    // the payroll workflow. Test the stored source, not only the incoming category.
    await admin.query(`INSERT INTO mbox.recurring_operating_cost_rules(id,tenant_id,store_id,public_id,name,category_definition_id,cost_center_id,recurrence,starts_on,allocation_period,recognition_state,net_amount_minor,tax_amount_minor,currency,source_type,created_by_employee_id)
      VALUES($1::uuid,$2,$3,$1::text,'历史工资周期',$4,$5,'day','2026-10-20','day','accrual',30000,0,'CNY','payroll',$6)`, [protectedRule,scope.tenantId,scope.storeId,categoryId,costCenterId,financeId])
    try {
      expect((await send('/recurring-costs', { ruleId: protectedRule, expectedVersion: 1, changeReason: '不得绕过工资权限', name: '改为租金', categoryDefinitionId: categoryId, costCenterId, recurrence: 'day', startsOn: '2026-10-20', recognitionState: 'accrual', amountMinor: 1, sourceType: 'lease' })).statusCode).toBe(403)
      expect((await send(`/recurring-costs/${protectedRule}/status`, { status: 'paused', reason: '不得绕过工资权限' })).statusCode).toBe(403)
      expect((await send('/recurring-costs/materialize', { throughDate: '2026-10-21' })).statusCode).toBe(403)
      expect((await admin.query('SELECT source_type,version,status FROM mbox.recurring_operating_cost_rules WHERE id=$1',[protectedRule])).rows[0]).toEqual({ source_type: 'payroll', version: 1, status: 'active' })
      expect((await admin.query('SELECT count(*)::int AS count FROM mbox.operating_cost_entries WHERE recurring_rule_id=$1',[protectedRule])).rows[0].count).toBe(0)
    } finally { await admin.query('DELETE FROM mbox.recurring_operating_cost_rules WHERE id=$1',[protectedRule]) }
  })
  it('rejects ambiguous amounts, invalid precision, and unauthorised writes and reads', async () => {
    for (const extra of [{ netAmountMinor: 10 }, { taxAmountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 0.1 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect((await send('/costs', { ...body, ...extra })).statusCode).toBe(400)
    }
    actor = deniedId
    try {
      expect((await send('/costs', body)).statusCode).toBe(403)
      expect((await app.inject('/api/commercial-ops/owner-finance')).statusCode).toBe(403)
    } finally { actor = financeId }
  })
})
