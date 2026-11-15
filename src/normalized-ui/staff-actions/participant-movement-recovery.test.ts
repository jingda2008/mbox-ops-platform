import {beforeEach,describe,expect,it,vi} from 'vitest'
import {StaffActionsApi} from './staff-actions-api'
import {ParticipantMovementRecovery,type ParticipantMovementInput} from './participant-movement-recovery'
const input:ParticipantMovementInput={sourceTableSessionId:'source',movementKind:'participant_split',targetTableId:'target-table',targetTableSessionId:null,movedGuestCount:1,participantPublicIds:['person'],reason:'现场确认',movementGuard:{movementRevision:'0',sourceTableId:'source-table',sourceLocationVersion:1,sourceGuestCount:2,targetGuestCount:0,targetCapacity:8}}
const receipt={data:{eventId:'event',targetTableSessionId:'target-session',movedParticipantCount:1,revokedGuestSessionCount:0,occurredAt:'2026-11-15T10:00:00+08:00',targetCapacityAtMovement:8,targetGuestCountBefore:0,targetGuestCountAfter:1},meta:{replayed:false}}
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status})
describe('web participant movement recovery protocol',()=>{
 const stored=new Map<string,string>(),storage={getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>{stored.set(k,v)},removeItem:(k:string)=>{stored.delete(k)}}
 let send:ReturnType<typeof vi.fn<typeof fetch>>,sequence:number
 const api=(owner='staff-a')=>new StaffActionsApi({fetch:send,staffSessionId:owner,commandStorage:storage,createIdempotencyKey:()=>`move-${++sequence}`})
 const writes=()=>send.mock.calls.filter(([,init])=>init?.method==='POST')
 beforeEach(()=>{stored.clear();sequence=0;send=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>response(init?.method==='POST'?receipt:{data:[]}))})
 it('recovers after response loss and reopening with exactly the original key and body',async()=>{
  send.mockRejectedValueOnce(new TypeError('lost response after commit'))
  const first=api();await expect(first.moveParticipants(input)).rejects.toMatchObject({code:'NETWORK_ERROR'})
  const original=writes()[0]!,saved=[...stored.values()][0]
  const reopened=api();await expect(reopened.moveParticipants({...input,targetTableId:'different'})).rejects.toThrow('不能更改')
  expect(writes()).toHaveLength(1);expect([...stored.values()][0]).toBe(saved)
  await reopened.recoverParticipantMovement()
  expect(writes()).toHaveLength(2)
  expect(writes()[1]![1]?.body).toBe(original[1]?.body)
  const firstHeaders=new Headers(original[1]?.headers),recoveredHeaders=new Headers(writes()[1]![1]?.headers)
  expect(recoveredHeaders.get('x-idempotency-key')).toBe(firstHeaders.get('x-idempotency-key'))
  expect(firstHeaders.has('x-table-movement-recovery')).toBe(false);expect(recoveredHeaders.get('x-table-movement-recovery')).toBe('1')
  expect(reopened.pendingParticipantMovement()).toBeNull();expect(stored.size).toBe(0)
 })
 it('keeps confirmed receipt through a failed refresh and then only reads after reopening',async()=>{
  send.mockResolvedValueOnce(response(receipt)).mockRejectedValueOnce(new TypeError('read offline'))
  await expect(api().moveParticipants(input)).rejects.toMatchObject({code:'NETWORK_ERROR'})
  expect(writes()).toHaveLength(1);const reopened=api()
  expect(reopened.pendingParticipantMovement()?.message).toContain('已确认')
  await reopened.recoverParticipantMovement();expect(writes()).toHaveLength(1);expect(stored.size).toBe(0)
 })
 it.each([null,{},[{}]])('does not clear a confirmed receipt after malformed participant refresh: %j',async data=>{
  send.mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({data}))
  await expect(api().moveParticipants(input)).rejects.toMatchObject({code:'INVALID_PARTICIPANT_LIST'})
  expect(stored.size).toBe(1);await api().recoverParticipantMovement();expect(writes()).toHaveLength(1);expect(stored.size).toBe(0)
 })
 it.each(['missing','wrong-target','wrong-count','invalid-time'])('retains the original request for an invalid receipt: %s',async fault=>{
  const merge={...input,movementKind:'participant_merge' as const,targetTableSessionId:'target-session'}
  const bad=structuredClone(receipt)
  if(fault==='missing')delete (bad.data as any).eventId
  if(fault==='wrong-target')bad.data.targetTableSessionId='other'
  if(fault==='wrong-count')bad.data.targetGuestCountAfter=20
  if(fault==='invalid-time')bad.data.occurredAt='2026-11-15 10:00:00'
  send.mockResolvedValueOnce(response(bad))
  await expect(api().moveParticipants(merge)).rejects.toThrow('回执')
  expect(stored.size).toBe(1);await api().recoverParticipantMovement();expect(writes()).toHaveLength(2)
  expect(new Headers(writes()[1]![1]?.headers).get('x-table-movement-recovery')).toBe('1')
 })
 it('isolates accounts and requires explicit recovery even after returning to the original account',async()=>{
  send.mockRejectedValueOnce(new TypeError('offline'));await expect(api().moveParticipants(input)).rejects.toThrow()
  const other=api('staff-b');expect(other.pendingParticipantMovement()?.canRecover).toBe(false)
  await expect(other.recoverParticipantMovement()).rejects.toThrow('原员工');expect(writes()).toHaveLength(1)
  await api().recoverParticipantMovement();expect(writes()).toHaveLength(2)
 })
 it('keeps an absent receipt unknown even if an old server marks it not committed',async()=>{
  send.mockRejectedValueOnce(new TypeError('offline before server'))
  await expect(api().moveParticipants(input)).rejects.toThrow()
  send.mockResolvedValueOnce(response({error:{code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE',message:'原请求未执行',commitDisposition:'not_committed'}},409))
  await expect(api().recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'})
  expect(writes()).toHaveLength(2);expect(stored.size).toBe(1)
  await expect(api().moveParticipants({...input,reason:'changed'})).rejects.toThrow('不能更改')
  await api().recoverParticipantMovement();expect(stored.size).toBe(0)
 })
 it('seals only the original request and retains it if the seal response is lost',async()=>{
  send.mockRejectedValueOnce(new TypeError('offline'));await expect(api().moveParticipants(input)).rejects.toThrow()
  await expect(api('staff-b').sealParticipantMovement()).rejects.toThrow('原员工')
  send.mockRejectedValueOnce(new TypeError('seal response lost'));await expect(api().sealParticipantMovement()).rejects.toThrow()
  expect(stored.size).toBe(1)
  send.mockResolvedValueOnce(response({error:{code:'TABLE_MOVEMENT_REQUEST_SEALED',message:'已封存',commitDisposition:'not_committed'}},409))
  await expect(api().sealParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'})
  for(const call of writes().slice(1)){
   expect(call[1]?.body).toBe(writes()[0][1]?.body)
   expect(new Headers(call[1]?.headers).get('x-idempotency-key')).toBe(new Headers(writes()[0][1]?.headers).get('x-idempotency-key'))
   expect(new Headers(call[1]?.headers).get('x-table-movement-seal')).toBe('1')
  }
  expect(stored.size).toBe(0);await expect(api().sealParticipantMovement()).rejects.toThrow('没有待恢复')
 })
 it('remembers an uncertain withdrawal across reopening and never treats a missing lookup as cancellation',async()=>{
  send.mockRejectedValueOnce(new TypeError('initial unknown'));await expect(api().moveParticipants(input)).rejects.toThrow()
  send.mockRejectedValueOnce(new TypeError('withdrawal never reached server'));await expect(api().sealParticipantMovement()).rejects.toThrow()
  expect(api().pendingParticipantMovement()?.message).toContain('不代表撤回成功')
  send.mockResolvedValueOnce(response({error:{code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE',message:'暂未找到'}},409))
  await expect(api().recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'})
  expect(api().pendingParticipantMovement()?.message).toContain('撤回结果待核对')
  expect(new Headers(writes().at(-1)![1]?.headers).has('x-table-movement-seal')).toBe(false)
  await expect(api('other').sealParticipantMovement()).rejects.toThrow('原员工')
  await api().recoverParticipantMovement();expect(api().pendingParticipantMovement()).toBeNull()
 })
 it('does not dispatch withdrawal when its pending marker cannot be saved',async()=>{
  send.mockRejectedValueOnce(new TypeError('initial unknown'));await expect(api().moveParticipants(input)).rejects.toThrow()
  const broken=new StaffActionsApi({fetch:send,staffSessionId:'staff-a',commandStorage:{...storage,setItem:()=>{throw new Error('disk full')}}})
  await expect(broken.sealParticipantMovement()).rejects.toThrow('disk full');expect(writes()).toHaveLength(1)
  expect(api().pendingParticipantMovement()).not.toBeNull()
 })
 it('returns the real receipt when the original committed before the seal',async()=>{
  send.mockRejectedValueOnce(new TypeError('lost'));await expect(api().moveParticipants(input)).rejects.toThrow()
  await api().sealParticipantMovement();expect(stored.size).toBe(0)
  expect(send.mock.calls.filter(([,init])=>init?.method!=='POST')).toHaveLength(2)
 })
 it.each(['sealed','success'])('does not erase a newer journal when an old response arrives: %s',async outcome=>{
  let finish!:(r:Response)=>void
  send.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const original=api().moveParticipants(input).then(()=>null,e=>e)
  send.mockResolvedValueOnce(response({error:{code:'TABLE_MOVEMENT_REQUEST_SEALED',message:'已封存',commitDisposition:'not_committed'}},409))
  await expect(api().sealParticipantMovement()).rejects.toThrow()
  send.mockRejectedValueOnce(new TypeError('new request unknown'))
  await expect(api().moveParticipants(input)).rejects.toThrow();const saved=[...stored.values()][0]
  finish(outcome==='success'?response(receipt):response({error:{code:'TABLE_MOVEMENT_REQUEST_SEALED',message:'已封存',commitDisposition:'not_committed'}},409))
  await original;expect([...stored.values()][0]).toBe(saved)
 })
 it('retains unknown execution on permission loss and on unreadable persistent storage',async()=>{
  send.mockRejectedValueOnce(new TypeError('offline'));await expect(api().moveParticipants(input)).rejects.toThrow()
  send.mockResolvedValueOnce(response({error:{code:'TABLE_PERMISSION_DENIED',message:'拒绝'}},403))
  await expect(api().recoverParticipantMovement()).rejects.toMatchObject({status:403});expect(stored.size).toBe(1)
  stored.set('mbox.participant-movement-recovery.v1','broken')
  expect(api().pendingParticipantMovement()?.canRecover).toBe(false)
  await expect(api().moveParticipants(input)).rejects.toThrow('损坏');expect(writes()).toHaveLength(2)
 })
 it('does not send without durable storage or when no recovery exists',async()=>{
  const broken=new StaffActionsApi({fetch:send,staffSessionId:'staff-a',commandStorage:{...storage,setItem:()=>{throw new Error('disk full')}}})
  await expect(broken.moveParticipants(input)).rejects.toThrow('disk full')
  await expect(api().recoverParticipantMovement()).rejects.toThrow('没有待恢复');expect(send).not.toHaveBeenCalled()
 })
 it('single-flights submission and reuses the running recovery promise on rapid clicks',async()=>{
  let done!:(value:Response)=>void;send.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve}))
  const client=api(),running=client.moveParticipants(input)
  await expect(client.moveParticipants(input)).rejects.toThrow('勿重复');const recovering=client.recoverParticipantMovement()
  expect(writes()).toHaveLength(1);done(response(receipt));await Promise.all([running,recovering]);expect(writes()).toHaveLength(1)
 })
 it.each(['recover','seal'] as const)('does not lend an in-flight original promise to another account: %s',async action=>{
  let owner='staff-a',finish!:(value:unknown)=>void
  const transport=vi.fn(()=>new Promise(resolve=>{finish=resolve})),refresh=vi.fn(async()=>{})
  const recovery=new ParticipantMovementRecovery(()=>owner,storage,transport,refresh,()=>String(++sequence))
  const running=recovery.run(input);owner='staff-b'
  await expect(recovery[action]()).rejects.toThrow('原员工');expect(transport).toHaveBeenCalledOnce()
  owner='staff-a';finish(receipt);await running;expect(stored.size).toBe(0)
 })
 it('binds the known employee without relying on a session-id option and keeps denied withdrawal recoverable',async()=>{
  const client=new StaffActionsApi({fetch:send,commandStorage:storage})
  send.mockResolvedValueOnce(response({data:{actor:{id:'staff-a'}}}));await client.loadOperations()
  send.mockRejectedValueOnce(new TypeError('old request offline'));await expect(client.moveParticipants(input)).rejects.toThrow()
  send.mockResolvedValueOnce(response({error:{code:'AUTH_REQUIRED',message:'当前员工已切换'}},401))
  await expect(client.sealParticipantMovement()).rejects.toMatchObject({code:'AUTH_REQUIRED'})
  expect(client.pendingParticipantMovement()?.message).toContain('不代表撤回成功')
  for(const call of writes())expect(new Headers(call[1]?.headers).get('x-mbox-staff-employee-id')).toBe('staff-a')
  send.mockResolvedValueOnce(response({error:{code:'TABLE_MOVEMENT_REQUEST_SEALED',message:'封存',commitDisposition:'not_committed'}},409))
  await expect(client.recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'})
  expect(stored.size).toBe(0)
 })
 it('reads server history without a local journal or a write, using a cursor without selecting an actor',async()=>{
  const row={id:'event',kind:'participant_merge',sourceTableCode:'A1',targetTableCode:'B1',movedGuestCount:2,employeeName:'员工',occurredAt:'2026-11-15T12:00:00+08:00',targetCurrentTableCode:'B1',targetSessionStatus:'closed'}
  send.mockResolvedValueOnce(response({data:{items:[row],nextCursor:'next'}}))
  const result=await api('new-login-device').loadParticipantMovementHistory('original-page')
  expect(result.items).toEqual([row]);expect(send.mock.calls[0][0]).toBe('/api/table-management/participant-movements/history?cursor=original-page')
  expect(writes()).toHaveLength(0);expect(stored.size).toBe(0)
 })
 it.each([{items:null,nextCursor:null},{items:[{}],nextCursor:null},{items:[],nextCursor:12}])('does not mistake malformed server history for an empty verified result: %j',async data=>{
  send.mockResolvedValueOnce(response({data}));await expect(api().loadParticipantMovementHistory()).rejects.toMatchObject({code:'INVALID_MOVEMENT_HISTORY'})
  expect(writes()).toHaveLength(0)
 })
})
