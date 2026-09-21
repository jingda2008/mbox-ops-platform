import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptUrl = new URL('./run-normalized-postgres-tests.mjs', import.meta.url)

test('rejects remote, overridden and malformed test targets before any connection without disclosing credentials', () => {
  for (const url of [
    'postgresql://admin:DUMMY_PASSWORD_CANARY@not-connected.invalid/test',
    'postgresql://admin:DUMMY_PASSWORD_CANARY@127.0.0.1/test?host=not-connected.invalid',
    'postgresql://admin:DUMMY_PASSWORD_CANARY@127.0.0.1/test?user=other_admin',
    'postgresql://admin:DUMMY_PASSWORD_CANARY@127.0.0.1/test?password=override',
    'postgresql://admin:DUMMY_PASSWORD_CANARY@127.0.0.1/test?options=-c%20role=postgres',
    'postgresql://admin:DUMMY_PASSWORD_CANARY@',
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl)], {
      env: {...process.env, TEST_NORMALIZED_DATABASE_URL:url}, encoding:'utf8', timeout:5000,
    })
    assert.equal(result.status,1)
    assert.match(result.stderr,/只允许显式本机 PostgreSQL 登录/)
    assert.doesNotMatch(result.stderr+result.stdout,/DUMMY_PASSWORD_CANARY|not-connected.invalid|password=override|CREATE DATABASE/)
  }
})

test('normalized PostgreSQL suite always uses an isolated disposable database', async () => {
  const source = await readFile(scriptUrl, 'utf8')
  assert.match(source, /CREATE DATABASE/)
  assert.match(source, /pg_terminate_backend/)
  assert.match(source, /DROP DATABASE IF EXISTS/)
  assert.match(source, /TEST_NORMALIZED_DATABASE_URL: databaseUrl/)
  assert.match(source, /TEST_NORMALIZED_RUNTIME_DATABASE_URL: runtimeDatabaseUrl/)
  assert.match(source, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/)
  assert.match(source, /DROP ROLE IF EXISTS/)
  assert.match(source, /GRANT mbox_runtime TO/)
  assert.ok(source.indexOf('if (migrated !== 0)') < source.indexOf('CREATE ROLE'))
  assert.match(source, /--hookTimeout=30000/)
  assert.match(source, /if \(exitCode !== 0\) process\.exitCode = exitCode/)
  assert.doesNotMatch(source, /DROP SCHEMA\s+mbox/i)
})

// Execute the actual runner in an isolated Node process. Only its external
// boundaries are replaced: SQL is recorded without opening a socket, while
// migration/test children are real processes with delayed graceful shutdown.
const harness = `
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const [path,stage]=process.argv.slice(1);
const emit=(event)=>process.stdout.write(JSON.stringify(event)+'\\n');
class Client {
  async connect(){emit({kind:'connect'})}
  async query(sql,parameters){
    let kind;
    if(sql.includes('CREATE DATABASE'))kind='create_database';
    else if(sql.includes('CREATE ROLE'))kind='create_role';
    else if(sql.includes('GRANT mbox_runtime'))kind='grant_role';
    else if(sql.includes('pg_terminate_backend'))kind='terminate_database';
    else if(sql.includes('DROP DATABASE'))kind='drop_database';
    else if(sql.includes('DROP ROLE'))kind='drop_role';
    else throw new Error('Unexpected fixture query');
    const name=sql.match(/(?:CREATE|DROP) (?:DATABASE|ROLE)(?: IF EXISTS)? "([^"]+)"/)?.[1];
    emit({kind,...(name?{name}:{}),...(parameters?{parameters}:{})});
    if(stage==='role' && kind==='create_role')await new Promise(resolve=>{
      const keepAlive=setInterval(()=>{},1000);
      process.once('SIGTERM',()=>{clearInterval(keepAlive);setImmediate(resolve)});
    });
    return {rows:[]};
  }
  async end(){emit({kind:'admin_closed'})}
}
function launch(_executable,args,options){
  const phase=args.includes('./server/migrate-normalized.ts')?'migration':'suite';
  if(stage==='spawn_failure' && phase==='suite'){
    const child=spawn('/not-existing-normalized-runner-fixture',[],{stdio:'ignore'});
    child.once('close',()=>emit({kind:'child_closed',phase}));return child;
  }
  const child=spawn(process.execPath,['--input-type=module','-e',
    \`const phase=\${JSON.stringify(phase)},waiting=\${JSON.stringify(phase===stage || (stage==='stubborn' && phase==='suite'))},stubborn=\${JSON.stringify(stage==='stubborn')};
      const emit=(event)=>process.stdout.write(JSON.stringify({...event,phase})+'\\\\n');
      if(waiting){
        for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
          emit({kind:'child_signal',signal});
          if(stubborn)return;
          setTimeout(()=>{emit({kind:'child_finished'});process.exit(0)},80);
        });
        setInterval(()=>{},1000);emit({kind:'child_ready'});
      }else{emit({kind:'child_finished'});}
    \`],{stdio:options.stdio});
  child.once('close',(code,signal)=>emit({kind:'child_closed',phase,code,signal}));
  return child;
}
const source=(await readFile(path,'utf8')).replace(/^import .*\\n/gm,'');
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('Client','spawn','process','randomBytes',source);
await execute(Client,launch,process,randomBytes);
`

