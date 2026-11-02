import { describe, expect, it, vi } from 'vitest'
import { NormalizedApiError } from '../normalized-api'
import { StaffEmployeeRecovery, type EmployeeOperation, type EmployeeOperationResult } from './staff-employee-recovery'

const employeeId = '33333333-3333-4333-8333-333333333333'
const roleId = '44444444-4444-4444-8444-444444444444'
const create: EmployeeOperation = { action: 'create', body: { employeeCode: 'LOCAL', displayName: 'Local', roleId, reason: 'Local audit' } }
const status: EmployeeOperation = { action: 'status', employeeId, body: { status: 'suspended', reason: 'Local audit' } }
const result = (operation: EmployeeOperation): EmployeeOperationResult => ({ employeeId, status: operation.action === 'create' ? 'active' : operation.body.status, verifiedAt: '2026-11-02T00:00:00Z', replayed: true, overview: { generatedAt: '', scopeKey: 'tenant:store', configurationVersion: 'a'.repeat(64), roles: [], employees: [], permissions: [], areas: [], configurationDefinitions: [] } })
function storage() {
  const values = new Map<string,string>()
  return { values, get length() { return values.size }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value) }, removeItem: (key: string) => { values.delete(key) } }
}
const network = () => new NormalizedApiError('lost response', 'network', 'retry')
const invalid = () => new NormalizedApiError('invalid', 'http', 'none', 400, 'PERMISSION_DEPLOYMENT_INVALID')

describe('employee original-intent recovery without persisted PIN', () => {
  it.each([create,status])('restores $action after reload with exactly the original key and content', async operation => {
    const saved = storage(), recovery = new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(operation,'4826',async () => { throw network() })).rejects.toThrow('lost response')
    const original = recovery.pending()!
    expect(Object.values(JSON.parse([...saved.values.values()][0]!).operation.body)).not.toContain('4826')
    expect(JSON.stringify([...saved.values.values()])).not.toContain('"pin"')
    const reloaded = new StaffEmployeeRecovery('tenant:store','admin',saved)
    const send = vi.fn(async () => result(operation))
    await reloaded.execute(null, operation.action === 'create' ? '4826' : undefined, send)
    expect(send).toHaveBeenCalledWith(original, operation.action === 'create' ? '4826' : undefined, true)
    expect(reloaded.pending()).toBeNull()
  })
  it('blocks changed drafts rather than silently succeeding with an old operation', async () => {
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(create,'4826',async()=>{throw network()})).rejects.toThrow()
    const original=recovery.pending(), send=vi.fn()
    await expect(recovery.execute({...create,body:{...create.body,displayName:'Changed'}},'7391',send)).rejects.toThrow('先恢复')
    expect(send).not.toHaveBeenCalled();expect(recovery.pending()).toEqual(original)
  })
  it.each(['','12','abcd'])('requires the original PIN on recovery: %s',async pin=>{
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(create,'4826',async()=>{throw network()})).rejects.toThrow()
    const send=vi.fn();await expect(recovery.execute(null,pin,send)).rejects.toThrow('原创建请求')
    expect(send).not.toHaveBeenCalled();expect(recovery.pending()).not.toBeNull()
  })
  it.each([401,403,404,409,500,400])('retains prior uncertain intent after HTTP %s',async code=>{
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(create,'4826',async()=>{throw network()})).rejects.toThrow()
    const original=recovery.pending()
    await expect(recovery.execute(null,'7391',async()=>{throw code===400?invalid():new NormalizedApiError('rejected','http','retry',code)})).rejects.toThrow()
    expect(recovery.pending()).toEqual(original)
  })
  it('allows correcting a definitively rejected first request with a fresh key',async()=>{
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved);let oldKey=''
    await expect(recovery.execute(create,'4826',async intent=>{oldKey=intent.key;throw invalid()})).rejects.toThrow()
    expect(recovery.pending()).toBeNull()
    await recovery.execute(create,'4826',async intent=>{expect(intent.key).not.toBe(oldKey);return result(create)})
  })
  it('isolates actor and store and cannot discover another identity intent',async()=>{
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(create,'4826',async()=>{throw network()})).rejects.toThrow()
    expect(new StaffEmployeeRecovery('tenant:other','admin',saved).pending()).toBeNull()
    expect(new StaffEmployeeRecovery('tenant:store','other',saved).pending()).toBeNull()
  })
  it('does not share an in-flight success with a second PIN or send twice',async()=>{
    const saved=storage(), recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    let finish!: (value:EmployeeOperationResult)=>void
    const send=vi.fn(()=>new Promise<EmployeeOperationResult>(resolve=>{finish=resolve}))
    const first=recovery.execute(create,'4826',send)
    await expect(recovery.execute(null,'7391',send)).rejects.toThrow('正在核对')
    expect(send).toHaveBeenCalledTimes(1);finish(result(create));await first
  })
  it.each(['throw','drop','readback'])('does not send without verified durable storage: %s',async mode=>{
    const saved=storage();saved.setItem=()=>{if(mode==='throw')throw Error('unavailable')};if(mode==='readback')saved.getItem=()=>{throw Error('unavailable')}
    const recovery=new StaffEmployeeRecovery('tenant:store','admin',saved),send=vi.fn()
    await expect(recovery.execute(create,'4826',send)).rejects.toThrow();expect(send).not.toHaveBeenCalled()
  })
  it.each(['json','owner','pin'])('preserves malformed records and fails closed: %s',async kind=>{
    const saved=storage(),recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(create,'4826',async()=>{throw network()})).rejects.toThrow()
    const [key,value]=[...saved.values][0]!,item=JSON.parse(value)
    if(kind==='owner')item.actorEmployeeId='other'
    if(kind==='pin')item.operation.body.pin='4826'
    const corrupt=kind==='json'?'{broken':JSON.stringify(item);saved.setItem(key,corrupt)
    const send=vi.fn();await expect(recovery.execute(null,'4826',send)).rejects.toThrow('无法读取')
    expect(send).not.toHaveBeenCalled();expect(saved.getItem(key)).toBe(corrupt)
  })
  it('retains intent when the server response lacks a verified receipt',async()=>{
    const saved=storage(),recovery=new StaffEmployeeRecovery('tenant:store','admin',saved)
    await expect(recovery.execute(status,undefined,async()=>({...result(status),employeeId:roleId}))).rejects.toThrow('回执')
    expect(recovery.pending()).not.toBeNull()
  })
})
