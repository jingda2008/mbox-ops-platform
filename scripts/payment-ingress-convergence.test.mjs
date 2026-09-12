import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

for(const fail of [false,true]) test(`ingress convergence ${fail?'keeps legacy running and restores routes when probe fails':'verifies both routes before retiring legacy runtime'}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mbox-converge-')),bin=join(dir,'bin'),root=join(dir,'mbox')
 try{
  await mkdir(bin);await mkdir(join(root,'config'),{recursive:true});await mkdir(join(root,'data/mbox-ingress'),{recursive:true})
  const config=join(root,'Caddyfile'),snippet=join(root,'data/mbox-ingress/payment-domain.caddy'),watchdog=join(root,'config/health-watchdog.env')
  const original='https://pay.example {\n reverse_proxy mbox-app:8787\n}\n'
  await writeFile(config,original);await writeFile(snippet,original);await writeFile(watchdog,'MBOX_REQUIRED_CONTAINERS="mbox-app mbox-caddy"\n')
  await writeFile(join(bin,'flock'),'#!/bin/sh\nexit 0\n',{mode:0o700})
  await writeFile(join(bin,'docker'),`#!/bin/sh
case "$*" in
 'inspect mbox-caddy') printf '%s\\n' '[{"Mounts":[{"Destination":"/etc/caddy/Caddyfile","Source":"${config}"},{"Destination":"/data","Source":"${root}/data"}]}]' ;;
 *org.opencontainers.image.revision*) printf '%s\\n' "$MBOX_EXPECTED_LEGACY_SHA" ;;
 *State.Running*) if [ -f '${dir}/stopped' ]; then echo false; else echo true; fi ;;
 'stop --time 30 mbox-app') touch '${dir}/stopped' ;;
 *) exit 0 ;;
esac
`,{mode:0o700})
  await writeFile(join(bin,'curl'),`#!/bin/sh
sha="$MBOX_EXPECTED_PRIMARY_SHA"
case "$*" in *pay.shmbox.com:443:127.0.0.1*) if [ "$MBOX_TEST_FAIL" = 1 ]; then sha=wrong; fi ;; esac
printf '{"status":"ready","deploymentTier":"production","commitSha":"%s"}\\n' "$sha"
`,{mode:0o700})
  const script=join(dir,'run.sh');await writeFile(script,(await readFile(new URL('../deploy/aliyun/converge-payment-ingress.sh',import.meta.url),'utf8')).replaceAll('/opt/mbox',root))
  const result=spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,MBOX_EXPECTED_PRIMARY_SHA:'a'.repeat(40),MBOX_EXPECTED_LEGACY_SHA:'b'.repeat(40),MBOX_TEST_FAIL:fail?'1':'0'}})
  if(fail){assert.notEqual(result.status,0);await assert.rejects(access(join(dir,'stopped')));assert.equal(await readFile(config,'utf8'),original);assert.match(await readFile(watchdog,'utf8'),/mbox-app mbox-caddy/)}
  else{assert.equal(result.status,0,result.stderr);await access(join(dir,'stopped'));assert.match(await readFile(config,'utf8'),/tls_server_name mbox.shmbox.com/);assert.doesNotMatch(await readFile(config,'utf8'),/reverse_proxy mbox-app/);assert.equal(await readFile(watchdog,'utf8'),'\nMBOX_REQUIRED_CONTAINERS="mbox-caddy"\n')}
 }finally{await rm(dir,{recursive:true,force:true})}
})
