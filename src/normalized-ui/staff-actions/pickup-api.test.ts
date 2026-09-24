import {beforeEach,describe,expect,it,vi} from 'vitest'
import type {PickupCommand,PickupCommandResult} from '../../shared/pickup-workflow'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {isPickupBoard,PickupApi,PickupApiError,type PickupStorage} from './pickup-api'
import {pickupDraft,pickupTakeCommand} from './pickup-board-state'
import {pickupFixtureBoard as board,pickupFixtureId as id,pickupFixtureReceipt as receipt,pickupFixtureUnit as unit} from './pickup-test-fixtures'

class MemoryStorage implements PickupStorage{
  values=new Map<string,string>();get length(){return this.values.size}
  key(index:number){return [...this.values.keys()][index]??null}
  getItem(key:string){return this.values.get(key)??null}
  setItem(key:string,value:string){this.values.set(key,value)}
  removeItem(key:string){this.values.delete(key)}
}
const okay=(data:unknown)=>new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}})
const failed=(status:number,code:string,commitDisposition?:'unknown'|'not_committed',message='操作需要核对')=>new Response(JSON.stringify({error:{code,message,...(commitDisposition?{commitDisposition}:{})}}),{status})
const body=()=>pickupTakeCommand(pickupDraft(board().tables[0]!))!
const done=(patch:Partial<PickupCommandResult>={}):PickupCommandResult=>({receipt:receipt(),revision:2,replayed:false,...patch})
const fresh=()=>board([],{revision:3,history:[receipt()]})
const invoke=<T,>(call:()=>T)=>Promise.resolve().then(call)

