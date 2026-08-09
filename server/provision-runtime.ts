import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import type { RuntimeState } from '../src/shared/contracts.js'
import { runtimeStateChecksum, serializeRuntimeState } from './postgres-repository.js'
import { tableOperationsConfig } from './table-sessions.js'

const REQUIRED_ARRAYS: Array<keyof RuntimeState> = [
  'areas',
  'tables',
  'employees',
  'shiftAssignments',
  'products',
  'awaitingOrderIntents',
  'tableTransfers',
  'waitlistEntries',
  'members',
  'benefitTemplates',
  'benefitGrantPolicies',
  'benefitGrantRequests',
  'memberBenefits',
  'benefitRedemptions',
  'benefitCampaigns',
  'customerNotifications',
  'configVersions',
  'tasks',
  'taskEvents',
  'auditEntries',
]

export function validateProvisionState(value: unknown, expectedStoreCode: string): RuntimeState {
  if (!value || typeof value !== 'object') throw new Error('初始化状态必须是JSON对象')
  const state = value as RuntimeState
  if (!Number.isSafeInteger(state.revision) || state.revision <= 0) throw new Error('revision必须是正整数')
  if (!state.store || state.store.id !== expectedStoreCode) throw new Error('状态中的store.id必须与MBOX_STORE_CODE一致')
  if (!state.store.name?.trim() || !state.store.timezone?.trim()) throw new Error('门店名称和时区不能为空')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.store.businessDate)) throw new Error('营业日必须是YYYY-MM-DD')
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(state[key])) throw new Error(`${String(key)}必须是数组`)
  }
  if (!state.orderDomain || !state.paymentDomain || !state.songState || !state.config) {
    throw new Error('订单、支付、演出和配置领域状态不能为空')
  }
  const tableCodes = state.tables.map((table) => table.code)
  if (new Set(tableCodes).size !== tableCodes.length) throw new Error('桌台编号不能重复')
  const employeeIds = new Set(state.employees.map((employee) => employee.id))
  for (const table of state.tables) {
    if (!employeeIds.has(table.primaryEmployeeId)) throw new Error(`桌台${table.code}主责员工不存在`)
    if (table.backupEmployeeIds.some((employeeId) => !employeeIds.has(employeeId))) {
      throw new Error(`桌台${table.code}候补员工不存在`)
    }
  }
  return state
}

interface ProvisionOptions {
  databaseUrl: string
  tenantId: string
  tenantCode: string
  tenantName: string
  storeUuid: string
  storeCode: string
  state: RuntimeState
}

export function assertProvisionIdentity(
  label: string,
  actual: Record<string, unknown> | undefined,
  expected: Record<string, string>,
) {
  if (!actual) throw new Error(`${label}写入后不可见，检查数据库权限和RLS配置`)
  const mismatch = Object.entries(expected).find(([key, value]) => String(actual[key] ?? '') !== value)
  if (mismatch) throw new Error(`${label}已存在但${mismatch[0]}不一致，拒绝复用生产身份`)
}

export async function provisionRuntime(options: ProvisionOptions) {
  const serialized = serializeRuntimeState(options.state)
  const rolloverHour = tableOperationsConfig(options.state).businessDayRolloverHour ?? 6
  const businessDayCutoff = `${String(rolloverHour).padStart(2, '0')}:00:00`
  const client = new Client({ connectionString: options.databaseUrl, application_name: 'mbox-provisioner' })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`,
      [options.tenantId, options.storeUuid],
    )
    await client.query(
      `INSERT INTO mbox.tenants(id, code, name) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [options.tenantId, options.tenantCode, options.tenantName],
    )
    await client.query(
      `INSERT INTO mbox.stores(id, tenant_id, code, name, timezone, business_day_cutoff)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::time)
       ON CONFLICT (id) DO NOTHING`,
      [options.storeUuid, options.tenantId, options.storeCode, options.state.store.name, options.state.store.timezone, businessDayCutoff],
    )
    const tenant = await client.query(
      `SELECT id::text, code, name FROM mbox.tenants WHERE id = $1::uuid`,
      [options.tenantId],
    )
    assertProvisionIdentity('租户', tenant.rows[0] as Record<string, unknown> | undefined, {
      id: options.tenantId,
      code: options.tenantCode,
      name: options.tenantName,
    })
    const store = await client.query(
      `SELECT id::text, tenant_id::text, code, name, timezone, business_day_cutoff::text FROM mbox.stores WHERE id = $1::uuid`,
      [options.storeUuid],
    )
    assertProvisionIdentity('门店', store.rows[0] as Record<string, unknown> | undefined, {
      id: options.storeUuid,
      tenant_id: options.tenantId,
      code: options.storeCode,
      name: options.state.store.name,
      timezone: options.state.store.timezone,
      business_day_cutoff: businessDayCutoff,
    })
    const result = await client.query(
      `INSERT INTO mbox.runtime_states(tenant_id, store_id, revision, state, state_sha256)
       VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5)
       ON CONFLICT (tenant_id, store_id) DO NOTHING`,
      [options.tenantId, options.storeUuid, options.state.revision, serialized, runtimeStateChecksum(serialized)],
    )
    if (result.rowCount !== 1) throw new Error('该租户门店已经初始化，拒绝覆盖生产状态')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const required = (name: string) => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`缺少${name}`)
    return value
  }
  if (process.env.MBOX_CONFIRM_PROVISION !== 'PROVISION') {
    throw new Error('初始化生产状态必须设置MBOX_CONFIRM_PROVISION=PROVISION')
  }
  const storeCode = required('MBOX_STORE_CODE')
  const state = validateProvisionState(
    JSON.parse(await readFile(resolve(required('MBOX_INITIAL_STATE_PATH')), 'utf8')) as unknown,
    storeCode,
  )
  await provisionRuntime({
    databaseUrl: required('DATABASE_URL'),
    tenantId: required('MBOX_TENANT_ID'),
    tenantCode: required('MBOX_TENANT_CODE'),
    tenantName: required('MBOX_TENANT_NAME'),
    storeUuid: required('MBOX_STORE_UUID'),
    storeCode,
    state,
  })
}
