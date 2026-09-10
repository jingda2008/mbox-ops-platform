import {describe,it,expect} from 'vitest'
import {clearStaffOrderDraft,readStaffOrderDraft,saveStaffOrderDraft,staffOrderDraftKey,type StaffOrderDraft} from './staff-order-draft'
function storage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}}
const draft:StaffOrderDraft={quantities:{bundle:2},selections:{bundle:[{groups:[{groupId:'cocktail',productIds:['a']}]},{groups:[{groupId:'cocktail',productIds:['b']}]}]},notes:{bundle:'两份少冰'},note:'一起上齐',giftReason:'会员礼遇'}
describe('unsubmitted staff order drafts',()=>{
  it('keeps quantities, per-bundle choices and notes in employee/table/mode scope',()=>{
    const store=storage(),key=staffOrderDraftKey('employee-a','table-a','paid')
    saveStaffOrderDraft(key,draft,store,1000)
    expect(readStaffOrderDraft(key,store,2000)).toEqual(draft)
    for(const other of [staffOrderDraftKey('employee-b','table-a','paid'),staffOrderDraftKey('employee-a','table-b','paid'),staffOrderDraftKey('employee-a','table-a','gift')])expect(readStaffOrderDraft(other,store,2000).quantities).toEqual({})
    clearStaffOrderDraft(key,store)
    expect(readStaffOrderDraft(key,store,2000).quantities).toEqual({})
  })
  it('expires abandoned drafts and rejects invalid or blocked storage without blocking ordering',()=>{
    const store=storage()
    saveStaffOrderDraft('draft',draft,store,1000)
    expect(readStaffOrderDraft('draft',store,1000+12*3600_000+1).quantities).toEqual({})
    store.setItem('draft','not-json');expect(readStaffOrderDraft('draft',store).quantities).toEqual({})
    const blocked={getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')},removeItem:()=>{throw Error('blocked')}}
    expect(()=>saveStaffOrderDraft('draft',draft,blocked)).not.toThrow()
    expect(readStaffOrderDraft('draft',blocked).quantities).toEqual({})
    expect(()=>clearStaffOrderDraft('draft',blocked)).not.toThrow()
  })
  it('drops negative and malformed quantities, trims notes, and rejects malformed bundle choices',()=>{
    const store=storage();store.setItem('draft',JSON.stringify({savedAt:1000,quantities:{good:1,bad:-1,huge:1000},notes:{good:'a'.repeat(400)},selections:{good:[{groups:[{groupId:'x',productIds:[7]}]}]}}))
    const result=readStaffOrderDraft('draft',store,2000)
    expect(result.quantities).toEqual({good:1});expect(result.notes.good).toHaveLength(300);expect(result.selections).toEqual({})
  })
  it('does not restore reserved object keys',()=>{
    const store=storage()
    store.setItem('draft','{"savedAt":1000,"quantities":{"__proto__":1,"constructor":2,"prototype":3,"normal":1}}')
    expect(readStaffOrderDraft('draft',store,2000).quantities).toEqual({normal:1})
  })
})
