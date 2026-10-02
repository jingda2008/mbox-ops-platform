// A single pending responsibility command per browser tab. Storage succeeds before
// dispatch; confirmed commands stay journaled until a fresh list has been read.
export type AssignmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface AssignmentOwner { employeeId: string | null; sessionId: string | null }
interface Attempt {
  version: 1
  owner: AssignmentOwner
  path: string
  key: string
  intent: string
  body: string
  confirmed: boolean
}
export interface AssignmentRecoverySummary { message: string; canRecover: boolean }
const storageKey = 'mbox.assignment-recovery.v1'
export class AssignmentRecoveryError extends Error {
  readonly code = 'ASSIGNMENT_RECOVERY_REQUIRED'
}
export function stableAssignmentIntent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableAssignmentIntent).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableAssignmentIntent(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export class AssignmentRecovery {
  private flight: { intent: string; promise: Promise<void> } | null = null
  private readonly storage: AssignmentStorage | undefined
  private readonly owner: () => AssignmentOwner
  private readonly send: (path: string, body: string, key: string) => Promise<void>
  constructor(storage: AssignmentStorage | undefined, owner: () => AssignmentOwner,
    send: (path: string, body: string, key: string) => Promise<void>) {
    this.storage = storage; this.owner = owner; this.send = send
  }

  private read(): Attempt | null {
    try {
      if (!this.storage) throw new Error()
      const raw = this.storage.getItem(storageKey)
      if (raw === null) return null
      const a = JSON.parse(raw) as Attempt
      if (a.version !== 1 || !a.owner || typeof a.owner.employeeId !== 'string' || !a.owner.employeeId
        || (a.owner.sessionId !== null && typeof a.owner.sessionId !== 'string')
        || typeof a.key !== 'string' || a.key.length < 8 || typeof a.intent !== 'string'
        || typeof a.body !== 'string' || typeof a.confirmed !== 'boolean'
        || !/^\/api\/table-management\/guarded-assignments\/(batch|[a-zA-Z0-9-]+\/end)$/.test(a.path)) throw new Error()
      const body = JSON.parse(a.body)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
      return a
    } catch { throw new AssignmentRecoveryError('责任操作记录无法安全读取，请勿重复提交，请联系主管核对原操作') }
  }
  private owns(a: Attempt): boolean {
    const owner = this.owner()
    return owner.employeeId !== null && a.owner.employeeId === owner.employeeId
  }
  private write(a: Attempt) {
    try {
      if (!this.storage) throw new Error()
      const value = JSON.stringify(a)
      this.storage.setItem(storageKey, value)
      if (this.storage.getItem(storageKey) !== value) throw new Error()
    } catch { throw new AssignmentRecoveryError('责任操作记录无法安全保存，请检查浏览器存储后恢复原操作') }
  }
  private clear(a: Attempt) {
    try {
      if (this.read()?.key !== a.key) throw new Error()
      this.storage!.removeItem(storageKey)
      if (this.storage!.getItem(storageKey) !== null) throw new Error()
    } catch { throw new AssignmentRecoveryError('原操作记录未能清除，请恢复原操作；不会重新提交已确认的操作') }
  }
  summary(): AssignmentRecoverySummary | null {
    try {
      const a = this.read()
      if (!a) return null
      if (!this.owns(a)) return { message: '此页有其他员工的责任操作待核对，请切回原员工后恢复', canRecover: false }
      return { message: a.confirmed ? '原责任操作已确认，需刷新列表后继续' : '原责任操作结果待核对，请恢复原操作后再安排或结束责任', canRecover: true }
    } catch (error) { return { message: (error as Error).message, canRecover: false } }
  }
  confirmedReadToken(): string | null {
    const a = this.read()
    return a?.confirmed && this.owns(a) ? a.key : null
  }
  async acknowledgeRead(key: string | null): Promise<void> {
    if (key === null) return
    const a = this.read()
    if (a?.key === key && a.confirmed && this.owns(a) && !this.flight) this.clear(a)
  }
  run(intent: string, make: () => { path: string; body: object; key: string }): Promise<void> {
    if (this.flight) {
      if (this.flight.intent !== intent) return Promise.reject(new AssignmentRecoveryError('请先恢复上一次责任操作，再提交新安排'))
      return this.flight.promise
    }
    let a: Attempt
    try {
      const existing = this.read()
      if (existing) {
        if (!this.owns(existing)) throw new AssignmentRecoveryError('请切回原员工核对责任操作，不会以当前员工重放')
        if (existing.intent !== intent) throw new AssignmentRecoveryError('请先恢复上一次责任操作，不能改动待确认的桌台、人员或时间')
        a = existing
      } else {
        const owner = this.owner()
        if (!owner.employeeId) throw new AssignmentRecoveryError('请先刷新人员与责任桌，确认当前员工身份')
        const command = make()
        a = { version: 1, owner, path: command.path, body: JSON.stringify(command.body), key: command.key, intent, confirmed: false }
        this.write(a)
      }
    } catch (error) { return Promise.reject(error) }
    const promise = this.dispatch(a).finally(() => { this.flight = null })
    this.flight = { intent, promise }
    return promise
  }
  recover(): Promise<void> {
    try {
      const a = this.read()
      if (!a) return Promise.resolve()
      return this.run(a.intent, () => { throw new Error('Original request is required') })
    } catch (error) { return Promise.reject(error) }
  }
  private async dispatch(a: Attempt): Promise<void> {
    if (a.confirmed) return
    try { await this.send(a.path, a.body, a.key) }
    catch (error) {
      const e = error as { status?: number; code?: string; commitDisposition?: string }
      if (e.status === 409 && e.code === 'TABLE_ASSIGNMENT_NOT_COMMITTED' && e.commitDisposition === 'not_committed'
        || e.status === 400 && e.code === 'TABLE_REQUEST_INVALID') this.clear(a)
      throw error
    }
    // The server may have succeeded even when this write fails: retain the same
    // original request and let its guarded server receipt resolve the next retry.
    this.write({ ...a, confirmed: true })
  }
}

export function validateAssignmentReceipt(value: unknown, path: string, originalBody: string, actorId: string): void {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const reject = (): never => { throw new AssignmentRecoveryError('责任操作回执与原请求不一致，请保留原操作并核对') }
  const parseTime = (value: string) => Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
  const timeEquals = (a: unknown, b: unknown) => a === null && b === null
    || typeof a === 'string' && typeof b === 'string' && Number.isFinite(parseTime(a)) && parseTime(a) === parseTime(b)
  const body = JSON.parse(originalBody) as Record<string, unknown>
  if (!object(value) || !object(value.data) || typeof value.data.id !== 'string' || !value.data.id
    || !object(value.meta) || typeof value.meta.replayed !== 'boolean') return reject()
  if (path.endsWith('/batch')) {
    const rows = value.data.assignments
    const tables = body.tableIds
    if (!Array.isArray(rows) || !Array.isArray(tables) || rows.length !== tables.length || !rows.length) return reject()
    const actualTables = new Set<string>(), ids = new Set<string>()
    for (const row of rows) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)
        || typeof row.tableId !== 'string' || !tables.includes(row.tableId) || actualTables.has(row.tableId)
        || row.createdByEmployeeId !== actorId) return reject()
      for (const key of ['employeeId', 'roleId', 'assignmentType', 'reason']) if (row[key] !== body[key]) return reject()
      if (!timeEquals(row.startsAt, body.startsAt) || !timeEquals(row.endsAt, body.endsAt)) return reject()
      actualTables.add(row.tableId); ids.add(row.id)
    }
  } else {
    if (path !== `/api/table-management/guarded-assignments/${encodeURIComponent(value.data.id)}/end`
      || !timeEquals(value.data.endsAt, body.endsAt)) return reject()
  }
}