describe('pickup API durable original-command recovery',()=>{
  let storage:MemoryStorage
  beforeEach(()=>{storage=new MemoryStorage()})
  function make(responses:Array<Response|Error|(()=>Promise<Response>)>,session='session-A'){
    const sent:Array<{url:string;init:RequestInit}>=[]
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{sent.push({url:String(url),init:init??{}});const next=responses.shift();if(next instanceof Error)throw next;if(typeof next==='function')return next();if(!next)throw new Error('Unexpected network request');return next}) as unknown as typeof fetch
    return {api:new PickupApi({staffSessionId:session,storage,fetch:fetcher,createIdempotencyKey:()=>id(900)}),sent,responses}
  }
  it('renews an idle pickup lease once without sending any business command',async()=>{
    const {api,sent}=make([failed(403,'PICKUP_SESSION_INVALID'),okay({}),okay(board())])
    expect((await api.loadBoard()).actor.canPickup).toBe(true)
    expect(sent.map(x=>x.url)).toEqual(['/api/commerce/pickup-board','/api/auth/heartbeat','/api/commerce/pickup-board'])
    expect(new Headers(sent[1]!.init.headers).get('content-type')).toBe('application/json')
    expect(storage.length).toBe(0)
  })
  it('preserves expired login failure and does not loop renewal',async()=>{
    const {api,sent}=make([failed(403,'PICKUP_SESSION_INVALID'),failed(401,'AUTH_REQUIRED')])
    await expect(api.loadBoard()).rejects.toMatchObject({code:'AUTH_REQUIRED'});expect(sent).toHaveLength(2)
    const denied=make([failed(403,'PICKUP_SESSION_INVALID'),okay({}),failed(403,'PICKUP_SESSION_INVALID')])
    await expect(denied.api.loadBoard()).rejects.toMatchObject({code:'PICKUP_SESSION_INVALID'});expect(denied.sent).toHaveLength(3)
  })
  it('does not renew permission denial as if it were an expired session',async()=>{
    const {api,sent}=make([failed(403,'PICKUP_FORBIDDEN')])
    await expect(api.loadBoard()).rejects.toMatchObject({code:'PICKUP_FORBIDDEN'});expect(sent).toHaveLength(1)
  })
  it('binds reads and commands to the original session with credentials',async()=>{
    const {api,sent}=make([okay(board()),okay(done())]);await api.loadBoard();await api.run(body())
    expect(sent).toHaveLength(2)
    for(const request of sent){expect(request.init.credentials).toBe('include');expect(new Headers(request.init.headers).get(STAFF_SESSION_BINDING_HEADER)).toBe('session-A')}
    expect(JSON.parse(String(sent[1]!.init.body))).toEqual(body());expect(new Headers(sent[1]!.init.headers).get('Idempotency-Key')).toBe(id(900))
  })
  it('persists the entire frozen request and reads it back before POST',async()=>{
    const {api}=make([okay(board()),()=>{const stored=JSON.parse([...storage.values.values()][0]!);expect(stored.request.command).toEqual(body());expect(stored.staffSessionId).toBe('session-A');expect(stored.commandScope).toBe('scope-A');return Promise.resolve(okay(done()))}])
    await api.loadBoard();await api.run(body());expect(api.recovery().attempt?.result?.kind).toBe('command')
  })
  it('does not send before the current authorization scope is read',async()=>{
    const {api,sent}=make([]);await expect(invoke(()=>api.run(body()))).rejects.toMatchObject({code:'PICKUP_NOT_LOADED'});expect(sent).toHaveLength(0)
  })
  it('blocks absent device storage without submitting a command',async()=>{
    const fetcher=vi.fn(async()=>okay(board()))
    const api=new PickupApi({staffSessionId:'session-A',storage:null,fetch:fetcher});await api.loadBoard()
    await expect(invoke(()=>api.run(body()))).rejects.toMatchObject({code:'PICKUP_RECOVERY_STORAGE'});expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('blocks a silent write failure before any POST',async()=>{
    storage.setItem=()=>{};const {api,sent}=make([okay(board())]);await api.loadBoard()
    await expect(invoke(()=>api.run(body()))).rejects.toMatchObject({code:'PICKUP_RECOVERY_STORAGE'});expect(sent).toHaveLength(1)
  })
  it('does not discard malformed saved work',async()=>{
    storage.setItem('mbox.pickup-command.v1:broken','{"request":')
    const {api,sent}=make([okay(board())]);await api.loadBoard();expect(api.recovery().error).toBeTruthy()
    await expect(invoke(()=>api.run(body()))).rejects.toMatchObject({code:'PICKUP_RECOVERY_STORAGE'});expect(sent).toHaveLength(1);expect(storage.length).toBe(1)
  })
  it('recovers a lost response after page reconstruction with exactly the same key and body',async()=>{
    const original=make([okay(board()),new Error('lost response')]);await original.api.loadBoard();await expect(original.api.run(body())).rejects.toMatchObject({code:'PICKUP_NETWORK'})
    const recovered=make([okay(fresh()),okay(done({replayed:true}))]);await recovered.api.loadBoard();await recovered.api.recover()
    expect(recovered.sent[1]!.init.body).toBe(original.sent[1]!.init.body)
    expect(new Headers(recovered.sent[1]!.init.headers).get('idempotency-key')).toBe(new Headers(original.sent[1]!.init.headers).get('idempotency-key'))
    expect(storage.length).toBe(1);recovered.api.acknowledgeRead(fresh());expect(storage.length).toBe(0)
  })
  it('never converts new arrivals into the prior uncertain pickup',async()=>{
    const {api,sent}=make([okay(board()),new Error('lost'),okay(board([unit(),unit(2)])),okay(done({replayed:true}))])
    await api.loadBoard();await expect(api.run(body())).rejects.toBeInstanceOf(PickupApiError);await api.loadBoard()
    const changed=pickupTakeCommand(pickupDraft(board([unit(),unit(2)]).tables[0]!))!
    await expect(invoke(()=>api.run(changed))).rejects.toMatchObject({code:'PICKUP_ORIGINAL_PENDING'})
    await api.recover();expect(JSON.parse(String(sent[3]!.init.body)).units).toEqual(body().units)
  })
  it.each([[403,'PICKUP_SESSION_INVALID','unknown'],[403,'PICKUP_FORBIDDEN',undefined],[503,'PICKUP_TEMPORARILY_UNAVAILABLE','unknown'],[409,'IDEMPOTENCY_IN_PROGRESS','not_committed'],[409,'IDEMPOTENCY_CONFLICT','not_committed']] as const)('retains original request on %s %s',async(status,code,disposition)=>{
    const {api}=make([okay(board()),failed(status,code,disposition)]);await api.loadBoard();await expect(api.run(body())).rejects.toMatchObject({code});expect(api.recovery().attempt?.request.command).toEqual(body());expect(storage.length).toBe(1)
  })
  it.each([[400,'PICKUP_INVALID'],[409,'PICKUP_STALE'],[409,'PICKUP_TABLE_MOVED'],[404,'PICKUP_RECEIPT_NOT_FOUND']] as const)('clears only confirmed not-committed %s %s',async(status,code)=>{
    const {api}=make([okay(board()),failed(status,code,'not_committed')]);await api.loadBoard();await expect(api.run(body())).rejects.toMatchObject({code});expect(storage.length).toBe(0)
  })
  it('does not expose an unknown pending command to another employee session',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'}))],'session-B');await other.api.loadBoard()
    expect(other.api.recovery()).toMatchObject({attempt:null,otherSession:true});await expect(invoke(()=>other.api.recover())).rejects.toThrow();await expect(invoke(()=>other.api.run(body()))).rejects.toThrow()
    expect(other.sent).toHaveLength(1);expect(storage.length).toBe(1)
  })
  it('blocks a changed tenant/device authorization scope even with the same session string',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'different-store'}))]);await other.api.loadBoard();expect(other.api.recovery().otherSession).toBe(true);await expect(invoke(()=>other.api.recover())).rejects.toThrow();expect(storage.length).toBe(1)
  })
  it('exposes a frozen human-readable preview, not new arrivals, for explicit recovery after login',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([unit(2)],{commandScope:'scope-B'}))],'session-B');await other.api.loadBoard()
    const previous=other.api.recovery().previousAttempt
    expect(previous?.preview?.title).toBe('A01 · 确认取走 1份');expect(previous?.request.command).toEqual(body())
    expect(previous?.preview?.lines).toEqual(['酒水吧台 · 莫吉托 × 1']);expect(other.sent).toHaveLength(1)
  })
  it('explicit same-device recovery authenticates current login but preserves original scope/key/body',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const current=board([],{revision:3,commandScope:'scope-B',history:[receipt()]})
    const other=make([okay(current),okay({kind:'command',data:done({replayed:true})})],'session-B');await other.api.loadBoard();await other.api.recoverPrevious()
    const recoveryRequest=other.sent[1]!
    expect(recoveryRequest.url).toBe('/api/commerce/pickup-board/recovery');expect(new Headers(recoveryRequest.init.headers).get(STAFF_SESSION_BINDING_HEADER)).toBe('session-B')
    expect(JSON.parse(String(recoveryRequest.init.body))).toEqual({staffSessionId:'session-A',commandScope:'scope-A',idempotencyKey:id(900),request:{kind:'command',command:body()}})
    expect(other.api.recovery().attempt).toMatchObject({staffSessionId:'session-A',commandScope:'scope-A',key:id(900),recoveredBy:{staffSessionId:'session-B',commandScope:'scope-B'}})
    other.api.acknowledgeRead(current);expect(storage.length).toBe(0)
  })
  it('retains original command when another device or current role is forbidden to recover it',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'})),failed(403,'PICKUP_FORBIDDEN','unknown')],'session-B');await other.api.loadBoard();await expect(other.api.recoverPrevious()).rejects.toMatchObject({code:'PICKUP_FORBIDDEN'})
    expect(other.api.recovery().previousAttempt?.request.command).toEqual(body());expect(other.api.recovery().attempt).toBeNull();expect(storage.length).toBe(1)
  })
  it('releases a previous-session attempt only after the server proves the original was not committed',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'})),failed(409,'PICKUP_STALE','not_committed')],'session-B');await other.api.loadBoard();await expect(other.api.recoverPrevious()).rejects.toMatchObject({code:'PICKUP_STALE'})
    expect(storage.length).toBe(0)
  })
  it('never clears the old attempt when explicit recovery reports an idempotency body conflict',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'})),failed(409,'IDEMPOTENCY_CONFLICT','not_committed')],'session-B');await other.api.loadBoard();await expect(other.api.recoverPrevious()).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
    expect(storage.length).toBe(1)
  })
  it('retries an uncertain same-device recovery with the same original identity and body',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'})),new Error('lost recovery response'),okay({kind:'command',data:done({replayed:true})})],'session-B');await other.api.loadBoard();await expect(other.api.recoverPrevious()).rejects.toThrow();await other.api.recoverPrevious()
    expect(other.sent[2]!.init.body).toBe(other.sent[1]!.init.body);expect(other.api.recovery().attempt?.key).toBe(id(900))
  })
  it('readback failure after authorized previous recovery reuses saved response without a new POST',async()=>{
    const first=make([okay(board()),new Error('lost')]);await first.api.loadBoard();await expect(first.api.run(body())).rejects.toThrow()
    const other=make([okay(board([],{commandScope:'scope-B'})),okay({kind:'command',data:done({replayed:true})})],'session-B');await other.api.loadBoard();await other.api.recoverPrevious()
    expect(()=>other.api.acknowledgeRead(board([],{commandScope:'scope-B'}))).toThrow();await other.api.recover();expect(other.sent).toHaveLength(2);expect(storage.length).toBe(1)
  })
  it('permits a current-session readback after explicit prior-session configuration recovery',async()=>{
    const first=make([okay(board([],{device:null,setup:{enabled:true,configured:false,canConfigure:true}})),new Error('lost')]);await first.api.loadBoard();await expect(first.api.configureDevice({enabled:true,label:'取餐屏'})).rejects.toThrow()
    const current=board([],{revision:3,commandScope:'scope-B'})
    const other=make([okay(current),okay({kind:'device',data:board([],{revision:2})})],'session-B');await other.api.loadBoard();await other.api.recoverPrevious();other.api.acknowledgeRead(current);expect(storage.length).toBe(0)
  })
  it('requires a post-command authoritative board read before clearing a success',async()=>{
    const {api,sent}=make([okay(board()),okay(done())]);await api.loadBoard();await api.run(body())
    expect(()=>api.acknowledgeRead(board())).toThrow();expect(storage.length).toBe(1)
    await api.recover();expect(sent).toHaveLength(2)
    expect(()=>api.acknowledgeRead(fresh())).not.toThrow();expect(storage.length).toBe(0)
  })
  it('allows later authoritative state, including another valid undo, to complete result recovery',async()=>{
    const {api}=make([okay(board()),okay(done())]);await api.loadBoard();await api.run(body())
    api.acknowledgeRead(board([unit()],{revision:4,history:[receipt([unit()],{canUndo:false,revision:2,undo:{undoId:id(301),undoneAt:'2026-09-21T10:02:00Z'}})]}))
    expect(storage.length).toBe(0)
  })
  it('does not clear successful old work using an unrelated scope snapshot',async()=>{
    const {api}=make([okay(board()),okay(done())]);await api.loadBoard();await api.run(body());expect(()=>api.acknowledgeRead(freshBoardWithScope())).toThrow();expect(storage.length).toBe(1)
  })
  it('retains request when the success receipt contains extra or different physical units',async()=>{
    const {api}=make([okay(board()),okay(done({receipt:receipt([unit(),unit(2)])}))]);await api.loadBoard();await expect(api.run(body())).rejects.toMatchObject({code:'PICKUP_INVALID_RESPONSE'});expect(api.recovery().attempt?.result).toBeUndefined();expect(storage.length).toBe(1)
  })
  it('retains request when response contradicts anonymous pickup-as-delivery semantics',async()=>{
    const {api}=make([okay(board()),okay(done({receipt:{...receipt(),deliverySource:'manual'} as never}))]);await api.loadBoard();await expect(api.run(body())).rejects.toMatchObject({code:'PICKUP_INVALID_RESPONSE'});expect(storage.length).toBe(1)
  })
  it('retains original request if persisting the receipt fails after server commit',async()=>{
    const {api}=make([okay(board()),()=>{const original=storage.setItem.bind(storage);storage.setItem=(key,value)=>{if(JSON.parse(value).result)throw new Error('full');original(key,value)};return Promise.resolve(okay(done()))}]);await api.loadBoard()
    await expect(api.run(body())).rejects.toMatchObject({code:'PICKUP_RECOVERY_STORAGE'});expect(api.recovery().attempt?.result).toBeUndefined();expect(storage.length).toBe(1)
  })
  it('single-flights rapid calls and does not create a second receipt key',async()=>{
    let resolve!:(response:Response)=>void;const deferred=new Promise<Response>(done=>{resolve=done})
    const {api,sent}=make([okay(board()),()=>deferred]);await api.loadBoard()
    const first=api.run(body()),second=api.run(body());expect(first).toBe(second);expect(storage.length).toBe(1);resolve(okay(done()));await Promise.all([first,second]);expect(sent).toHaveLength(2)
  })
  it('restores the exact one-time device configuration after a lost response',async()=>{
    const notConfigured=board([],{device:null,setup:{enabled:true,configured:false,canConfigure:true}})
    const first=make([okay(notConfigured),new Error('lost config response')]);await first.api.loadBoard();await expect(first.api.configureDevice({enabled:true,label:'吧台一号'})).rejects.toThrow()
    const recovered=make([okay(board()),okay(board())]);await recovered.api.loadBoard()
    await expect(invoke(()=>recovered.api.configureDevice({enabled:false}))).rejects.toMatchObject({code:'PICKUP_ORIGINAL_PENDING'})
    await recovered.api.recover();expect(recovered.sent[1]!.url).toBe('/api/commerce/pickup-board/device');expect(recovered.sent[1]!.init.body).toBe(first.sent[1]!.init.body);recovered.api.acknowledgeRead(board());expect(storage.length).toBe(0)
  })
  it('undo recovery targets only the receipt and keeps the original physical-attestation body',async()=>{
    const undone=receipt([unit()],{revision:2,canUndo:false,undo:{undoId:id(301),undoneAt:'2026-09-21T10:02:00Z'}})
    const command:PickupCommand={action:'undo',receiptId:id(300),expectedRevision:1,physicalStillAtPickupPoint:true}
    const {api,sent}=make([okay(fresh()),new Error('lost undo'),okay(done({receipt:undone,replayed:true}))]);await api.loadBoard();await expect(api.run(command)).rejects.toThrow();await api.recover()
    expect(sent[2]!.init.body).toBe(sent[1]!.init.body);expect(api.recovery().attempt?.result).toMatchObject({data:{receipt:{undo:{undoId:id(301)}}}})
  })
  it('keeps saved success when storage removal silently fails',async()=>{
    const {api}=make([okay(board()),okay(done())]);await api.loadBoard();await api.run(body());storage.removeItem=()=>{}
    expect(()=>api.acknowledgeRead(fresh())).toThrow();expect(api.recovery().attempt?.result).toBeTruthy()
  })
  it('sanitizes backend system-language errors',async()=>{
    const {api}=make([okay(board()),failed(500,'PICKUP_TEMPORARILY_UNAVAILABLE','unknown','SELECT * FROM secret_tokens: SQLSTATE 23505')]);await api.loadBoard()
    await expect(api.run(body())).rejects.not.toThrow(/SELECT|SQLSTATE|secret_tokens/)
  })
  it('times out an abort-aware request without clearing its frozen command',async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      if(init?.method==='GET')return okay(board())
      return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))
    }) as unknown as typeof fetch
    const api=new PickupApi({staffSessionId:'session-A',storage,fetch:fetcher,timeoutMs:10,createIdempotencyKey:()=>id(901)});await api.loadBoard();await expect(api.run(body())).rejects.toMatchObject({code:'PICKUP_TIMEOUT'});expect(api.recovery().attempt?.request.command).toEqual(body())
  })
})
function freshBoardWithScope(){return board([],{revision:3,commandScope:'scope-other'})}

