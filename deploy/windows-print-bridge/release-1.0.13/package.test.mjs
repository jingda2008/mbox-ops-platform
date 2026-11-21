import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {resolve} from 'node:path'
const root=resolve(process.env.MBOX_TEST_PACKAGE || 'artifacts/print-bridge-1.0.13/MBOX-PrintBridge-1.0.13-OneClick-r1')
const source=await readFile(resolve(root,'bridge.mjs'),'utf8')
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)))
const id='a1111111-1111-4111-8111-111111111111'
function harness({printError,reportError,journalError,initial={}}={}) {
 let state={version:1,entries:structuredClone(initial)},prints=0;const events=[],reports=[],payloads=[]
 const run=vm.runInNewContext(slice('async function processJob','async function processCommand')+';processJob',{
  requiredUuid:x=>x,requiredText:x=>x,readJournal:async()=>{if(journalError)throw journalError;return state},saveJournal:async s=>{state=structuredClone(s)},
  emitDiagnostic:async e=>events.push(e),renderReceiptLayout:()=>({rows:[{text:'原票据'}]}),readProfile:x=>x,readCopies:x=>x,usesSmallBillItems:()=>true,RECEIPT_HEADER_LOGO_BITS:'original',
  printText:async p=>{prints++;payloads.push(p);if(printError)throw printError},reportJob:async(...r)=>{reports.push(r);if(reportError)throw reportError},isDefinitelyNotSubmitted:e=>e.code==='ENOENT',normalizeFailure:()=> 'powershell_not_found',trimJournal:()=>{},Date,
 })
 return {run:()=>run({}, {id,businessKey:'key',windowsQueueName:'bar',printSnapshot:{kind:'daily_settlement'}}),get state(){return state},get prints(){return prints},events,reports,payloads}
}
test('lost result acknowledgement retains printed and never repeats submission',async()=>{const h=harness({reportError:Error('offline')});await assert.rejects(h.run());await assert.rejects(h.run());assert.equal(h.prints,1);assert.equal(h.state.entries.key.state,'printed');assert.equal(h.events.at(-1).kind,'spool_accepted');assert.equal(h.payloads[0].structured,true);assert.equal(h.payloads[0].compact,true);assert.equal(h.payloads[0].headerLogoBits,'original')})
test('unknown end-page / end-document result never retries automatically',async()=>{for(const message of ['end_page_failed','end_doc_failed','timeout']){const h=harness({printError:Error(message)});await h.run();await h.run();assert.equal(h.prints,1);assert.equal(h.state.entries.key.state,'ambiguous')}})
test('definite failure before submission is retryable',async()=>{const h=harness({printError:Object.assign(Error('missing'),{code:'ENOENT'})});await h.run();await h.run();assert.equal(h.prints,2);assert.equal(h.state.entries.key,undefined)})
test('corrupt journal never reaches the printer',async()=>{const h=harness({journalError:Error('corrupt')});await h.run();assert.equal(h.prints,0);assert.equal(h.events[0].kind,'print_ambiguous')})
test('legacy printing and ambiguous journal entries stay blocked',async()=>{for(const state of ['printing','ambiguous']){const h=harness({initial:{key:{state,jobId:id,updatedAt:new Date().toISOString()}}});await h.run();assert.equal(h.prints,0);assert.equal(h.state.entries.key.state,'ambiguous')}})
test('journal schema rejects arrays, missing versions and malformed entries',async()=>{for(const value of [{},{version:1,entries:[]},{version:1,entries:{a:{state:'unknown'}}}]){const read=vm.runInNewContext(slice('async function readJournal()','function saveJournal')+';readJournal',{readFile:async()=>JSON.stringify(value),journalPath:'unused',requiredUuid:x=>x});await assert.rejects(read())}})
test('runtime readiness is written only after accepted heartbeat',async()=>{let statuses=[];const fn=vm.runInNewContext(slice('async function heartbeat','async function emitDiagnostic')+';heartbeat',{assertPaired:()=>{},listQueues:async()=>[],authenticatedRequest:async()=>{throw Error('offline')},hostname:()=> 'fixture',VERSION:'1.0.13',runtimeStatusPath:'unused',atomicState:async(...x)=>statuses.push(x)});await assert.rejects(fn({}));assert.equal(statuses.length,0)})
