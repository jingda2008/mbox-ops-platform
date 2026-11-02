import { NormalizedApiError } from '../normalized-api'
import type { StaffAccessManagementOverview } from '../shared/normalized-contracts'

export type EmployeeOperation =
  | { action: 'create'; body: { employeeCode: string; displayName: string; roleId: string; reason: string } }
  | { action: 'status'; employeeId: string; body: { status: 'active' | 'suspended'; reason: string } }

export interface EmployeeOperationIntent {
  version: 1
  scopeKey: string
  actorEmployeeId: string
  key: string
  createdAt: string
  operation: EmployeeOperation
}

export interface EmployeeOperationResult {
  employeeId: string
  status: 'active' | 'suspended'
  verifiedAt: string
  replayed: boolean
  overview: StaffAccessManagementOverview
}

type StoragePort = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const flights = new Set<string>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Persist only public intent. The original PIN must be entered again for creation recovery. */
export class StaffEmployeeRecovery {
  private readonly prefix: string
  private readonly scopeKey: string
  private readonly actorEmployeeId: string
  private readonly storage: StoragePort
  constructor(scopeKey: string, actorEmployeeId: string, storage: StoragePort) {
    this.scopeKey = scopeKey; this.actorEmployeeId = actorEmployeeId; this.storage = storage
    this.prefix = `mbox.staff-employee-intent.v1:${scopeKey}:${actorEmployeeId}:`
  }

  pending(): EmployeeOperationIntent | null {
    const records: EmployeeOperationIntent[] = []
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)
      if (!key?.startsWith(this.prefix)) continue
      let value: unknown
      try { value = JSON.parse(this.storage.getItem(key) || 'null') }
      catch { throw new Error('原员工操作记录无法读取，请保留记录并联系管理员核对') }
      if (!validIntent(value, this.scopeKey, this.actorEmployeeId) || key !== this.prefix + value.key) {
        throw new Error('原员工操作记录无法读取，请保留记录并联系管理员核对')
      }
      records.push(value)
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))[0] ?? null
  }

  async execute(
    operation: EmployeeOperation | null,
    pin: string | undefined,
    send: (intent: EmployeeOperationIntent, pin: string | undefined, receiptOnly: boolean) => Promise<EmployeeOperationResult>,
  ): Promise<EmployeeOperationResult> {
    let intent = this.pending()
    const recovering = intent !== null
    if (intent && operation !== null) throw new Error('请先恢复原员工操作结果，再提交新的修改')
    const original = intent?.operation ?? operation
    if (!original) throw new Error('没有待恢复的员工操作，请重新读取')
    if (original.action === 'create' && !/^\d{4}$/.test(pin ?? '')) throw new Error('请输入原创建请求的4位PIN')
    if (!intent) {
      intent = JSON.parse(JSON.stringify({ version: 1, scopeKey: this.scopeKey, actorEmployeeId: this.actorEmployeeId,
        key: `staff-employee-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), operation })) as EmployeeOperationIntent
      if (!validIntent(intent, this.scopeKey, this.actorEmployeeId)) throw new Error('请核对员工操作内容')
      const record = JSON.stringify(intent)
      this.storage.setItem(this.prefix + intent.key, record)
      if (this.storage.getItem(this.prefix + intent.key) !== record) throw new Error('原操作未能安全保存，请恢复浏览器存储后再提交')
    }
    const storageKey = this.prefix + intent.key
    // Never share an in-flight success with another supplied PIN.
    if (flights.has(storageKey)) throw new Error('原员工操作正在核对，请等待结果')
    flights.add(storageKey)
    try {
      const result = await send(intent, original.action === 'create' ? pin : undefined, recovering)
      if (!result || !uuid.test(result.employeeId) || typeof result.replayed !== 'boolean'
        || !Number.isFinite(Date.parse(result.verifiedAt))
        || result.status !== (original.action === 'create' ? 'active' : original.body.status)
        || (original.action === 'status' && result.employeeId !== original.employeeId)) {
        throw new Error('员工操作回执尚未完成核对，请恢复原操作')
      }
      this.storage.removeItem(storageKey)
      return result
    } catch (error) {
      // A first-attempt 400 proves this newly generated command rolled back. On recovery,
      // even a 400 (e.g. invalid re-entered PIN) cannot disprove an earlier commit.
      if (!recovering && error instanceof NormalizedApiError && error.status === 400 && error.code === 'PERMISSION_DEPLOYMENT_INVALID') {
        this.storage.removeItem(storageKey)
      }
      throw error
    } finally { flights.delete(storageKey) }
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, min: number, max: number): value is string { return typeof value === 'string' && value.trim().length >= min && value.length <= max }
function validIntent(value: unknown, scopeKey: string, actorEmployeeId: string): value is EmployeeOperationIntent {
  if (!object(value) || !exactKeys(value, ['version','scopeKey','actorEmployeeId','key','createdAt','operation'])
    || value.version !== 1 || value.scopeKey !== scopeKey || value.actorEmployeeId !== actorEmployeeId
    || typeof value.key !== 'string' || !/^staff-employee-[0-9a-f-]{36}$/.test(value.key)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false
  const op = value.operation
  if (!object(op) || !object(op.body)) return false
  const body = op.body
  if (op.action === 'create') return exactKeys(op, ['action','body']) && exactKeys(body, ['employeeCode','displayName','roleId','reason'])
    && typeof body.employeeCode === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.employeeCode)
    && text(body.displayName,1,64) && typeof body.roleId === 'string' && uuid.test(body.roleId) && text(body.reason,2,200)
  return op.action === 'status' && exactKeys(op, ['action','employeeId','body']) && typeof op.employeeId === 'string' && uuid.test(op.employeeId)
    && exactKeys(body, ['status','reason']) && ['active','suspended'].includes(String(body.status)) && text(body.reason,2,200)
}
