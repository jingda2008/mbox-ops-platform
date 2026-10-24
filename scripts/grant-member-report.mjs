// Run from the application root after deploying the report build. Default is a read-only preview.
import pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const load=name=>import(pathToFileURL(resolve(`dist-normalized/server/normalized/${name}.js`)).href)
const {ScopedPostgresTransactionRunner}=await load('transaction-runner')
const {StaffAccessRepository}=await load('staff-access-repository')
const {NormalizedCommandExecutor}=await load('command-executor')
const {lockStaffAccessConfiguration}=await load('staff-access-version')
await load('member-report-api') // Refuse to grant a feature absent from the deployed build.
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,options:'-c statement_timeout=15000 -c lock_timeout=3000'})
const runner=new ScopedPostgresTransactionRunner(pool),scope={tenantId:process.env.MBOX_TENANT_ID,storeId:process.env.MBOX_STORE_ID}
const permission='member.report.view',employeeCode='chenfangyu',expectedId='9663840e-377c-4a7d-be6e-d5f71873837e'
const reason='用户授权陈方宇查看会员数量、入会时间、手机号、消费明细及兴趣卡分类，只增加会员报表查询权限'
try{
 const before=await runner.run(scope,async tx=>{
  const e=(await tx.query("SELECT id,display_name,status FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code=$3",[scope.tenantId,scope.storeId,employeeCode])).rows
  if(e.length!==1||e[0].id!==expectedId||e[0].display_name!=='陈方宇'||e[0].status!=='active')throw Error('Target employee identity mismatch')
  const access=await new StaffAccessRepository(tx).resolve(expectedId)
  return {employeeId:expectedId,employeeCode,permissions:access.permissions,navigation:access.navigation,businessDate:(await tx.query('SELECT mbox.current_operating_business_date($1,$2)::text day',[scope.tenantId,scope.storeId])).rows[0].day}
 },{readOnly:true})
 if(process.env.MBOX_APPLY_MEMBER_REPORT!=='true'){console.log(JSON.stringify({mode:'preview',employeeCode,permission,alreadyGranted:before.permissions.includes(permission)}))}
 else {
  const result=await new NormalizedCommandExecutor(runner).execute({scope,operationScope:'support.member-report.grant',idempotencyKey:'chenfangyu-member-report-20261024-v1',requestFingerprint:JSON.stringify({employeeCode,permission}),retainReceipt:true,resultCodec:{encode:x=>x,decode:x=>x}},async tx=>{
   await lockStaffAccessConfiguration(tx)
   const access=new StaffAccessRepository(tx)
   await access.assertPermission(expectedId,'staff.access.configure')
   const current=await access.resolve(expectedId)
   await access.upsertPermissionDefinition({code:permission,name:'会员查询报表（含手机号与消费明细）',category:'customer',description:'只读查看本门店会员报表，不包含会员修改、营销发送、发卡、收款或退款'})
   await access.setEmployeePermissionOverride({employeeId:expectedId,permissionCode:permission,effect:'grant',reason,configuredByEmployeeId:expectedId})
   const spill=(await tx.query("SELECT (SELECT count(*) FROM mbox.role_permission_assignments r JOIN mbox.staff_permission_definitions d ON d.id=r.permission_id WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.code=$3)+(SELECT count(*) FROM mbox.employee_permission_overrides o JOIN mbox.staff_permission_definitions d ON d.id=o.permission_id WHERE d.tenant_id=$1 AND d.store_id=$2 AND d.code=$3 AND o.employee_id<>$4 AND o.effect='grant') AS count",[scope.tenantId,scope.storeId,permission,expectedId])).rows[0]
   if(Number(spill.count)!==0)throw Error('Report permission extends beyond the requested account')
   const after=await access.resolve(expectedId)
   if(JSON.stringify(after.permissions.filter(p=>p!==permission).sort())!==JSON.stringify(current.permissions.filter(p=>p!==permission).sort()))throw Error('Unexpected permission change')
   if(!after.navigation.some(n=>n.route==='/staff/member-report'))throw Error('Report navigation missing')
   return {result:{employeeCode,permission,navigation:'/staff/member-report',otherPermissionsUnchanged:true},auditEvents:[{actor:{type:'support',ref:'user-authorized:member-report-20261024'},action:'support.member-report.granted',objectType:'employee',objectId:expectedId,businessDate:before.businessDate,reason,afterData:{permission,employeeCode}}],outboxMessages:[]}
  })
  const verified=await runner.run(scope,tx=>new StaffAccessRepository(tx).resolve(expectedId),{readOnly:true})
  if(!verified.permissions.includes(permission))throw Error('Readback permission missing')
  console.log(JSON.stringify({mode:'applied',...result.value,checkedAt:new Date().toISOString()}))
 }
}finally{await pool.end()}
