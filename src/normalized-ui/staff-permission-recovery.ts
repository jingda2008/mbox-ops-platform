import type { StaffPermissionDeploymentChange, StaffPermissionDeploymentResult } from '../shared/normalized-contracts'

export interface PermissionDeploymentIntent {
  version: 1
  scopeKey: string
  employeeId: string
  key: string
  createdAt: string
  body: { expectedVersion: string; reason: string; changes: StaffPermissionDeploymentChange[] }
}

type StoragePort = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const flights = new Map<string, Promise<StaffPermissionDeploymentResult>>()

/** Each intent has its own durable key, so two tabs cannot overwrite each other's recovery. */
export class StaffPermissionRecovery {
  private readonly prefix: string
  private readonly scopeKey: string
  private readonly employeeId: string
  private readonly storage: StoragePort
  constructor(scopeKey: string, employeeId: string, storage: StoragePort) {
    this.scopeKey = scopeKey; this.employeeId = employeeId; this.storage = storage
    this.prefix = `mbox.staff-permission-intent.v1:${scopeKey}:${employeeId}:`
  }

  pending(): PermissionDeploymentIntent | null {
    const records: PermissionDeploymentIntent[] = []
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)
      if (!key?.startsWith(this.prefix)) continue
      const value: unknown = JSON.parse(this.storage.getItem(key) || 'null')
      if (!validIntent(value, this.scopeKey, this.employeeId) || key !== this.prefix + value.key) {
        throw new Error('原权限发布记录无法读取，请保留记录并联系管理员核对')
      }
      records.push(value)
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))[0] ?? null
  }

  async execute(
    body: PermissionDeploymentIntent['body'] | null,
    send: (intent: PermissionDeploymentIntent) => Promise<StaffPermissionDeploymentResult>,
  ): Promise<StaffPermissionDeploymentResult> {
    let intent = this.pending()
    if (!intent) {
      if (!body) throw new Error('没有待恢复的权限发布，请重新读取配置')
      intent = JSON.parse(JSON.stringify({ version: 1, scopeKey: this.scopeKey, employeeId: this.employeeId,
        key: `staff-access-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), body })) as PermissionDeploymentIntent
      if (!validIntent(intent, this.scopeKey, this.employeeId)) throw new Error('请重新读取权限配置并核对修改')
      const record = JSON.stringify(intent)
      this.storage.setItem(this.prefix + intent.key, record)
      if (this.storage.getItem(this.prefix + intent.key) !== record) throw new Error('原操作未能安全保存，请恢复浏览器存储后再发布')
    }
    const storageKey = this.prefix + intent.key
    const running = flights.get(storageKey)
    if (running) return running
    const execution = send(intent).then((result) => {
      if (result.status !== 'verified' || result.changes.some((change) => !change.applied)) throw new Error('发布回执尚未完成复核，请恢复原操作')
      this.storage.removeItem(storageKey)
      return result
    }).catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      // These responses prove this exact command did not change configuration.
      // Authentication loss and ambiguous failures retain the original intent.
      if (code === 'STAFF_ACCESS_VERSION_CONFLICT' || code === 'PERMISSION_DEPLOYMENT_INVALID') this.storage.removeItem(storageKey)
      throw error
    }).finally(() => { flights.delete(storageKey) })
    flights.set(storageKey, execution)
    return execution
  }
}

function validIntent(value: unknown, scopeKey: string, employeeId: string): value is PermissionDeploymentIntent {
  if (!value || typeof value !== 'object') return false
  const item = value as PermissionDeploymentIntent
  return item.version === 1 && item.scopeKey === scopeKey && item.employeeId === employeeId
    && typeof item.key === 'string' && /^staff-access-[0-9a-f-]{36}$/.test(item.key)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && Boolean(item.body) && typeof item.body.expectedVersion === 'string' && /^[0-9a-f]{64}$/.test(item.body.expectedVersion)
    && typeof item.body.reason === 'string' && item.body.reason.trim().length >= 2
    && Array.isArray(item.body.changes) && item.body.changes.length > 0 && item.body.changes.length <= 100
}
