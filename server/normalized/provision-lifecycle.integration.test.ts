import {randomUUID} from 'node:crypto'
import {Client,Pool} from 'pg'
import {describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {parseStoreProvisionConfig} from '../provision-normalized-store.js'
import {parseNormalizedCatalog} from '../provision-normalized-catalog.js'
import {provisionNormalizedRelease} from '../provision-normalized-release.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??databaseUrl
const integration=databaseUrl?describe:describe.skip
const cases=[
  ['areas','paused','A'],['areas','retired','A'],
  ['tables','paused','T1'],['tables','retired','T1'],
  ['roles','inactive','SERVER'],['staff_permission_definitions','inactive','table.open'],
] as const
integration('new configuration versions preserve independent lifecycle decisions',()=>{
  it.each(cases)('does not reactivate %s in %s state',async(table,status,code)=>{
    await runNormalizedMigrations(databaseUrl!)
    const tenantId=randomUUID(),storeId=randomUUID(),scope={tenantId,storeId}
    const store=parseStoreProvisionConfig({version:'lifecycle-v1',tenant:{id:tenantId,code:tenantId,name:'Lifecycle test'},store:{id:storeId,code:storeId,name:'Test store'},
      areas:[{code:'A',name:'Area A',type:'indoor'}],tables:[{code:'T1',name:'Table 1',areaCode:'A',capacity:4}],
      roles:[{code:'SERVER',name:'Server',permissions:['table.open'],navigation:[{code:'live',label:'Live',route:'/staff/live'}]}],
      employees:[{code:'staff',name:'Staff',pinEnv:'MBOX_EMPLOYEE_PIN_TEST',roleCodes:['SERVER']}],
      reservationPolicy:{holdMinutes:20,arrivalGraceMinutes:10,maxAdvanceDays:90,defaultDurationMinutes:240,customerCancelCutoffMinutes:120,depositMode:'disabled'},
    })
    const catalog=parseNormalizedCatalog({version:'lifecycle-menu-v1',source:'isolated regression',products:[{sku:'TEST-DRINK',name:'Test drink',categoryId:'drinks',stationId:'bar-main',productKind:'single',enabled:true,soldOut:false,guestVisible:true,listPriceAmount:100,costAmount:10,bundleComponents:[]}]})
    const input={databaseUrl:databaseUrl!,storeConfig:store,catalogConfig:catalog,environment:{MBOX_EMPLOYEE_PIN_TEST:'5210'},sourceCommitSha:'a'.repeat(40)}
    const initial=await provisionNormalizedRelease(input)
    const client=new Client({connectionString:databaseUrl}),pool=new Pool({connectionString:runtimeUrl,max:1})
    await client.connect()
    const transactions=new ScopedPostgresTransactionRunner(pool)
    const permission=()=>transactions.run(scope,tx=>new StaffAccessRepository(tx).assertPermission(initial.store.employeeIds.staff!,'table.open'),{readOnly:true})
    const lifecycle=async()=>(await client.query(`SELECT status FROM mbox.${table} WHERE tenant_id=$1 AND code=$2`,[tenantId,code])).rows.map(row=>row.status)
    const protectedFacts=async()=>{
      const result:Record<string,unknown>={}
      for(const name of ['employees','employee_roles','store_daily_credentials','orders','table_sessions','table_qr_credentials'])result[name]=(await client.query(`SELECT to_jsonb(t) row FROM mbox.${name} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[tenantId])).rows
      return result
    }
    try{
      await permission()
      await client.query(`UPDATE mbox.${table} SET status=$2 WHERE tenant_id=$1 AND code=$3`,[tenantId,status,code])
      if(table==='roles'||table==='staff_permission_definitions')await expect(permission()).rejects.toBeInstanceOf(StaffAccessDeniedError)
      const before=await protectedFacts()
      const next=structuredClone(store);next.version='lifecycle-v2';next.store.name='Explicit store update'
      // Unrelated new resources must still be initialized with their safe defaults.
      next.areas.push({...next.areas[0]!,code:'B',name:'New area'})
      next.tables.push({...next.tables[0]!,code:'T2',name:'New table',areaCode:'B'})
      next.roles.push({...next.roles[0]!,code:'NEW_ROLE',name:'New role',permissions:['lifecycle.test']})
      await provisionNormalizedRelease({...input,storeConfig:next,sourceCommitSha:'b'.repeat(40)})
      if(table==='roles'||table==='staff_permission_definitions')await expect(permission()).rejects.toBeInstanceOf(StaffAccessDeniedError)
      expect(await lifecycle()).toContain(status)
      expect((await lifecycle()).filter(x=>x===status)).toHaveLength(1)
      expect(await protectedFacts()).toEqual(before)
      const defaults=(await client.query(`SELECT
        (SELECT status FROM mbox.areas WHERE tenant_id=$1 AND code='B') area,
        (SELECT status FROM mbox.tables WHERE tenant_id=$1 AND code='T2') "table",
        (SELECT status FROM mbox.roles WHERE tenant_id=$1 AND code='NEW_ROLE') role,
        (SELECT status FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND code='lifecycle.test') permission,
        (SELECT name FROM mbox.stores WHERE id=$2) name`,[tenantId,storeId])).rows[0]
      expect(defaults).toEqual({area:'active',table:'available',role:'active',permission:'active',name:'Explicit store update'})
      const finalStatuses=await lifecycle()
      await Promise.all([provisionNormalizedRelease({...input,storeConfig:next,sourceCommitSha:'c'.repeat(40)}),provisionNormalizedRelease({...input,storeConfig:next,sourceCommitSha:'c'.repeat(40)})])
      expect(await lifecycle()).toEqual(finalStatuses)
      expect(await protectedFacts()).toEqual(before)
    }finally{await client.end();await pool.end()}
  },60000)
})
