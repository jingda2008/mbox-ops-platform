import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { cleanEvent, createDiagnosticQueue } from './diagnostic-events.mjs'
const id = 'a1111111-1111-4111-8111-111111111111'
const event = {eventId:id,occurredAt:'2026-11-14T01:00:00.000Z',kind:'print_ambiguous',jobId:id,failureCode:'ambiguous_print_result'}
test('allowlist drops arbitrary private fields and rejects arbitrary codes',()=>{
  assert.deepEqual(cleanEvent({...event,secret:'password',ticket:'customer'}),event)
  for(const change of [{kind:'execute'},{jobId:'private'},{failureCode:'password'},{durationMs:-1},{occurredAt:'no'}]) assert.throws(()=>cleanEvent({...event,...change}))
})
test('persistent offline queue, partial ack and lost ack preserve same IDs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mbox-diag-'))
  try {
    const path=join(dir,'events.json');let q=createDiagnosticQueue(path)
    const one=await q.append({kind:'bridge_started'});const two=await q.append({kind:'print_ambiguous',jobId:id})
    await assert.rejects(q.flush(async()=>{throw Error('offline')}))
    q=createDiagnosticQueue(path)
    await q.flush(async batch=>{assert.equal(batch.length,2);assert.equal(batch[0].eventId,one.eventId);return {acceptedEventIds:[one.eventId,'foreign']}})
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')).events.map(e=>e.eventId),[two.eventId])
    await q.flush(async batch=>({acceptedEventIds:batch.map(e=>e.eventId)}))
    assert.equal(JSON.parse(await readFile(path,'utf8')).events.length,0)
  } finally {await rm(dir,{recursive:true,force:true})}
})
test('bounds storage and exposes dropped count, serializes concurrent appends',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mbox-diag-'))
  try {
    const path=join(dir,'events.json');const q=createDiagnosticQueue(path,{maxEvents:2})
    await Promise.all(Array.from({length:5},()=>q.append({kind:'bridge_started'})))
    const state=JSON.parse(await readFile(path,'utf8'));assert.equal(state.events.length,2);assert.equal(state.dropped,3)
  } finally {await rm(dir,{recursive:true,force:true})}
})
async function processHarness(printError,reportError,initial={}) {
  const source=await readFile(new URL('./bridge.mjs',import.meta.url),'utf8')
  let state={entries:structuredClone(initial)},prints=0;const events=[]
  const process=vm.runInNewContext(source.slice(source.indexOf('async function processJob'),source.indexOf('async function processCommand'))+';processJob',{
    requiredUuid:x=>x,requiredText:x=>x,readJournal:async()=>state,saveJournal:async value=>{state=structuredClone(value)},
    emitDiagnostic:async e=>events.push(e),renderTicket:()=>'',readProfile:x=>x,readCopies:x=>x,
    printText:async()=>{prints++;if(printError)throw printError},reportJob:async()=>{if(reportError)throw reportError},
    isDefinitelyNotSubmitted:e=>e.code==='ENOENT',normalizeFailure:()=> 'powershell_not_found',trimJournal:()=>{},Date,
  })
  const run=()=>process({}, {id,businessKey:'order-1',windowsQueueName:'bar',printSnapshot:{}})
  return {run,events,get state(){return state},get prints(){return prints}}
}
test('lost report retains accepted state and second claim never prints twice',async()=>{
  const h=await processHarness(null,Error('offline'))
  await assert.rejects(h.run());assert.equal(h.state.entries['order-1'].state,'printed')
  await assert.rejects(h.run());assert.equal(h.prints,1)
  assert.equal(h.events.at(-1).kind,'spool_accepted')
})
test('unknown transport outcome is ambiguous and subsequent claim never resends',async()=>{
  const h=await processHarness(Error('timeout'))
  await h.run();await h.run();assert.equal(h.prints,1)
  assert.equal(h.state.entries['order-1'].state,'ambiguous')
  assert.equal(h.events.at(-1).failureCode,'ambiguous_previous_attempt')
})
test('only a definite pre-submission failure permits another attempt',async()=>{
  const h=await processHarness(Object.assign(Error('missing'),{code:'ENOENT'}))
  await h.run();assert.equal(h.state.entries['order-1'],undefined)
  await h.run();assert.equal(h.prints,2)
})
test('corrupt diagnostics are quarantined with an explicit gap, never touch journal',async()=>{
  const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'mbox-diag-'))
  try {
    const path=join(dir,'events.json');await writeFile(path,'broken private data');await writeFile(join(dir,'journal.json'),'unchanged')
    const q=createDiagnosticQueue(path);await q.append({kind:'bridge_started'})
    await q.flush(async batch=>{assert.equal(batch.find(e=>e.kind==='diagnostic_gap').gapCount,1);assert.ok(!JSON.stringify(batch).includes('private'));return {acceptedEventIds:batch.map(e=>e.eventId)}})
    assert.equal(await readFile(join(dir,'journal.json'),'utf8'),'unchanged')
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('flush expires offline backlog and reports the resulting gap',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mbox-diag-'));let now=new Date('2026-11-01T00:00:00Z')
  try {const q=createDiagnosticQueue(join(dir,'events.json'),{now:()=>now});await q.append({kind:'bridge_started'});now=new Date('2026-11-14T00:00:00Z');await q.flush(async batch=>{assert.equal(batch.length,1);assert.equal(batch[0].kind,'diagnostic_gap');return {acceptedEventIds:batch.map(e=>e.eventId)}})}finally{await rm(dir,{recursive:true,force:true})}
})
test('journal malformed structures fail closed instead of enabling duplicate printing',async()=>{
  const source=await readFile(new URL('./bridge.mjs',import.meta.url),'utf8')
  for(const value of [{},{version:1,entries:null},{version:1,entries:[]},{version:1,entries:{a:{state:'unknown'}}}]){
    const read=vm.runInNewContext(source.slice(source.indexOf('async function readJournal()'),source.indexOf('function saveJournal'))+';readJournal',{readFile:async()=>JSON.stringify(value),journalPath:'not-used',requiredUuid:x=>x})
    await assert.rejects(read())
  }
})
test('unreadable journal creates a job incident and reports terminal failure without printing',async()=>{
  const source=await readFile(new URL('./bridge.mjs',import.meta.url),'utf8');const events=[];const reports=[]
  const process=vm.runInNewContext(source.slice(source.indexOf('async function processJob'),source.indexOf('async function processCommand'))+';processJob',{
    requiredUuid:x=>x,requiredText:x=>x,readJournal:async()=>{throw Error('corrupt')},emitDiagnostic:async e=>events.push(e),reportJob:async(...args)=>reports.push(args),printText:async()=>assert.fail('must not print'),
  })
  await process({}, {id,businessKey:'order-1'})
  assert.equal(events[0].kind,'print_ambiguous');assert.equal(events[0].jobId,id)
  assert.equal(reports[0][2],'failed');assert.equal(reports[0][3],'ambiguous_previous_attempt')
})
