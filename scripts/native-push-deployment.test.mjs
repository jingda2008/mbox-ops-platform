import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
const activation=await readFile(new URL('../deploy/aliyun/activate-release.sh',import.meta.url),'utf8')
const helper=activation.split('# BEGIN NATIVE PUSH SECRET GUARD')[1].split('\n').slice(1).join('\n').split('# END NATIVE PUSH SECRET GUARD')[0]
for(const scenario of ['disabled','valid','missing','symlink','bad-owner','bad-group','bad-mode','parent-write','wrong-path','root-user','docker-failed','empty','oversized'])test(`native push secret mount guard ${scenario}`,async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'mbox-push-mount-'))),bin=join(dir,'bin'),root=join(dir,'install'),secretDir=join(root,'secrets/native-push'),key=join(secretDir,'apns.p8'),envFile=join(dir,'app.env'),log=join(dir,'docker.log')
 try{
  await mkdir(bin);await mkdir(secretDir,{recursive:true});await writeFile(key,scenario==='empty'?'':scenario==='oversized'?'x'.repeat(16385):'PRIVATE-KEY-SENTINEL',{mode:0o440})
  if(scenario==='missing')await rm(key)
  if(scenario==='symlink'){await rm(key);await writeFile(join(secretDir,'other.p8'),'other');await symlink('other.p8',key)}
  if(scenario==='bad-mode')await chmod(key,0o444)
  if(scenario==='parent-write')await chmod(secretDir,0o777)
  await writeFile(envFile,`MBOX_NATIVE_PUSH_ENABLED=${scenario==='disabled'?'false':'true'}\nMBOX_APNS_PRIVATE_KEY_FILE=${scenario==='wrong-path'?'/tmp/anything':'/run/mbox-native-push/apns.p8'}\n`)
  // Execute the exact production guard with portable stat metadata; no real /opt or Docker is touched.
  await writeFile(join(bin,'stat'),`#!${process.execPath}\nimport{statSync}from'node:fs';const path=process.argv.at(-1),s=statSync(path),format=process.argv[3],isKey=path===process.env.TEST_KEY,inside=path.startsWith(process.env.TEST_ROOT);let value;if(format==='%u')value=isKey&&process.env.SCENARIO==='bad-owner'?1000:0;else if(format==='%g')value=process.env.SCENARIO==='bad-group'?999:1000;else if(format==='%a')value=inside?(s.mode&4095).toString(8):'755';else if(format==='%s')value=s.size;else process.exit(2);process.stdout.write(String(value));\n`,{mode:0o700})
  await writeFile(join(bin,'docker'),`#!/bin/bash\nprintf '%s\\n' "$*" >> "$TEST_LOG"\ncase "$SCENARIO" in docker-failed) exit 8 ;; root-user) printf '0:0' ;; *) printf '1000:1000' ;; esac\n`,{mode:0o700})
  const run=spawnSync('bash',['-eu','-c',helper+'\nprepare_native_push_mount\nprintf "%s\\n" "${native_push_mount_args[@]}"'],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,install_root:root,release_env:envFile,image_tag:'sha256:verified',SCENARIO:scenario,TEST_KEY:key,TEST_ROOT:root,TEST_LOG:log}})
  const accepted=['disabled','valid'].includes(scenario);assert.equal(run.status===0,accepted,run.stderr)
  assert.ok(!run.stdout.includes('PRIVATE-KEY-SENTINEL'));assert.ok(!run.stderr.includes('PRIVATE-KEY-SENTINEL'))
  if(scenario==='valid'){assert.match(run.stdout,/dst=\/run\/mbox-native-push\/apns.p8,readonly/);assert.match(await readFile(log,'utf8'),/--network none --read-only --cap-drop ALL/)}
  if(scenario==='disabled'){assert.equal(run.stdout.trim(),'');await assert.rejects(readFile(log,'utf8'))}
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('the same verified secret mount is passed to preflights, maintenance, candidate and full candidate',()=>{
 assert.ok(activation.indexOf('prepare_native_push_mount\n')<activation.indexOf('config-preflight.json'))
 assert.equal((activation.match(/"\$\{native_push_mount_args\[@\]\}"/g)||[]).length,5)
 assert.match(activation,/full_candidate_docker_args\+=\([\s\S]*?native_push_mount_args/)
 assert.match(activation,/run_database_maintenance_container\(\)[\s\S]*?native_push_mount_args/)
})
