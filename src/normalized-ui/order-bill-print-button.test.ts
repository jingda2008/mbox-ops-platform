import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import {OrderBillPrintButton} from './OrderBillPrintButton'
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useRef:vi.fn()}))

describe('order bill print recovery',()=>{
 const stored=new Map<string,string>()
 let values:unknown[],refs:Array<{current:unknown}>,stateIndex:number,refIndex:number
 const post=vi.fn()
 const mount=()=>{values=[];refs=[];return render()}
 const render=()=>{
  stateIndex=0;refIndex=0
  const wrapper=OrderBillPrintButton({api:{postEndpoint:post} as unknown as NormalizedApiClient,orderId:'order-1',employeeId:'employee-1'})
  return wrapper.type(wrapper.props)
 }
 const press=(tree:ReturnType<typeof render>)=>tree.props.children[0].props.onClick()
 beforeEach(()=>{
  vi.clearAllMocks();stored.clear()
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)})
  vi.mocked(useState).mockImplementation(initial=>{
   const index=stateIndex++;if(!(index in values))values[index]=initial
   return [values[index],(value:unknown)=>{values[index]=value}] as never
  })
  vi.mocked(useRef).mockImplementation(initial=>{
   const index=refIndex++;return refs[index]??(refs[index]={current:initial}) as never
  })
 })
 afterEach(()=>vi.unstubAllGlobals())
 it('deduplicates same-render clicks and disables after queue acceptance, without claiming paper success',async()=>{
  let finish!:(value:unknown)=>void
  post.mockReturnValue(new Promise(resolve=>{finish=resolve}))
  const tree=mount();press(tree);press(tree)
  expect(post).toHaveBeenCalledOnce()
  finish({requestId:'request-1',jobIds:['job-1']})
  await vi.waitFor(()=>expect(values[2]).toBe(true))
  const next=render()
  expect(next.props.children[0].props.disabled).toBe(true)
  expect(String(values[1])).toContain('不代表已出纸')
 })
 it('retains the request identity across unknown result and remount',async()=>{
  post.mockRejectedValue(new Error('响应超时'))
  press(mount());await vi.waitFor(()=>expect(String(values[1])).toContain('响应超时'))
  const first=post.mock.calls[0][2].idempotencyKey
  press(mount());await vi.waitFor(()=>expect(post).toHaveBeenCalledTimes(2))
  expect(post.mock.calls[1][2].idempotencyKey).toBe(first)
  expect(stored.size).toBe(1)
 })
 it('creates a new request only after explicitly choosing a new amount snapshot',async()=>{
  post.mockResolvedValue({requestId:'request-first',jobIds:['job-first']})
  press(mount());await vi.waitFor(()=>expect(values[2]).toBe(true))
  const first=post.mock.calls[0][2].idempotencyKey
  render().props.children[3].props.onClick()
  expect(stored.size).toBe(0)
  expect(values[2]).toBe(false)
  press(render());await vi.waitFor(()=>expect(post).toHaveBeenCalledTimes(2))
  expect(post.mock.calls[1][2].idempotencyKey).not.toBe(first)
 })
})
