import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=adminUrl&&runtimeUrl?describe:describe.skip

integration('staff authorization uses database time and precision',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),roleId=randomUUID()
  let permissionId:string
  const scope={tenantId,storeId}
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(adminUrl!)
    admin=new Pool({connectionString:adminUrl});runtime=new Pool({connectionString:runtimeUrl})
    runner=new ScopedPostgresTransactionRunner(runtime)
    const identity=(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(identity).toEqual({rolsuper:false,rolbypassrls:false})
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Clock audit')",[tenantId,tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'clock','Clock')",[storeId,tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'clock','Clock employee')",[employeeId,tenantId,storeId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'CLOCK_TEST','Clock role')",[roleId,tenantId,storeId])
    permissionId=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'kds.exception.manage','Handoff') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active' RETURNING id",[tenantId,storeId])).rows[0].id
    await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,roleId,permissionId])
    await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,employeeId,roleId])
    await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor) VALUES($1,$2,$3,'order.gift',100)",[tenantId,storeId,roleId])
  })
  beforeEach(async()=>{
    await admin.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])
    await admin.query("UPDATE mbox.employee_roles SET starts_at=clock_timestamp()-interval '1 hour',ends_at=clock_timestamp()+interval '1 hour' WHERE tenant_id=$1 AND store_id=$2",[tenantId,storeId])
  })
  afterEach(()=>vi.useRealTimers())
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  const resolve=(at?:string)=>runner.run(scope,tx=>new StaffAccessRepository(tx).resolve(employeeId,at))
  const authority=(at?:string)=>runner.run(scope,tx=>new StaffAccessRepository(tx).resolveApprovalAuthority(employeeId,'order.gift',at))
  async function deny(start='clock_timestamp()',end="clock_timestamp()+interval '30 minutes'"){
    return (await admin.query(`INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id,starts_at,ends_at)
      VALUES($1,$2,$3,$4,'deny','Clock regression',$3,${start},${end}) RETURNING starts_at::text`,[tenantId,storeId,employeeId,permissionId])).rows[0].starts_at as string
  }
  async function skew(hours:number){
    const now=(await admin.query("SELECT extract(epoch FROM clock_timestamp())*1000 AS ms")).rows[0].ms
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Number(now)+hours*3600000)
  }
  it('rejects a just-committed deny even when the application clock is behind',async()=>{
    await deny();await skew(-1)
    expect((await resolve()).permissions).not.toContain('kds.exception.manage')
  })
  it('does not expire a current deny when the application clock is ahead',async()=>{
    await deny();await skew(1)
    expect((await resolve()).deniedPermissions).toContain('kds.exception.manage')
  })
  it('does not activate a future deny using the application clock',async()=>{
    await deny("clock_timestamp()+interval '15 minutes'");await skew(0.5)
    expect((await resolve()).permissions).toContain('kds.exception.manage')
  })
  it('does not retain an expired deny using the application clock',async()=>{
    await deny("clock_timestamp()-interval '30 minutes'","clock_timestamp()-interval '15 minutes'");await skew(-0.5)
    expect((await resolve()).permissions).toContain('kds.exception.manage')
  })
  it.each(['future','expired'] as const)('rejects %s role authority even with application clock skew',async kind=>{
    await admin.query(`UPDATE mbox.employee_roles SET starts_at=clock_timestamp()+interval '${kind==='future'?'15':'-30'} minutes',ends_at=clock_timestamp()+interval '${kind==='future'?'30':'-15'} minutes' WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId])
    await skew(kind==='future'?0.3:-0.3)
    expect((await resolve()).permissions).not.toContain('kds.exception.manage')
    expect(await authority()).toBeNull()
  })
  it('keeps explicit historical microsecond boundaries and approval authority queries',async()=>{
    await admin.query("UPDATE mbox.employee_roles SET starts_at='2026-01-01',ends_at='2027-01-01' WHERE tenant_id=$1 AND store_id=$2",[tenantId,storeId])
    await deny("'2026-06-01T12:00:00.123456Z'","'2026-06-01T12:00:00.123457Z'")
    expect((await resolve('2026-06-01T12:00:00.123455Z')).permissions).toContain('kds.exception.manage')
    expect((await resolve('2026-06-01T12:00:00.123456Z')).deniedPermissions).toContain('kds.exception.manage')
    expect((await resolve('2026-06-01T12:00:00.123457Z')).permissions).toContain('kds.exception.manage')
    expect(await authority('2026-06-01T12:00:00.123456Z')).toMatchObject({amountMinor:100})
    expect(await authority('2027-01-01T00:00:00Z')).toBeNull()
  })
  it('preserves database microseconds and consistently applies immediate revocations',async()=>{
    for(let n=0;n<50;n++){
      const starts=await deny()
      const access=await resolve()
      expect(access.deniedPermissions).toContain('kds.exception.manage')
      expect(access.resolvedAt).toMatch(/\.\d{6}Z$/)
      expect((await admin.query('SELECT $1::timestamptz >= $2::timestamptz AS valid',[access.resolvedAt,starts])).rows[0].valid).toBe(true)
      await admin.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])
    }
  })
})
