import assert from 'node:assert/strict'
import {test} from 'node:test'
import {planTicketTableRoster} from './plan-ticket-table-roster.mjs'
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={tenantId:id(1),storeId:id(2)}
function fixture(){
  const row=(code,areaCode,n,status='available',areaStatus='active')=>({code,areaCode,id:id(n),status,areaStatus})
  return {
    manifest:{...scope,complete:true,source:'synthetic signed-off layout',confirmedAt:'2026-11-24T15:20:00+08:00',tables:[{code:'A1',areaCode:'inside'},{code:'V1',areaCode:'vip'}]},
    snapshot:{...scope,tables:[row('A1','inside',11),row('A01','inside',12),row('OLD1','inside',13),row('V1','vip',14),row('V2','vip',15,'paused')],existingTicketTableIds:[id(13),id(14)]},
  }
}
test('matches signed-off current desks by exact scope, area and code; preserves stable IDs',()=>{
  const input=fixture()
  const before=structuredClone(input)
  const plan=planTicketTableRoster(input)
  assert.deepEqual(plan.ticketWhitelist.map(({tableId})=>tableId),[id(11),id(14)])
  assert.deepEqual(plan.membershipDiff.add.map(({code})=>code),['A1'])
  assert.deepEqual(plan.membershipDiff.keep.map(({code})=>code),['V1'])
  assert.deepEqual(plan.membershipDiff.remove.map(({code})=>code),['OLD1'])
  assert.deepEqual(plan.notSelectedAvailable.map(({code})=>code),['A01','OLD1'])
  assert.deepEqual(input,before)
})
test('blocks the entire plan when a selected code is missing, moved, or paused',()=>{
  const input=fixture()
  input.manifest.tables=[{code:'A1',areaCode:'vip'},{code:'MISSING1',areaCode:'vip'},{code:'V2',areaCode:'vip'}]
  const plan=planTicketTableRoster(input)
  assert.equal(plan.ticketWhitelist,null)
  assert.equal(plan.membershipDiff,null)
  assert.deepEqual(plan.blocked.map(({reason})=>reason),['area_mismatch','not_in_store_master','not_operational_in_master'])
})
test('blocked when physical table area is inactive',()=>{
  const input=fixture()
  input.snapshot.tables[0].areaStatus='retired'
  assert.equal(planTicketTableRoster(input).blocked[0].reason,'not_operational_in_master')
})
test('rejects ambiguous, partial, wrong-store and unreviewed input',()=>{
  const cases=[
    [x=>{x.manifest.tables.push(x.manifest.tables[0])},/营业名单重复/],
    [x=>{x.snapshot.tables.push({...x.snapshot.tables[0],code:'A88'})},/桌台身份重复/],
    [x=>{x.manifest.complete=false},/完整营业/],
    [x=>{x.manifest.source=''},/注明来源/],
    [x=>{x.manifest.confirmedAt='2026-11-24'},/注明来源/],
    [x=>{x.snapshot.storeId=id(3)},/同一门店/],
    [x=>{x.snapshot.existingTicketTableIds.push(id(999))},/不一致/],
  ]
  for(const [change,error] of cases){const input=fixture();change(input);assert.throws(()=>planTicketTableRoster(input),error)}
})
