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
