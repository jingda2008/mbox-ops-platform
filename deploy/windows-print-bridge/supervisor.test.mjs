import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { reserveRecovery, observeProgress, runSupervisor, validateBudget } from './supervisor.mjs'
const initial = () => ({ version: 1, recoveries: [], lastNow: 1000000, halted: false })
async function fixture(action) { const path = await mkdtemp(join(tmpdir(), 'mbox-supervisor-')); try { await action(path) } finally { await rm(path, { recursive: true, force: true }) } }

test('two recovery reservations in ten minutes then durable halt', () => {
 let state = reserveRecovery(initial(), 1000001)
 state = reserveRecovery(state, 1000002)
 state = reserveRecovery(state, 1000003)
 assert.equal(state.halted, true)
 assert.equal(state.reason, 'recovery_exhausted')
 assert.equal(reserveRecovery(state, 9999999).halted, true)
})
test('rolling budget expires only for a non-halted supervisor', () => {
 const state = reserveRecovery({ ...initial(), recoveries: [1000000,1000001] }, 1600002)
 assert.equal(state.halted, false); assert.equal(state.recoveries.length, 1)
})
test('clock regression and malformed budgets fail closed', () => {
 assert.equal(reserveRecovery(initial(), 999999).halted, true)
 for (const value of [null, {}, { ...initial(), recoveries: ['bad'] }, { ...initial(), recoveries: [1,2,3] }]) assert.throws(() => validateBudget(value))
})
test('progress must advance, belong to this start, and not lie in future', () => {
 const start = { startedAt: 1000000, lastStamp: 999999, lastProgressAt: 1000000, lastNow: 1000000 }
 for (const raw of [{ updatedAt: new Date(999999).toISOString() }, { updatedAt: new Date(2000000).toISOString() }, {}, { updatedAt: 'bad' }]) assert.equal(observeProgress(start, raw, 1120000).stalled, true)
 const fresh = observeProgress(start, { updatedAt: new Date(1110000).toISOString() }, 1120000)
 assert.equal(fresh.stalled, false)
 assert.equal(observeProgress(fresh, { updatedAt: new Date(1110000).toISOString() }, 1230000).stalled, true)
 assert.equal(observeProgress(start, {}, 999999).halt, true)
})
test('stalled child is terminated with bounded restarts; budget survives relaunch', async () => fixture(async data => {
 let time = 1000000, starts = 0, terminations = 0
 const options = { data, now: () => time, sleep: async ms => { time += ms }, start: () => { starts++; return new EventEmitter() }, terminate: async () => { terminations++; return true } }
 await runSupervisor(options)
 assert.equal(starts, 3); assert.equal(terminations, 3)
 assert.equal(JSON.parse(await readFile(join(data,'supervisor-budget.json'),'utf8')).halted, true)
 assert.equal(JSON.parse(await readFile(join(data,'supervisor-status.json'),'utf8')).kind,'recovery_exhausted')
 await runSupervisor(options); assert.equal(starts, 3)
}))
test('healthy progress through network failures does not restart', async () => fixture(async data => {
 let time = 1000000, starts = 0, ticks = 0
 await runSupervisor({ data, now: () => time, sleep: async ms => { time += ms; ticks++; await writeFile(join(data,'progress.json'),JSON.stringify({updatedAt:new Date(time).toISOString()})) }, start: () => { starts++; return new EventEmitter() }, terminate: async () => true, stopRequested: () => ticks > 40 })
 assert.equal(starts,1)
 assert.equal(JSON.parse(await readFile(join(data,'supervisor-status.json'),'utf8')).kind,'stopped')
}))
test('corrupt budget, unclean shutdown, and existing lock do not start a child', async () => {
 for (const mode of ['budget','status','lock']) await fixture(async data => {
  if(mode === 'budget') await writeFile(join(data,'supervisor-budget.json'),'{bad')
  if(mode === 'status') await writeFile(join(data,'supervisor-status.json'),JSON.stringify({kind:'running'}))
  if(mode === 'lock') await mkdir(join(data,'supervisor.lock'))
  let starts = 0
  const action = runSupervisor({data,start:()=>{starts++;return new EventEmitter()}})
  if(mode === 'lock') await assert.rejects(action); else await action
  assert.equal(starts,0)
 })
})
test('unconfirmed termination retains lock and does not restart', async () => fixture(async data => {
 let time=1000000, starts=0
 await runSupervisor({data,now:()=>time,sleep:async ms=>{time+=ms},start:()=>{starts++;return new EventEmitter()},terminate:async()=>false})
 assert.equal(starts,1)
 await assert.rejects(runSupervisor({data,start:()=>{starts++;return new EventEmitter()}}))
 assert.equal(starts,1)
}))
test('natural child exit recovers within budget only without an in-flight journal', async () => {
 for (const inflight of [false,true]) await fixture(async data => {
  let time=1000000,starts=0,child
  if(inflight) await writeFile(join(data,'journal.json'),JSON.stringify({entries:{ticket:{state:'printing'}}}))
  await runSupervisor({data,now:()=>time,sleep:async ms=>{time+=ms;child?.emit('exit',1)},start:()=>{starts++;child=new EventEmitter();return child},terminate:async()=>true})
  assert.equal(starts,inflight?1:3)
  if(inflight) assert.equal(JSON.parse(await readFile(join(data,'supervisor-status.json'),'utf8')).reason,'supervisor_inflight_exit')
 })
})
