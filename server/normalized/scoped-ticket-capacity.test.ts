import { describe, expect, it } from 'vitest'
import { planScopedDeskPromises as plan, type DeskPromise } from './scoped-ticket-capacity.js'
const p=(id:string,start:number,end:number,tableIds:string[]|null=null,assignedIds:string[]=[],quantity=1):DeskPromise=>({id,start,end,tableIds,assignedIds,quantity})
describe('scoped ticket inventory feasibility prototype',()=>{
 it('matches legacy and scoped promises jointly without giving away the only scoped desk',()=>{
  expect(plan(['A1','A2'],[p('legacy',1,5),p('scope',1,5,['A1'])],[])).toEqual({feasible:true,assignments:{legacy:['A2'],scope:['A1']}})
  expect(plan(['A1','A2'],[p('one',1,5,['A1']),p('two',1,5,['A1'])],[])).toEqual({feasible:false,reason:'capacity'})
 })
 it('respects fixed assignment, unrelated bookings and exact scope',()=>{
  expect(plan(['A1','A2'],[p('one',1,5,['A1'],['A1'])],[{tableId:'A1',start:1,end:5,promiseId:'one'}])).toEqual({feasible:true,assignments:{one:['A1']}})
  expect(plan(['A1','A2'],[p('one',1,5,['A1'],['A1'])],[{tableId:'A1',start:1,end:5,promiseId:'other'}])).toMatchObject({feasible:false})
  expect(plan(['A1','A2'],[p('one',1,5,['A1'],['A2'])],[])).toMatchObject({feasible:false})
 })
 it('uses half-open intervals and rejects a genuine bridge conflict',()=>{
  expect(plan(['A1'],[p('first',1,3,['A1']),p('next',3,5,['A1'])],[])).toEqual({feasible:true,assignments:{first:['A1'],next:['A1']}})
  expect(plan(['A1','A2','A3','A4'],[p('first',1,3,['A1']),p('bridge',2,6,['A1','A2']),p('next',5,7,['A2'])],[])).toMatchObject({feasible:false})
 })
 it('handles partial assignments and verifies each remaining promised unit',()=>{
  expect(plan(['A1','A2','A3'],[p('two',1,5,['A1','A2'],['A2'],2),p('legacy',1,5)],[])).toEqual({feasible:true,assignments:{two:['A2','A1'],legacy:['A3']}})
 })
 it('fails closed for malformed or no longer eligible tables',()=>{
  expect(plan(['A1'],[p('bad',5,1)],[])).toEqual({feasible:false,reason:'invalid'})
  expect(plan(['A1'],[p('bad',1,5,['A1','A1'])],[])).toEqual({feasible:false,reason:'invalid'})
  expect(plan(['A1'],[p('old',1,5,['OLD1'])],[])).toEqual({feasible:false,reason:'capacity'})
 })
 it('reuses disjoint endpoints despite a bridge with a second desk',()=>{
  expect(plan(['A1','A2'],[p('left',1,4,['A1']),p('bridge',3,6,['A1','A2']),p('right',5,8,['A1'])],[])).toEqual({feasible:true,assignments:{left:['A1'],bridge:['A2'],right:['A1']}})
 })
 it('separates a search limit from capacity or a fixed feasible solution',()=>{
  expect(plan(['A1'],[p('slow',1,4,['A1'])],[],0)).toEqual({feasible:false,reason:'indeterminate'})
  expect(plan(['A1'],[p('fixed',1,4,['A1'],['A1'])],[],0)).toMatchObject({feasible:true})
  expect(plan(['A1'],[p('blocked',1,4,['A1'])],[{tableId:'A1',start:2,end:3}],0)).toEqual({feasible:false,reason:'capacity'})
 })
})
