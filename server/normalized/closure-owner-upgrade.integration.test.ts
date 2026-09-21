import {randomBytes,randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {stripVTControlCharacters} from 'node:util'
import {Client} from 'pg'
import {describe,expect,it} from 'vitest'
import {loadNormalizedMigrations,unwrapNormalizedMigrationTransaction} from '../migrate-normalized.js'

const url=process.env.TEST_NORMALIZED_ADMIN_URL??process.env.TEST_NORMALIZED_DATABASE_URL
const identifier=(name:string)=>`"${name.replaceAll('"','""')}"`
;(url?describe:describe.skip)('financial closure across maintenance account replacement',()=>{
  it('hands off only the closure definer and runs financial commands with a real restricted LOGIN',async()=>{
    const suffix=randomUUID().replaceAll('-','').slice(0,12)
    const database=`closure_upgrade_${suffix}`,old=`closure_old_${suffix}`,runtime=`closure_app_${suffix}`
    const password=randomBytes(24).toString('hex')
    const clusterUrl=new URL(url!);clusterUrl.pathname='/postgres'
    const admin=new Client({connectionString:clusterUrl.toString()});await admin.connect()
    let client:Client|undefined
    try{
      await admin.query(`CREATE ROLE ${identifier(old)} NOLOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION`)
      if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='mbox_runtime'")).rowCount)await admin.query('CREATE ROLE mbox_runtime NOLOGIN NOINHERIT')
      await admin.query(`GRANT mbox_runtime TO ${identifier(old)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`)
      await admin.query(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(old)} TEMPLATE template0`)
      const target=new URL(url!);target.pathname=`/${database}`
      client=new Client({connectionString:target.toString()});await client.connect()
      await client.query(`SET ROLE ${identifier(old)}`)
      await client.query(`CREATE SCHEMA mbox;
        CREATE TABLE mbox.normalized_schema_metadata(singleton boolean PRIMARY KEY DEFAULT true,
          schema_flavor text NOT NULL,schema_version text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE mbox.normalized_schema_migrations(version text PRIMARY KEY,filename text NOT NULL UNIQUE,
          checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
        INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version) VALUES(true,'normalized-core-v1','000')`)
      const migrations=await loadNormalizedMigrations()
      const apply=async(from:number,to:number)=>{
        for(const migration of migrations.filter(m=>Number(m.version)>=from&&Number(m.version)<=to)){
          await client!.query('BEGIN')
          try{
            await client!.query(unwrapNormalizedMigrationTransaction(migration.sql))
            await client!.query('INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum) VALUES($1,$2,$3)',[migration.version,migration.filename,migration.checksum])
            await client!.query('COMMIT')
          }catch(error){await client!.query('ROLLBACK');throw error}
        }
      }
      await apply(1,224);await client.query('RESET ROLE');await apply(225,241)
      const signature='mbox.lock_table_session_for_closure_fact_write()'
      const before=(await client.query('SELECT pg_get_functiondef($1::regprocedure) definition,proowner::regrole::text owner,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
      expect(before.owner).toBe(old);expect(before.prosecdef).toBe(true)
      await client.query(`SET ROLE ${identifier(old)}`)
      await expect(client.query("SELECT mbox.allow_closed_debt_manual_payment('{}'::jsonb,NULL)")).rejects.toMatchObject({code:'42501',message:'permission denied for function allow_closed_debt_manual_payment'})
      await client.query('RESET ROLE')
      await client.query('BEGIN')
      await client.query(`ALTER FUNCTION mbox.allow_closed_debt_manual_payment(jsonb,uuid) OWNER TO ${identifier(old)}`)
      await expect(client.query(unwrapNormalizedMigrationTransaction(migrations.find(m=>m.version==='242')!.sql))).rejects.toMatchObject({code:'55000'})
      await client.query('ROLLBACK')
      await apply(242,242)
      const after=(await client.query('SELECT pg_get_functiondef($1::regprocedure) definition,proowner::regrole::text owner,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
      expect(after.definition).toBe(before.definition);expect(after.proconfig).toEqual(before.proconfig);expect(after.prosecdef).toBe(true)
      expect(after.owner).toBe((await client.query("SELECT proowner::regrole::text owner FROM pg_proc WHERE oid='mbox.allow_closed_debt_manual_payment(jsonb,uuid)'::regprocedure")).rows[0].owner)
      expect(after.owner).not.toBe(old)
      expect((await client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[old])).rows[0].rolcanlogin).toBe(false)
      await admin.query(`CREATE ROLE ${identifier(runtime)} LOGIN PASSWORD '${password}'; GRANT mbox_runtime TO ${identifier(runtime)}`)
      for(const functionName of [signature,'mbox.allow_closed_debt_manual_payment(jsonb,uuid)','mbox.allow_closed_order_verified_payment_projection(jsonb,jsonb,uuid)','mbox.allow_closed_order_manual_debt_projection(jsonb,jsonb,uuid)']){
        expect((await client.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[runtime,functionName])).rows[0].allowed).toBe(false)
      }
      const actual=new URL(target);actual.username=runtime;actual.password=password
      // Reuse complete positive and negative command/API suites on the upgraded
      // cross-owner schema, including actual LOGIN identity assertions. No test
      // source, migration checksum or financial fact is patched for this run.
      const files=['closed-manual-debt-projection','closed-debt-recovery','closed-order-financial-projection',
        'batch-closed-debt-recovery','loyalty-recollection','recommendation-recollection','order-financial-recovery']
      const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files.map(name=>`server/normalized/${name}.integration.test.ts`),'--maxWorkers=1','--pool=forks','--reporter=dot'],{
        encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,
        env:{...process.env,TEST_NORMALIZED_ADMIN_URL:clusterUrl.toString(),TEST_NORMALIZED_DATABASE_URL:target.toString(),TEST_NORMALIZED_RUNTIME_DATABASE_URL:actual.toString()},
      })
      const output=(result.stdout+result.stderr).replaceAll(password,'[synthetic-password]')
      expect(result.status,output).toBe(0)
      const plain=stripVTControlCharacters(output)
      expect(plain).toMatch(/Test Files\s+7 passed \(7\)/)
      const totals=plain.match(/Tests\s+(\d+) passed \((\d+)\)/)
      expect(totals).not.toBeNull()
      expect(Number(totals![1])).toBeGreaterThan(0)
      expect(totals![1]).toBe(totals![2])
      console.info('Cross-owner actual LOGIN suites:\n'+plain.split('\n').filter(line=>/^\s*(Test Files|Tests|Duration)/.test(line)).join('\n'))
    }finally{
      await client?.end()
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`)
      await admin.query(`DROP ROLE IF EXISTS ${identifier(runtime)}`)
      await admin.query(`DROP ROLE IF EXISTS ${identifier(old)}`)
      await admin.end()
    }
  },180000)
})
