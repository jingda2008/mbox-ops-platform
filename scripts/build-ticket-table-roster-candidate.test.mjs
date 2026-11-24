import assert from 'node:assert/strict'
import {test} from 'node:test'
import {buildTicketTableRosterCandidate as build} from './build-ticket-table-roster-candidate.mjs'
const fixture=()=>[
  {version:'fixture',areas:[{name:'正厅',code:'main'},{name:'吧台',code:'bar'}],tables:[{code:'A1',areaCode:'main'}]},
  {profileVersion:'fixture',sources:{liveView:'fixture view',ownerConfirmation:'fixture owner',historicRetention:'fixture historic'},
    liveRows:[{code:'B9',areaLabel:'吧台'},{code:'A1',areaLabel:'正厅'},{code:'A11',areaLabel:'正厅'},{code:'A9',areaLabel:'正厅'}],
    datedOperations:['A11'],ownerConfirmed:['B9'],historicRetained:['A9']},
]
test('full classification produces exact ticket-only candidates and exclusions, never import data',()=>{
  const result=build(...fixture())
  assert.equal(result.mode,'offline_review_candidate')
  assert.equal(result.productionReady,false)
  assert.deepEqual(result.tables.map(t=>[t.areaCode,t.code]),[['bar','B9'],['main','A1'],['main','A11']])
  assert.deepEqual(result.excluded.map(t=>t.code),['A9'])
  assert.equal(result.liveCount,4)
  assert.equal(result.includedCount,3)
  assert.equal(result.excludedCount,1)
  assert.ok(result.tables.every(t=>!Object.hasOwn(t,'id')&&!Object.hasOwn(t,'tableId')))
})
test('unclassified desk and overlap never silently disappear',()=>{
  const [p,e]=fixture()
  e.ownerConfirmed=[]
  assert.throws(()=>build(p,e),/未归类桌台：B9/)
  e.ownerConfirmed=['A9','B9']
  assert.throws(()=>build(p,e),/不能同时归类：A9/)
})
test('unknown desk and changed area on baseline fail closed',()=>{
  const [p,e]=fixture()
  e.ownerConfirmed=['B089']
  assert.throws(()=>build(p,e),/未能唯一核实/)
  e.ownerConfirmed=['B9']
  e.liveRows[1].areaLabel='吧台'
  assert.throws(()=>build(p,e),/不在同区现行视图/)
})
