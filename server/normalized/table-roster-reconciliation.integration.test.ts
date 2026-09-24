import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {reconcileTableRoster} from '../../scripts/reconcile-table-roster.mjs'
import {GuestSessionRepository} from './guest-session-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=url?describe:describe.skip
integration('table roster preserves occupied table and QR identity',()=>{
 let pool:Pool
 beforeAll(async()=>{await runNormalizedMigrations(url!);pool=new Pool({connectionString:url})})
 afterAll(async()=>{await pool?.end()})
 it('renames in place, retains occupied omitted tables, retires only empty tables and replays without changes',async()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),table=randomUUID(),occupied=randomUUID(),empty=randomUUID(),visit=randomUUID(),oldVisit=randomUUID(),qr=randomUUID(),hash='a'.repeat(64)
  const c=await pool.connect()
  try{
   await c.query('BEGIN')
   await c.query("INSERT INTO mbox.tenants(id,code,name)VALUES($1::uuid,$1::text,'Roster test')",[scope.tenantId])
   await c.query("INSERT INTO mbox.stores(id,tenant_id,code,name)VALUES($1::uuid,$2,$1::text,'Roster test')",[scope.storeId,scope.tenantId])
   await c.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)VALUES($1,$2,$3,'main','Main','indoor')",[area,scope.tenantId,scope.storeId])
   await c.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)VALUES($1,$4,$5,$6,'W01','W01',8),($2,$4,$5,$6,'L01','L01',4),($3,$4,$5,$6,'A04','A04',4)",[table,occupied,empty,scope.tenantId,scope.storeId,area])
   await c.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)VALUES($1::uuid,$3,$4,$5,$1::text,current_date,2,'open'),($2::uuid,$3,$4,$6,$2::text,current_date,2,'open')",[visit,oldVisit,scope.tenantId,scope.storeId,table,occupied])
   await c.query("INSERT INTO mbox.table_qr_credentials(id,tenant_id,store_id,table_id,qr_version,credential_hash)VALUES($1,$2,$3,$4,1,$5)",[qr,scope.tenantId,scope.storeId,table,hash])
   await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[scope.tenantId,scope.storeId])
   await c.query('SET LOCAL ROLE mbox_runtime')
   const roster=[{code:'W1',areaCode:'main',capacity:4},{code:'D1',areaCode:'main',capacity:4}]
   const result=await reconcileTableRoster(c,scope,roster)
   expect(result.desired.find(t=>t.code==='W1')).toMatchObject({id:table,capacity:8,status:'available'})
   expect(result.deferred).toEqual([{code:'L01',visits:1,reservations:0}])
   expect((await c.query('SELECT status FROM mbox.tables WHERE id=$1',[empty])).rows[0].status).toBe('retired')
   expect((await c.query('SELECT table_id,status FROM mbox.table_sessions WHERE id=$1',[visit])).rows[0]).toEqual({table_id:table,status:'open'})
   const credential=await new GuestSessionRepository({scope,query:(sql,params)=>c.query(sql,[...(params??[])])}).findActiveTableCredential(hash)
   expect(credential).toMatchObject({tableId:table,tableCode:'W1'})
   expect((await c.query('SELECT id,table_id,status,credential_hash FROM mbox.table_qr_credentials WHERE id=$1',[qr])).rows[0]).toEqual({id:qr,table_id:table,status:'active',credential_hash:hash})
   expect((await reconcileTableRoster(c,scope,roster)).changes).toHaveLength(0)
   expect((await c.query("SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1 AND action LIKE 'table.roster.%'",[scope.tenantId])).rows[0].n).toBe(3)
  }finally{await c.query('ROLLBACK');c.release()}
 })
})
