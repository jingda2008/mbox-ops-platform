import {useState,useRef,useMemo} from 'react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {ChannelActivationPanel} from './ChannelActivationPanel'
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useRef:vi.fn(),useMemo:vi.fn(),useEffect:vi.fn()}))
function nodes(node:any):any[]{if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]}
describe('staff read-only channel binding refresh',()=>{
 let states:any[],refs:any[],si:number,ri:number
 const fetcher=vi.fn(),storage=new Map<string,string>()
 const receiptKey='mbox.staff-command.v1:channel:staff-a:source'
 const receipt=JSON.stringify({key:'original-request',body:{claimId:'original',tableSessionId:'source'}})
 function render(sessionId='source'){si=0;ri=0;return ChannelActivationPanel({sessionId,staffSessionId:'staff-a'})}
 function button(tree:any){const found=nodes(tree).find(node=>node.type==='button'&&node.props.children==='刷新本桌绑定记录');expect(found).toBeTruthy();return found}
 beforeEach(()=>{
  vi.clearAllMocks();states=[];refs=[];storage.clear();storage.set(receiptKey,receipt)
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)})
  vi.mocked(useState).mockImplementation(initial=>{const index=si++;if(!(index in states))states[index]=initial;return[states[index],(value:unknown)=>{states[index]=value}] as never})
  vi.mocked(useRef).mockImplementation(initial=>{const index=ri++;return(refs[index]??(refs[index]={current:initial})) as never})
  vi.mocked(useMemo).mockImplementation(factory=>factory())
 })
 afterEach(()=>vi.unstubAllGlobals())
 it('refreshes another employee’s changes once under repeated clicks without clearing the original request',async()=>{
  render();states[9]=true
  let finish!:(value:unknown)=>void;fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const refresh=button(render());expect(refresh.props.disabled).toBe(false)
  refresh.props.onClick();refresh.props.onClick();expect(fetcher).toHaveBeenCalledOnce()
  const rows=[{id:'binding',claimId:'original',title:'餐后券',sourceLabel:'餐厅',status:'fulfilled',usedDiscountMinor:'1500'}]
  finish({ok:true,json:async()=>({data:{customers:[],activations:rows}})})
  await vi.waitFor(()=>expect(states[2]).toBe(false))
  expect(states[8]).toEqual(rows);expect(states[9]).toBe(true);expect(storage.get(receiptKey)).toBe(receipt)
  expect(fetcher.mock.calls[0][0]).toBe('/api/staff/channel/table/source');expect(fetcher.mock.calls[0][1].method).toBeUndefined()
 })
 it('ignores a delayed original-table read after switching to the split destination',async()=>{
  let finish!:(value:unknown)=>void;fetcher.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  button(render()).props.onClick();render('split');states[8]=[{id:'target'}]
  finish({ok:true,json:async()=>({data:{customers:[],activations:[{id:'old'}]}})})
  await new Promise(resolve=>setImmediate(resolve))
  expect(states[8]).toEqual([{id:'target'}]);expect(states[5]).toBe('');expect(storage.get(receiptKey)).toBe(receipt)
 })
 it('does not retain stale amounts or clear recovery when a refresh is malformed',async()=>{
  render();states[8]=[{id:'old',usedDiscountMinor:'1000'}]
  fetcher.mockResolvedValue({ok:true,json:async()=>({data:{customers:[]}})})
  button(render()).props.onClick();await vi.waitFor(()=>expect(states[2]).toBe(false))
  expect(states[8]).toEqual([]);expect(states[5]).toContain('绑定记录');expect(storage.get(receiptKey)).toBe(receipt)
 })
})
