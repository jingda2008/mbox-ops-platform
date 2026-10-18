import {describe,it,expect,vi} from 'vitest'
import {TableServiceApi,TableServiceApiError} from './table-service-api'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
describe('table service API identity and recovery',()=>{
 it('binds reads to the exact authenticated staff session',async()=>{
  const send=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({data:[]}),{status:200}));const api=new TableServiceApi('staff-session',send)
  await api.tables();const init=send.mock.calls[0]![1] as RequestInit
  expect(new Headers(init.headers).get(STAFF_SESSION_BINDING_HEADER)).toBe('staff-session');expect(init.credentials).toBe('include')
 })
 it('retries an unknown handover with the original key and exact body',async()=>{
  const keys:string[]=[],bodies:string[]=[];let first=true
  const send=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{keys.push(new Headers(init?.headers).get('idempotency-key')!);bodies.push(String(init?.body));if(first){first=false;throw new Error('connection lost')}return new Response(JSON.stringify({data:{sessionId:'s',revision:1}}),{status:200})})
  const api=new TableServiceApi('unique-session',send),input={employeeId:'target',expectedRevision:0,reason:'晚班交接'}
  await expect(api.handover('s',input)).rejects.toThrow('connection lost');await api.handover('s',input)
  expect(keys[1]).toBe(keys[0]);expect(bodies[1]).toBe(bodies[0])
 })
 it('distinguishes a definite rollback from an unknown outcome',async()=>{
  const api=new TableServiceApi('session',async()=>new Response(JSON.stringify({error:{message:'状态已变化',commitDisposition:'not_committed'}}),{status:409}))
  const error=await api.handover('s',{employeeId:'other',expectedRevision:0,reason:'换班'}).catch(e=>e)
  expect(error).toBeInstanceOf(TableServiceApiError);expect(error.notCommitted).toBe(true)
 })
})
