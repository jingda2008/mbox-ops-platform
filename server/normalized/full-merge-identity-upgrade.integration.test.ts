import {randomUUID} from 'node:crypto'
import {Client} from 'pg'
import {describe,expect,it} from 'vitest'
import {loadNormalizedMigrations,NORMALIZED_SCHEMA_FLAVOR,runNormalizedMigrations,
  unwrapNormalizedMigrationTransaction} from '../migrate-normalized.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip

integration('full merge identity count upgrade',()=>{
  it('upgrades a populated 297 database without rewriting facts, then transfers and replays once',async()=>{
    const adminUrl=new URL(databaseUrl!)
    if(!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw new Error('Local test database required')
    const name=`mbox_upgrade298_${randomUUID().replaceAll('-','')}`
    const targetUrl=new URL(adminUrl);targetUrl.pathname=`/${name}`
    const restrictedUrl=new URL(runtimeUrl!);restrictedUrl.pathname=`/${name}`
    adminUrl.pathname='/postgres'
    const admin=new Client({connectionString:adminUrl.toString()})
    const client=new Client({connectionString:targetUrl.toString()})
    const runtime=new Client({connectionString:restrictedUrl.toString()})
    await admin.connect()
    let created=false
    try{
      await admin.query(`CREATE DATABASE "${name}"`);created=true
      await client.connect()
      await client.query(`CREATE SCHEMA mbox;
        CREATE TABLE mbox.normalized_schema_metadata(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
          schema_flavor text NOT NULL,schema_version text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE mbox.normalized_schema_migrations(version text PRIMARY KEY,filename text NOT NULL UNIQUE,
          checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
      await client.query(`INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version)
        VALUES(true,$1,'000')`,[NORMALIZED_SCHEMA_FLAVOR])
      for(const migration of (await loadNormalizedMigrations()).filter(row=>row.version<='297')){
        await client.query('BEGIN')
        try{
          await client.query(unwrapNormalizedMigrationTransaction(migration.sql))
          await client.query(`INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum) VALUES($1,$2,$3)`,
            [migration.version,migration.filename,migration.checksum])
          await client.query('COMMIT')
        }catch(error){await client.query('ROLLBACK');throw error}
      }
      const tenant=randomUUID(),store=randomUUID(),area=randomUUID(),employee=randomUUID(),role=randomUUID()
      const sourceTable=randomUUID(),targetTable=randomUUID(),session=randomUUID(),stagingTable=randomUUID(),targetSession=randomUUID()
      await client.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,'upgrade298','Upgrade')",[tenant])
      await client.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'upgrade298','Upgrade')",[store,tenant])
      await client.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'MAIN','Main','indoor')",[area,tenant,store])
      await client.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
        VALUES($1,$3,$4,$5,'SRC','Source',4),($2,$3,$4,$5,'DST','Target',4)`,[sourceTable,targetTable,tenant,store,area])
      await client.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'STAGE','Stage',4)",[stagingTable,tenant,store,area])
      await client.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'manager','Manager')",[employee,tenant,store])
      await client.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'STORE_MANAGER','Manager')",[role,tenant,store])
      await client.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenant,store,employee,role])
      await client.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
        VALUES($1,$2,'table.transfer','Transfer'),($1,$2,'table.participation.manage','Merge') ON CONFLICT DO NOTHING`,[tenant,store])
      await client.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
        SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
        WHERE tenant_id=$1 AND store_id=$2 AND code IN ('table.transfer','table.participation.manage') ON CONFLICT DO NOTHING`,[tenant,store,role])
      await client.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,
        guest_count,status,opened_by_employee_id,primary_service_employee_id)
        VALUES($1,$2,$3,$4,'upgrade-session','2026-11-01',2,'open',$5,$5)`,[session,tenant,store,sourceTable,employee])
      await client.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,
        guest_count,status,opened_by_employee_id,primary_service_employee_id)
        VALUES($1,$2,$3,$4,'target-session','2026-11-02',1,'open',$5,$5)`,[targetSession,tenant,store,targetTable,employee])
      for(let i=0;i<3;i++){
        const customer=randomUUID()
        await client.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customer,tenant,store,`upgrade-customer-${i}`])
        await client.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship)
          VALUES($1,$2,$3,$4,'guest')`,[tenant,store,session,customer])
      }
      await client.query(`INSERT INTO mbox.orders(tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor)
        VALUES($1,$2,$3,'upgrade-paid-order','guest_qr','submitted','paid',100,0,100)`,[tenant,store,session])
      await runtime.connect()
      // Keep one real pre-298 whole-transfer event with more accounts than people.
      await runtime.query('BEGIN')
      await runtime.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[tenant,store])
      const historical=(await runtime.query(`SELECT * FROM mbox.execute_table_customer_movement(
        'whole_table_transfer',$1,NULL,$2,2,'{}','{}','{}',$3,'历史转台','historical-whole-key',repeat('b',64),NULL,NULL,'{}')`,
      [session,stagingTable,employee])).rows[0]
      await runtime.query('COMMIT')
      const participantIds=(await client.query<{id:string}>('SELECT id FROM mbox.table_session_customer_participations WHERE table_session_id=$1 AND left_at IS NULL ORDER BY id',[session])).rows.map(row=>row.id)
      const move=async()=>{
        await runtime.query('BEGIN')
        try{
          await runtime.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[tenant,store])
          const result=await runtime.query(`SELECT * FROM mbox.execute_table_customer_movement(
            'participant_merge',$1,$4,$2,2,$5::uuid[],ARRAY['companion','companion','companion'],ARRAY['confirmed','confirmed','confirmed'],$3,'升级并桌验证','upgrade298-key',repeat('a',64),NULL,NULL,'{}')`,
          [session,targetTable,employee,targetSession,participantIds])
          await runtime.query('COMMIT');return result.rows[0]
        }catch(error){await runtime.query('ROLLBACK');throw error}
      }
      const snapshot=async()=>{
        const result:Record<string,unknown>={}
        for(const table of ['table_sessions','table_session_customer_participations','orders','table_customer_movement_events']){
          result[table]=(await client.query(`SELECT (to_jsonb(row)-ARRAY['transfer_minimum_minor','transfer_waiver_baseline_minor','credit_collection_enabled','effective_minimum_spend_minor'])-'source_guest_count_before' fact FROM mbox.${table} row ORDER BY id`)).rows
        }
        return result
      }
      const before=await snapshot()
      await expect(move()).rejects.toMatchObject({code:'40001'})
      expect(await snapshot()).toEqual(before)
      await runNormalizedMigrations(targetUrl.toString())
      expect(await snapshot()).toEqual(before)
      expect((await client.query('SELECT bool_and(transfer_minimum_minor IS NULL AND transfer_waiver_baseline_minor=0 AND credit_collection_enabled=false AND effective_minimum_spend_minor=GREATEST(0,minimum_spend_minor-minimum_spend_waiver_minor)) valid FROM mbox.table_sessions')).rows[0].valid).toBe(true)
      const first=await move()
      expect(first).toMatchObject({moved_participant_count:3,replayed:false,target_guest_count_after:3})
      expect((await client.query('SELECT source_guest_count_before FROM mbox.table_customer_movement_events WHERE id=$1',[historical.movement_event_id])).rows[0].source_guest_count_before).toBeNull()
      expect((await client.query('SELECT source_guest_count_before FROM mbox.table_customer_movement_events WHERE id=$1',[first.movement_event_id])).rows[0].source_guest_count_before).toBe(2)
      // A missing snapshot must not turn SQL CHECK's NULL into an exemption;
      // a partial movement (2 of 3 people) must still reject 3 identities.
      for(const sourceCount of [null,3]){
        await expect(client.query(`INSERT INTO mbox.table_customer_movement_events
          SELECT (jsonb_populate_record(NULL::mbox.table_customer_movement_events,to_jsonb(e)||
            jsonb_build_object('id',gen_random_uuid(),'public_id',gen_random_uuid()::text,
              'idempotency_key',gen_random_uuid()::text,'source_guest_count_before',$2::integer))).*
          FROM mbox.table_customer_movement_events e WHERE id=$1`,[first.movement_event_id,sourceCount]))
          .rejects.toMatchObject({code:'23514',constraint:'table_customer_movement_events_participant_count_check'})
      }
      const after=await snapshot()
      await runNormalizedMigrations(targetUrl.toString())
      expect(await snapshot()).toEqual(after)
      expect(await move()).toMatchObject({movement_event_id:first.movement_event_id,replayed:true})
      expect(await snapshot()).toEqual(after)
      expect((after.orders as unknown[])).toEqual(before.orders)
    }finally{
      await runtime.end().catch(()=>undefined);await client.end().catch(()=>undefined)
      if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      await admin.end()
    }
  },30_000)
})
