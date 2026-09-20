import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeCashCollection, readPendingCashCollection, rememberCashCollection, type PendingCashCollection } from './pending-cash-collection'

describe('cash collection recovery before server submission', () => {
  let data: Map<string, string>
  const attempt: PendingCashCollection = { employeeId:'alice',orderId:'one',orderIds:['one','two'],amountMinor:1000,provider:'cash',receiptReference:'receipt-one',idempotencyKey:'request-one' }
  beforeEach(() => { data=new Map();vi.stubGlobal('sessionStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),removeItem:(key:string)=>data.delete(key)}) })
  afterEach(()=>vi.unstubAllGlobals())
  it('restores exact employee, amount, order allocation and receipt after closing a sheet',()=>{
    rememberCashCollection('table',attempt)
    expect(readPendingCashCollection('table')).toEqual({attempt,error:null})
    expect(readPendingCashCollection('different-table')).toEqual({attempt:null,error:null})
  })
  it('blocks overwriting an unknown attempt with another employee or amount',()=>{
    rememberCashCollection('table',attempt)
    expect(()=>rememberCashCollection('table',{...attempt,employeeId:'bob',amountMinor:2000,idempotencyKey:'new'})).toThrow('先核对')
    completeCashCollection('table',{...attempt,idempotencyKey:'unrelated'})
    expect(readPendingCashCollection('table').attempt).toEqual(attempt)
  })
  it('allows a genuinely new same-amount receipt once the original is acknowledged',()=>{
    rememberCashCollection('table',attempt);completeCashCollection('table',attempt)
    const next={...attempt,idempotencyKey:'two',receiptReference:'receipt-two'}
    rememberCashCollection('table',next)
    expect(readPendingCashCollection('table').attempt).toEqual(next)
  })
  it('does not treat corrupt or unavailable persistence as no pending money',()=>{
    data.set('mbox.cash-collection.v1:table','invalid')
    expect(readPendingCashCollection('table').error).not.toBeNull()
    expect(()=>rememberCashCollection('table',attempt)).toThrow()
    vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:()=>{throw new Error('quota')}})
    expect(()=>rememberCashCollection('table',attempt)).toThrow('无法保存')
  })
})