async function runIsolatedFixture(stage, signal) {
  const runner=spawn(process.execPath,['--input-type=module','-e',harness,fileURLToPath(scriptUrl),stage],{
    env:{...process.env,TEST_NORMALIZED_DATABASE_URL:'postgresql://fixture:dummy_secret@127.0.0.1:1/fixture'},
    stdio:['ignore','pipe','pipe'],
  })
  let stdout='',stderr='',sent=false
  const timer=setTimeout(()=>runner.kill('SIGKILL'),15_000)
  runner.stdout.on('data',chunk=>{
    stdout+=chunk
    const ready=stage==='role'?stdout.includes('"kind":"create_role"'):stdout.includes('"kind":"child_ready"')
    if(signal&&!sent&&ready){sent=true;runner.kill(signal)}
  })
  runner.stderr.on('data',chunk=>{stderr+=chunk})
  try {
    const exit=await new Promise((resolve,reject)=>{
      runner.once('error',reject)
      runner.once('close',(code,terminatedBy)=>resolve({code,terminatedBy}))
    })
    return {...exit,stderr,sent,events:stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}
  } finally {clearTimeout(timer)}
}

for(const signal of ['SIGINT','SIGTERM']) {
  for(const phase of ['migration','suite']) {
    test(`${signal} waits for the ${phase} child to close before cleaning only its generated resources`,async()=>{
      const result=await runIsolatedFixture(phase,signal)
      assert.equal(result.sent,true)
      assert.equal(result.code,signal==='SIGINT'?130:143,result.stderr)
      assert.equal(result.terminatedBy,null)
      const events=result.events
      assert.ok(events.some(event=>event.kind==='child_signal'&&event.signal===signal&&event.phase===phase))
      const closed=events.findIndex(event=>event.kind==='child_closed'&&event.phase===phase)
      assert.ok(closed>events.findIndex(event=>event.kind==='child_finished'&&event.phase===phase))
      assert.ok(events.findIndex(event=>event.kind==='terminate_database')>closed)
      const created=events.find(event=>event.kind==='create_database')
      assert.match(created.name,/^mbox_normalized_test_\d+_[a-f0-9]{8}$/)
      assert.deepEqual(events.find(event=>event.kind==='terminate_database').parameters,[created.name])
      assert.equal(events.find(event=>event.kind==='drop_database').name,created.name)
      const role=events.find(event=>event.kind==='create_role')
      if(phase==='suite'){
        assert.match(role.name,/^audit_security_login_[a-f0-9]{24}$/)
        assert.equal(events.find(event=>event.kind==='drop_role').name,role.name)
      }else assert.equal(role,undefined)
      assert.equal(events.at(-1).kind,'admin_closed')
    })
  }
}

test('cancellation during role creation waits for its acknowledgement then cleans it without starting another child',async()=>{
  const result=await runIsolatedFixture('role','SIGTERM')
  assert.equal(result.sent,true)
  assert.equal(result.code,143,result.stderr)
  assert.equal(result.events.some(event=>event.kind==='grant_role'||event.phase==='suite'),false)
  assert.equal(result.events.find(event=>event.kind==='drop_role').name,result.events.find(event=>event.kind==='create_role').name)
  assert.equal(result.events.at(-1).kind,'admin_closed')
})

test('a child spawn failure still closes the child before deleting the temporary database and login',async()=>{
  const result=await runIsolatedFixture('spawn_failure')
  assert.equal(result.code,1)
  assert.match(result.stderr,/ENOENT/)
  const closed=result.events.findIndex(event=>event.kind==='child_closed'&&event.phase==='suite')
  assert.ok(result.events.findIndex(event=>event.kind==='drop_database')>closed)
  assert.equal(result.events.find(event=>event.kind==='drop_role').name,result.events.find(event=>event.kind==='create_role').name)
  assert.equal(result.events.at(-1).kind,'admin_closed')
})

test('a child ignoring graceful cancellation is killed before the same cleanup runs',async()=>{
  const result=await runIsolatedFixture('stubborn','SIGTERM')
  assert.equal(result.sent,true)
  assert.equal(result.code,143,result.stderr)
  assert.equal(result.terminatedBy,null)
  assert.ok(result.events.some(event=>event.kind==='child_signal'&&event.signal==='SIGTERM'))
  const closed=result.events.findIndex(event=>event.kind==='child_closed'&&event.phase==='suite')
  assert.equal(result.events[closed].signal,'SIGKILL')
  assert.ok(result.events.findIndex(event=>event.kind==='drop_database')>closed)
  assert.equal(result.events.find(event=>event.kind==='drop_role').name,result.events.find(event=>event.kind==='create_role').name)
  assert.equal(result.events.at(-1).kind,'admin_closed')
})
