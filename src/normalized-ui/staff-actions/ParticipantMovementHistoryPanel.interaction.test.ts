import {useState,useRef,useEffect} from 'react'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {ParticipantMovementHistoryPanel} from './ParticipantMovementHistoryPanel'
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useRef:vi.fn(),useEffect:vi.fn()}))
const nodes=(n:any):any[]=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)]
const label=(n:any):string=>typeof n==='string'?n:Array.isArray(n)?n.map(label).join(''):n?.props?label(n.props.children):''
const item={id:'event',kind:'participant_split',sourceTableCode:'A1',targetTableCode:'B1',movedGuestCount:1,employeeName:'原员工',occurredAt:'2026-11-15T12:00:00Z',targetCurrentTableCode:'C1',targetSessionStatus:'closed'}
describe('server movement history read-only panel',()=>{
 let states:any[],refs:any[],si:number,ri:number,props:any,effects:(()=>void|(()=>void))[]
 function render(){si=0;ri=0;effects=[];return ParticipantMovementHistoryPanel(props)}
 function button(tree:any,text:string){const b=nodes(tree).find(n=>n.type==='button'&&label(n).includes(text));expect(b).toBeTruthy();return b}
 beforeEach(()=>{
  vi.clearAllMocks();states=[];refs=[]
  vi.mocked(useState).mockImplementation(initial=>{const i=si++;if(!(i in states))states[i]=initial;return[states[i],(value:any)=>{states[i]=value}] as never})
  vi.mocked(useRef).mockImplementation(initial=>{const i=ri++;return(refs[i]??(refs[i]={current:initial})) as never})
  vi.mocked(useEffect).mockImplementation(effect=>{effects.push(effect)})
  props={api:{loadParticipantMovementHistory:vi.fn()},ownerKey:'employee-a',onVerified:vi.fn(),onInvalidated:vi.fn()}
 })
 it('single-flights server reads and displays a completed historical move even after its table closed',async()=>{
  let resolve!:(v:unknown)=>void;props.api.loadParticipantMovementHistory.mockImplementation(()=>new Promise(r=>{resolve=r}))
  const query=button(render(),'核对历史');query.props.onClick();query.props.onClick();expect(props.api.loadParticipantMovementHistory).toHaveBeenCalledOnce()
  resolve({items:[item],nextCursor:null});await vi.waitFor(()=>expect(states[1]).toBe(false))
  const text=label(render());expect(text).toContain('没有匹配记录不能判定原请求未执行');expect(text).toContain('A1 → B1');expect(text).toContain('已完成');expect(text).toContain('已结束');expect(props.onVerified).toHaveBeenCalledOnce()
  expect(nodes(render()).filter(n=>n.type==='button').map(label)).toEqual(['核对历史拆并桌（服务端）'])
 })
 it('does not present no history as proof that an unknown request did not execute',async()=>{
  props.api.loadParticipantMovementHistory.mockResolvedValue({items:[],nextCursor:null})
  button(render(),'核对历史').props.onClick();await vi.waitFor(()=>expect(states[1]).toBe(false))
  expect(label(render())).toContain('不代表原请求未到达或未执行');expect(label(render())).not.toContain('可以重新执行')
 })
 it('hides prior account data immediately and discards a late response after login changes',async()=>{
  props.api.loadParticipantMovementHistory.mockResolvedValueOnce({items:[item],nextCursor:null})
  button(render(),'核对历史').props.onClick();await vi.waitFor(()=>expect(states[1]).toBe(false))
  let resolve!:(v:unknown)=>void;props.api.loadParticipantMovementHistory.mockImplementation(()=>new Promise(r=>{resolve=r}))
  button(render(),'核对历史').props.onClick();props={...props,ownerKey:'employee-b'}
  expect(label(render())).not.toContain('原员工')
  resolve({items:[item],nextCursor:null});await vi.waitFor(()=>expect(states[1]).toBe(false))
  expect(label(render())).not.toContain('原员工');expect(props.onVerified).toHaveBeenCalledTimes(1)
 })
 it('paginates with the supplied cursor, deduplicates rows, and fails closed on a read error',async()=>{
  props.api.loadParticipantMovementHistory.mockResolvedValueOnce({items:[item],nextCursor:'cursor-one'}).mockResolvedValueOnce({items:[item,{...item,id:'second'}],nextCursor:null})
  button(render(),'核对历史').props.onClick();await vi.waitFor(()=>expect(states[1]).toBe(false))
  button(render(),'更早').props.onClick();await vi.waitFor(()=>expect(states[1]).toBe(false))
  expect(props.api.loadParticipantMovementHistory.mock.calls[1][0]).toBe('cursor-one');expect(states[3].data.items).toHaveLength(2)
  props.api.loadParticipantMovementHistory.mockRejectedValueOnce(new Error('权限已撤销'))
  button(render(),'核对历史').props.onClick();await vi.waitFor(()=>expect(states[1]).toBe(false))
  expect(states[3]).toBeNull();expect(label(render())).toContain('权限已撤销');expect(props.onVerified).toHaveBeenCalledTimes(2)
  expect(props.onInvalidated).toHaveBeenCalledTimes(3)
 })
 it('does not confirm a read after the panel has unmounted',async()=>{
  let resolve!:(v:unknown)=>void;props.api.loadParticipantMovementHistory.mockImplementation(()=>new Promise(r=>{resolve=r}))
  const tree=render();const cleanup=effects[0]!();button(tree,'核对历史').props.onClick();cleanup?.()
  resolve({items:[item],nextCursor:null});await new Promise(r=>setImmediate(r));expect(props.onVerified).not.toHaveBeenCalled()
 })
})