describe('pickup response validation',()=>{
  it('accepts the authoritative two-location ready queue and anonymous delivery receipt',()=>expect(isPickupBoard(board([unit(),unit(2,{station:'kitchen',pickupLocation:'后厨取餐口'})],{history:[receipt()]}))).toBe(true))
  it('rejects duplicates, inconsistent table location and unsafe ordering revisions',()=>{
    expect(isPickupBoard(board([unit(),unit()]))).toBe(false)
    const changed=board();changed.tables[0]!.units[0]!.locationVersion=2;expect(isPickupBoard(changed)).toBe(false)
    expect(isPickupBoard(board([],{revision:Number.MAX_SAFE_INTEGER+1}))).toBe(false)
  })
  it('never exposes a ready queue on an unconfigured device',()=>expect(isPickupBoard(board([unit()],{device:null}))).toBe(false))
  it('preserves authorized ready pickup and undo when admission is paused on an existing device',()=>{
    const paused=board([unit()],{recoveryAvailable:true,setup:{enabled:false,configured:true,canConfigure:false}})
    expect(isPickupBoard(paused)).toBe(true);expect(paused.actor.canPickup).toBe(true);expect(paused.actor.canUndo).toBe(true)
  })
  it('rejects snapshots that omit the existing-device recovery capability',()=>{
    const legacy=board() as unknown as Record<string,unknown>;delete legacy.recoveryAvailable;expect(isPickupBoard(legacy)).toBe(false)
  })
  it('rejects receipt quantity and business delivery time contradictions',()=>{
    expect(isPickupBoard(board([],{history:[receipt([unit()],{quantity:2})]}))).toBe(false)
    expect(isPickupBoard(board([],{history:[receipt([unit()],{deliveryConfirmedAt:'2026-09-21T10:03:00Z'})]}))).toBe(false)
  })
})
