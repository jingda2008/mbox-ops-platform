import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const helper=new URL('../deploy/aliyun/release-state.sh',import.meta.url).pathname
for(const result of ['safe','blocked','query_failed'])test(`rollback guard drains writers and ${result}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mbox-print-rollback-')),bin=join(dir,'bin'),log=join(dir,'docker.log')
 try{
  await mkdir(bin);await writeFile(join(dir,'release-manifest.json'),JSON.stringify({migration:{count:260}}));await writeFile(join(dir,'app.env'),'')
  await writeFile(join(bin,'docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$GUARD_LOG"
if [[ "$1" == inspect && "$*" == *State.Running* ]]; then echo false; exit 0; fi
if [[ "$1" == run ]]; then
 cat >/dev/null
 case "$GUARD_RESULT" in
 safe) echo '{"status":"safe","tenantId":"tenant","storeId":"store","policies":[],"action":"allow_previous_workers"}' ;;
 blocked) echo '{"status":"blocked","reason":"cashier_payment_inherited_cutoff","action":"keep_previous_workers_stopped"}';exit 2 ;;
 query_failed) exit 9 ;;
 esac
fi
`,{mode:0o700})
  const run=spawnSync('bash',['-c','source "$1"; release_assert_print_rollback_safe "$2" sha256:immutable 258 active candidate; echo guard-passed','_',helper,dir],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GUARD_LOG:log,GUARD_RESULT:result}})
  assert.equal(run.status,result==='safe'?0:2,run.stderr)
  const calls=(await readFile(log,'utf8')).trim().split('\n'),query=calls.findIndex(v=>v.startsWith('run '))
  assert.ok(calls.indexOf('stop -t 20 active')<query);assert.ok(calls.indexOf('stop -t 20 candidate')<query)
  assert.match(calls[query],/--env-file.*-e MBOX_START_WORKERS=false --entrypoint node sha256:immutable/)
  assert.equal(JSON.parse(await readFile(join(dir,'print-policy-rollback-guard.json'),'utf8')).status,result==='safe'?'safe':'blocked')
  if(result!=='safe')assert.doesNotMatch(run.stdout,/guard-passed/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('rollback callsites guard before starting old workers and record recovery/held state',async()=>{
 const external=await readFile(new URL('../deploy/aliyun/rollback-activated-release.sh',import.meta.url),'utf8')
 assert.ok(external.indexOf('release_assert_print_rollback_safe "')<external.indexOf('docker start "${rollback_container}"'))
 assert.match(external,/rollback aborted: restored current release/)
 const activation=(await readFile(new URL('../deploy/aliyun/activate-release.sh',import.meta.url),'utf8')).split('rollback_on_error()')[1]
 assert.ok(activation.indexOf('release_assert_print_rollback_safe "')<activation.indexOf('docker start "${active_container}"'))
 assert.match(activation,/print-policy-compatibility-blocked-writers-stopped/)
})

test('only explicit application boundaries require the contract maintenance chain',()=>{
 for(const [from,to,boundary] of [[95,96,96],[274,275,275],[274,282,275],[281,282,0],[282,283,0],[273,274,0],[275,281,0],[282,282,0]]){
  const result=spawnSync('bash',['-c','source "$1"; release_contract_boundary_between "$2" "$3"','_',helper,String(from),String(to)],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.equal(result.stdout.trim(),String(boundary),`${from} -> ${to}`)
 }
 for(const invalid of ['','oops','282;echo bypass']){
  const result=spawnSync('bash',['-c','source "$1"; release_contract_boundary_between "$2" 282','_',helper,invalid],{encoding:'utf8'})
  assert.equal(result.status,2)
 }
})

for(const [source,target] of [[275,274],[281,274],[282,274]])test(`contract rollback ${source} -> ${target} stops every writer without running an old worker or relying on empty tasks`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mbox-contract-rollback-')),bin=join(dir,'bin'),log=join(dir,'docker.log')
 try{
  await mkdir(bin);await writeFile(join(dir,'release-manifest.json'),JSON.stringify({migration:{count:source}}))
  await writeFile(join(bin,'docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$GUARD_LOG"
if [[ "$1" == inspect && "$*" == *State.Running* ]]; then echo false; fi
`,{mode:0o700})
  const result=spawnSync('bash',['-c','source "$1"; release_assert_print_rollback_safe "$2" sha256:immutable "$3" active previous; echo unsafe-accepted','_',helper,dir,String(target)],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GUARD_LOG:log}})
  assert.equal(result.status,2,result.stderr)
  const calls=await readFile(log,'utf8')
  assert.match(calls,/stop -t 20 active/);assert.match(calls,/stop -t 20 previous/)
  assert.doesNotMatch(calls,/(^|\n)(start|run|exec) /)
  assert.doesNotMatch(result.stdout,/unsafe-accepted/)
  assert.deepEqual(JSON.parse(await readFile(join(dir,'application-contract-rollback-guard.json'),'utf8')),{
   status:'blocked',reason:'incompatible_application_contract',sourceSchema:source,targetSchema:target,
   contractBoundary:275,action:'keep_previous_workers_stopped',writerDrainVerified:true,
   checkedAt:JSON.parse(await readFile(join(dir,'application-contract-rollback-guard.json'),'utf8')).checkedAt,
  })
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('activation selects contract mode from the immutable image and forbids a newer incompatible DB as the old baseline',async()=>{
 const activation=await readFile(new URL('../deploy/aliyun/activate-release.sh',import.meta.url),'utf8')
 const selection=activation.indexOf('contract_boundary=$(release_contract_boundary_between "${previous_manifest_schema_version}" "${expected_schema_version}")')
 const drain=activation.indexOf('docker stop -t 30 "${active_container}"')
 const migrate=activation.indexOf('run_database_maintenance_container dist-normalized/server/migrate-normalized.js\n')
 assert.ok(selection>0&&selection<drain&&drain<migrate)
 assert.match(activation.slice(selection-700,selection),/release_contract_boundary_between "\$\{previous_manifest_schema_version\}" "\$\{previous_schema_version\}"/)
 assert.match(activation,/--argjson contractBoundary "\$\{contract_boundary\}"/)
 assert.match(activation,/rollbackMode: \(if \$contractMigration == 1\s+then "forward_only_after_contract_cutover"/)
})

test('contract guard never claims writer drain when Docker is unavailable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mbox-contract-offline-')),bin=join(dir,'bin')
 try{
  await mkdir(bin);await writeFile(join(dir,'release-manifest.json'),JSON.stringify({migration:{count:282}}))
  await writeFile(join(bin,'docker'),'#!/bin/bash\nexit 1\n',{mode:0o700})
  const result=spawnSync('bash',['-c','source "$1"; release_assert_print_rollback_safe "$2" sha256:immutable 274 active previous','_',helper,dir],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}})
  assert.equal(result.status,2)
  assert.equal(JSON.parse(await readFile(join(dir,'application-contract-rollback-guard.json'),'utf8')).writerDrainVerified,false)
 }finally{await rm(dir,{recursive:true,force:true})}
})
