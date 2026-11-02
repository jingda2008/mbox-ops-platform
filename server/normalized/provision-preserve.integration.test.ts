import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Client} from 'pg'
import {describe, expect, it} from 'vitest'
import {ScryptCredentialHasher} from './staff-auth-command-service.js'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {parseStoreProvisionConfig} from '../provision-normalized-store.js'
import {parseNormalizedCatalog} from '../provision-normalized-catalog.js'
import {provisionNormalizedRelease} from '../provision-normalized-release.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('application release preserves live account and configuration facts',()=>{
  it.each(['same-version','new-version'] as const)('preserves changed PIN, disabled staff, revoked roles and credentials on %s',async mode=>{
    await runNormalizedMigrations(databaseUrl!)
    const id=randomUUID(), storeId=randomUUID()
    const store=parseStoreProvisionConfig({...JSON.parse(await readFile('deploy/normalized-store/mbox-lujiazui.store.json','utf8')),
      version:'preserve-v1',tenant:{id,code:id,name:'Test'},store:{id:storeId,code:storeId,name:'Test'},
      bootstrapAdminEmployeeCode:'test-admin',employees:[{code:'test-admin',name:'Original',pinEnv:'MBOX_EMPLOYEE_PIN_TEST',roleCodes:['ADMIN']}],
    })
    const catalog=parseNormalizedCatalog(JSON.parse(await readFile('config/menu-catalog-2026-07-27.json','utf8')))
    const environment={MBOX_EMPLOYEE_PIN_TEST:'5210',MBOX_STORE_DAILY_CREDENTIAL:'TEST-STORE'}
    const input={databaseUrl:databaseUrl!,storeConfig:store,catalogConfig:catalog,environment,sourceCommitSha:'1'.repeat(40)}
    const initial=await provisionNormalizedRelease(input)
    expect(initial.store).toMatchObject({replayed:false,employeeCount:1,dailyCredentialConfigured:true})
    const c=new Client({connectionString:databaseUrl});await c.connect()
    const snapshot=async(tables:string[])=>{
      const result:Record<string,unknown>={}
      for(const table of tables)result[table]=(await c.query(`SELECT to_jsonb(t) AS row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[id])).rows
      return result
    }
    try{
      await c.query("UPDATE mbox.employees SET pin_hash=$2,display_name='Live name',status='suspended' WHERE tenant_id=$1",[id,await new ScryptCredentialHasher().hash('7391')])
      await c.query('UPDATE mbox.employee_roles SET ends_at=clock_timestamp() WHERE tenant_id=$1',[id])
      await c.query('UPDATE mbox.store_daily_credentials SET revoked_at=clock_timestamp() WHERE tenant_id=$1',[id])
      const accounts=['employees','employee_roles','store_daily_credentials']
      const configuration=['tables','areas','stores','roles','role_permission_assignments','role_data_scopes','role_approval_limits','role_navigation_items','public_reservation_policies','store_automatic_table_turnover_policies','products']
      const before=await snapshot([...accounts,...configuration])
      const candidate=structuredClone(store)
      if(mode==='new-version'){candidate.version='preserve-v2';candidate.store.name='Explicit new store name';candidate.employees[0]!.name='Config renamed';candidate.employees[0]!.roleCodes=['OWNER']}
      await provisionNormalizedRelease({...input,storeConfig:candidate,sourceCommitSha:'2'.repeat(40)})
      const after=await snapshot([...accounts,...configuration])
      for(const table of accounts)expect(after[table],table).toEqual(before[table])
      if(mode==='same-version')for(const table of configuration)expect(after[table],table).toEqual(before[table])
      else expect((await c.query('SELECT name FROM mbox.stores WHERE id=$1',[storeId])).rows[0].name).toBe('Explicit new store name')
      const noSecrets=await provisionNormalizedRelease({...input,storeConfig:candidate,environment:{},sourceCommitSha:'2'.repeat(40)})
      expect(noSecrets.store.replayed).toBe(true)
      const repeated=await snapshot([...accounts,...configuration])
      await Promise.all([provisionNormalizedRelease({...input,storeConfig:candidate,sourceCommitSha:'3'.repeat(40)}),provisionNormalizedRelease({...input,storeConfig:candidate,sourceCommitSha:'3'.repeat(40)})])
      expect(await snapshot([...accounts,...configuration])).toEqual(repeated)
      expect((await c.query('SELECT count(*)::int n FROM mbox.store_configuration_applications WHERE tenant_id=$1 AND source_commit_sha=$2',[id,'3'.repeat(40)])).rows[0].n).toBe(1)
      const conflict=structuredClone(candidate);conflict.store.name='Invalid same-version edit'
      await expect(provisionNormalizedRelease({...input,storeConfig:conflict,sourceCommitSha:'4'.repeat(40)})).rejects.toThrow(/different content/)
      expect(await snapshot([...accounts,...configuration])).toEqual(repeated)
    }finally{await c.end()}
  },60000)
})
