import {describe,it,expect} from 'vitest'
import {GuestCartState,GuestReadSequence} from './guest-cart-state'
import type {GuestSharedCart} from './guest-api'
const cart=(generation:number,version:number)=>({generation,version}) as GuestSharedCart

describe('guest cart response ordering',()=>{
  it('rejects an old GET after a cart write, including checkout',()=>{
    const state=new GuestCartState(),read=state.readToken()
    const scope=state.beginWrite()
    expect(state.accept(cart(1,2),scope)).toBe(true)
    expect(state.accept(cart(1,1),scope,read)).toBe(false)
    expect(state.accept(cart(1,1),scope,state.readToken())).toBe(false)
  })
  it('allows authoritative refresh after a rejected write but never rolls back a generation',()=>{
    const state=new GuestCartState();state.accept(cart(1,8),state.scope)
    state.beginWrite();expect(state.accept(cart(2,0),state.scope,state.readToken())).toBe(true)
    expect(state.accept(cart(1,99),state.scope)).toBe(false)
  })
  it('rejects every response from a previous table or guest session',()=>{
    const state=new GuestCartState(),read=state.readToken(),write=state.beginWrite()
    state.reset()
    expect(state.isCurrentRead(read)).toBe(false)
    expect(state.accept(cart(10,10),write)).toBe(false)
    expect(state.accept(cart(1,0),state.scope)).toBe(true)
  })
})

it('keeps slow polling productive while rejecting a late response after a newer result was applied',()=>{
  const reads=new GuestReadSequence(),first=reads.start(),second=reads.start()
  expect(reads.accept(first)).toBe(true)
  const third=reads.start()
  expect(reads.accept(second)).toBe(true)
  expect(reads.accept(third)).toBe(true)
  expect(reads.accept(first)).toBe(false)
})
