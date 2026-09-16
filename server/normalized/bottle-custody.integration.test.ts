import sharp from 'sharp'
import {custodyReport} from './custody-report.js'
import {SocialCustodyWorker} from './social-custody-worker.js'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {BottleCustodyRepository,custodyCreateSchema} from './bottle-custody-repository.js'
import {defaultCustodyPolicy} from './bottle-custody-policy.js'
import {allocateMemberNumber} from './member-number-policy.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('v9 member custody with real PostgreSQL transactions',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),customer=randomUUID(),category=randomUUID()
 const protector=createActivityContactProtectionKeyring(null,'v9-test-only-local-secret-not-production')
 let photoBase64:string
 const evidence=()=>({photoBase64,phone:'+8613800012345',fraction:null})
 const input=(value:Record<string,unknown>)=>custodyCreateSchema.parse({...value,evidence:value.evidence??evidence()})
 let pool:Pool,runner:ScopedPostgresTransactionRunner
 const run=<T>(fn:(repo:BottleCustodyRepository)=>Promise<T>)=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return fn(new BottleCustodyRepository(tx,protector))})
 beforeAll(async()=>{
  photoBase64=(await sharp({create:{width:320,height:240,channels:3,background:'#826341'}}).jpeg().toBuffer()).toString('base64')
  await runNormalizedMigrations(databaseUrl!)
  pool=new Pool({connectionString:databaseUrl,max:12});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'v9')",[scope.tenantId,`v9-${scope.tenantId}`])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'v9')",[scope.storeId,scope.tenantId,`v9-${scope.storeId}`])
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'BAR','bar')",[employee,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)",[customer,scope.tenantId,scope.storeId,`CUST-${customer}`])
  await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'100001')",[scope.tenantId,scope.storeId,customer])
  await run(repo=>repo.savePolicy({...defaultCustodyPolicy,enabled:true},0))
  await run(repo=>repo.saveCategory({id:category,code:'BRANDY',name:'白兰地',defaultDays:20,active:true,sortOrder:0}))
 },30000)
 afterAll(async()=>pool?.end())
 const create=()=>run(repo=>repo.create(input({memberNo:'100001',categoryId:category,itemName:'测试寄存酒',unit:'瓶',quantity:'2'}),employee))
 async function delivered(orderId:string,quantity='2'){
  const result=await run(repo=>repo.requestCode(orderId,quantity,employee))
  const row=(await pool.query('UPDATE mbox.bottle_custody_challenges SET delivery_status=\'accepted\' WHERE id=$1 RETURNING encrypted_code,code_hash,key_id',[result.challengeId])).rows[0]
  const plaintext=protector.reveal({encryptedContact:row.encrypted_code,contactHash:row.code_hash,encryptionKeyId:row.key_id})
  return{challengeId:result.challengeId,code:plaintext.split(':')[1]!}
 }
 it('allocates unique member numbers under concurrency and skips an existing short number',async()=>{
  const numbers=await Promise.all(Array.from({length:12},()=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return allocateMemberNumber(tx)})))
  expect(new Set(numbers).size).toBe(12);expect(numbers).not.toContain('100001');expect(numbers).toContain('100002')
 })
 it('creates independent same-member same-second numbers without touching saleable stock',async()=>{
  const [a,b]=await Promise.all([create(),create()]);expect(a.order.public_id).not.toBe(b.order.public_id);expect(a.order.public_id).toMatch(/^[0-9]{8}-[0-9]{6}-100001-[0-9]+$/)
  expect(a.order.remaining_quantity).toBe('2.000000');expect(a.events[0]).toMatchObject({event_type:'stored',employee_id:employee})
 })
 it('does not expose OTP and rejects collection before delivery and verification',async()=>{
  const {order}=await create(),issued=await run(repo=>repo.requestCode(order.id,'2',employee))
  expect(JSON.stringify(issued)).not.toMatch(/encrypted_code|code_hash|"code":/)
  await expect(run(repo=>repo.collect(order.id,issued.challengeId,employee))).rejects.toThrow('验证码')
  await expect(run(repo=>repo.requestCode(order.id,'2',employee))).rejects.toMatchObject({statusCode:429})
 })
 it('persists incorrect attempts and locks out after maximum attempts',async()=>{
  const {order}=await create(),challenge=await delivered(order.id)
  const wrong=challenge.code==='0000'?'1111':'0000'
  for(let i=0;i<5;i++)expect(await run(repo=>repo.verify(order.id,challenge.challengeId,wrong,employee))).toMatchObject({verified:false})
  await expect(run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee))).rejects.toThrow('尝试次数')
  expect((await run(repo=>repo.detail(order.id))).events.filter(row=>row.event_type==='code_rejected')).toHaveLength(5)
 })
 it('consumes a verification once under concurrent collection and restores on the same original order',async()=>{
  const {order}=await create(),challenge=await delivered(order.id)
  expect(await run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee))).toMatchObject({verified:true})
  const results=await Promise.allSettled([run(repo=>repo.collect(order.id,challenge.challengeId,employee)),run(repo=>repo.collect(order.id,challenge.challengeId,employee))])
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  const collected=await run(repo=>repo.detail(order.id));expect(collected.order).toMatchObject({remaining_quantity:'0.000000',status:'collected'})
  const collectionId=collected.collections[0]!.id as string
  await expect(run(repo=>repo.resolveCollection(order.id,collectionId,'2',employee,'缺少本次照片','original'))).rejects.toThrow('重新拍照')
  const restored=await run(repo=>repo.resolveCollection(order.id,collectionId,'2',employee,'顾客再存','original',evidence()))
  expect(restored.deposits).toHaveLength(2)
  expect(restored.order).toMatchObject({id:order.id,public_id:order.public_id,remaining_quantity:'2.000000',original_quantity:'2.000000',status:'stored'})
  await expect(run(repo=>repo.resolveCollection(order.id,collectionId,'2',employee,'重复再存','original',evidence()))).rejects.toThrow('已处理')
 })
 it('archives no-restorage with immutable collection and verification evidence',async()=>{
  const {order}=await create(),challenge=await delivered(order.id)
  await run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee));const collected=await run(repo=>repo.collect(order.id,challenge.challengeId,employee))
  const archived=await run(repo=>repo.resolveCollection(order.id,collected.collections[0]!.id as string,null,employee,'顾客确认不再存'))
  expect(archived.order).toMatchObject({status:'archived',remaining_quantity:'0.000000'})
  expect(archived.events.map(event=>event.event_type)).toEqual(['stored','code_requested','code_verified','collected','collection_closed','archived'])
  await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.bottle_custody_events WHERE order_id=$1',[order.id]))).rejects.toThrow()
 })
 it('invalidates verified collection after expiry policy changes and rejects partial collection by default',async()=>{
  const {order}=await create();await expect(run(repo=>repo.requestCode(order.id,'1',employee))).rejects.toThrow('整单')
  const challenge=await delivered(order.id);await run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee))
  await run(repo=>repo.changeExpiry(order.id,new Date(Date.now()+40*86400000).toISOString(),employee,'调整存期'))
  await expect(run(repo=>repo.collect(order.id,challenge.challengeId,employee))).rejects.toThrow('状态未发生变化')
 })
 it('validates configurable fields and preserves historical field labels after configuration changes',async()=>{
  const view=await run(repo=>repo.policy()),fields=[{key:'seal_number',label:'封存编号',type:'text' as const,required:true}]
  await run(repo=>repo.savePolicy({...view.policy,extraFieldDefinitions:fields},view.version))
  await expect(create()).rejects.toThrow('封存编号')
  const record=await run(repo=>repo.create(input({memberNo:'100001',categoryId:category,itemName:'字段扩展测试',quantity:'1',unit:'瓶',extraFields:{seal_number:'SEALED-001'}}),employee))
  const changed=await run(repo=>repo.policy());await run(repo=>repo.savePolicy({...changed.policy,extraFieldDefinitions:[]},changed.version))
  const stored=await run(repo=>repo.detail(record.order.id));expect(stored.order.extra_fields).toEqual({seal_number:'SEALED-001'});expect(stored.order.extra_field_snapshot).toEqual(fields)
 })
 it('schedules reminders idempotently, cancels changed expiry snapshots and counts the whole filtered report',async()=>{
  const {order}=await create()
  // Local fixture directly enables scheduling without any real account/recipient.
  await pool.query("UPDATE mbox.bottle_custody_policies SET reminders_enabled=true WHERE tenant_id=$1 AND store_id=$2",[scope.tenantId,scope.storeId])
  await pool.query("UPDATE mbox.bottle_custody_orders SET stored_at=clock_timestamp(),expires_at=clock_timestamp()+interval '40 days' WHERE id=$1",[order.id])
  const worker=new SocialCustodyWorker(runner,protector);await worker.runBatch(scope);await worker.runBatch(scope)
  const rows=await pool.query('SELECT days_before,status FROM mbox.bottle_custody_reminders WHERE order_id=$1 ORDER BY days_before DESC',[order.id])
  expect(rows.rows.map(r=>r.days_before)).toEqual([30,15,7,3,2,1]);expect(rows.rows.every(r=>r.status==='pending')).toBe(true)
  await run(repo=>repo.changeExpiry(order.id,new Date(Date.now()+45*86400000).toISOString(),employee,'本地调整日期测试'));await worker.runBatch(scope)
  expect((await pool.query("SELECT count(*)::int AS n FROM mbox.bottle_custody_reminders WHERE order_id=$1 AND status='cancelled'",[order.id])).rows[0].n).toBe(6)
  const result=await run(repo=>repo.list({memberNo:'100001',categoryId:category}))
  expect(Number(result.summary.count)).toBeGreaterThan(0);expect(result.summary.categoryCounts[0]!.name).toBe('白兰地');expect(result.summary.amountStatus).toBe('declared_value_not_revenue')
 })
 it('creates one new restorage order and preserves original collection evidence without duplicating quantity',async()=>{
  const {order}=await create(),challenge=await delivered(order.id)
  await run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee));const taken=await run(repo=>repo.collect(order.id,challenge.challengeId,employee)),collection=String(taken.collections[0]!.id)
  const attempts=await Promise.allSettled([run(repo=>repo.resolveCollection(order.id,collection,'2',employee,'选择新建再存单','new',evidence())),run(repo=>repo.resolveCollection(order.id,collection,'2',employee,'并发重复再存','new',evidence()))])
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1)
  const result=await run(repo=>repo.detail(order.id)),nextId=String(result.collections[0]!.restored_order_id)
  expect(result.order.status).toBe('archived');expect(nextId).not.toBe(order.id)
  const next=await run(repo=>repo.detail(nextId));expect(next.order.remaining_quantity).toBe('2.000000');expect(next.events.some(e=>e.collection_id===collection)).toBe(true)
 })
 it('configures no-restorage and manual archive without skipping verification or discarding remaining stock',async()=>{
  const config=await run(repo=>repo.policy());await run(repo=>repo.savePolicy({...config.policy,remindersEnabled:false,allowRestorage:false,archiveMode:'manual'},config.version))
  const {order}=await create();await expect(run(repo=>repo.archive(order.id,employee,'仍有实物不能归档'))).rejects.toThrow('剩余存酒')
  const challenge=await delivered(order.id);await run(repo=>repo.verify(order.id,challenge.challengeId,challenge.code,employee));const taken=await run(repo=>repo.collect(order.id,challenge.challengeId,employee)),id=String(taken.collections[0]!.id)
  await expect(run(repo=>repo.resolveCollection(order.id,id,'2',employee,'关闭再存测试','new',evidence()))).rejects.toThrow('关闭再存')
  expect((await run(repo=>repo.resolveCollection(order.id,id,null,employee,'确认不再存'))).order.status).toBe('collected')
  expect((await run(repo=>repo.archive(order.id,employee,'人工确认归档'))).order.status).toBe('archived')
  const current=await run(repo=>repo.policy());await run(repo=>repo.savePolicy({...current.policy,allowRestorage:true,archiveMode:'automatic'},current.version))
 })
 it('reports selectable sales/custody/all without duplicating a sale linked to two custody orders',async()=>{
  const area=randomUUID(),table=randomUUID(),session=randomUUID(),sale=randomUUID()
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'RPT','报表','indoor')",[area,...Object.values(scope)])
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'RPT','RPT',2)",[table,scope.tenantId,scope.storeId,area])
  await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'RPT-SESSION',CURRENT_DATE,2,'open')",[session,scope.tenantId,scope.storeId,table])
  await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at,created_by_customer_id) VALUES($1,$2,$3,$4,'RPT-SALE','guest_qr','fulfilling','unpaid',12000,12000,clock_timestamp(),$5)",[sale,scope.tenantId,scope.storeId,session,customer])
  for(const amount of [5000,7000])await run(repo=>repo.create(input({memberNo:'100001',categoryId:category,itemName:'金额测试',unit:'瓶',quantity:'1',sourceOrderId:sale,declaredValueMinor:amount}),employee))
  const result=await runner.run(scope,tx=>custodyReport(tx,{scope:'all',memberNo:'100001',offset:0}))
  expect(result.summary.find(s=>s.type==='sales')).toMatchObject({count:'1',amount_minor:'12000'})
  expect(result.summary.find(s=>s.type==='custody')?.amount_minor).toBe('12000')
  const sales=await runner.run(scope,tx=>custodyReport(tx,{scope:'sales',offset:0}));expect(sales.items).toHaveLength(1)
  await expect(run(repo=>repo.exportReport({scope:'all'},employee))).rejects.toThrow()
 })
 it('enforces store isolation for runtime access',async()=>{
  const {order}=await create()
  const rows=await runner.run({tenantId:scope.tenantId,storeId:randomUUID()},async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return tx.query('SELECT id FROM mbox.bottle_custody_orders WHERE id=$1',[order.id])})
  expect(rows.rows).toEqual([])
 })
 it('requires a photo and phone, stores exact 2/5 with private immutable watermarked evidence',async()=>{
  expect(()=>custodyCreateSchema.parse({memberNo:'100001',categoryId:category,itemName:'missing',unit:'瓶',quantity:'0.4'})).toThrow()
  const base={memberNo:'100001',categoryId:category,itemName:'余量照片',unit:'瓶',quantity:'0.4'}
  await expect(run(repo=>repo.create(input({...base,evidence:{...evidence(),phone:null}}),employee))).rejects.toThrow('手机号')
  await expect(run(repo=>repo.create(input({...base,evidence:{...evidence(),fraction:'1/2'}}),employee))).rejects.toThrow('不一致')
  const result=await run(repo=>repo.create(input({...base,evidence:{...evidence(),fraction:'2/5'}}),employee))
  expect(result.order.remaining_quantity).toBe('0.400000')
  expect(result.deposits).toHaveLength(1)
  expect(result.deposits[0]).toMatchObject({fraction_label:'2/5',phone_masked:'138****2345',phone_source:'manual'})
  expect(JSON.stringify(result)).not.toMatch(/13800012345|encrypted_phone|photoBase64/)
  const depositId=result.deposits[0]!.id as string,bytes=await run(repo=>repo.photo(result.order.id,depositId))
  expect((await sharp(bytes).metadata()).height).toBe(332)
  await expect(run(repo=>repo.photo(randomUUID(),depositId))).rejects.toMatchObject({statusCode:404})
  await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.bottle_custody_deposits SET phone_masked=phone_masked WHERE id=$1',[depositId]))).rejects.toThrow()
  await expect(runner.run({...scope,storeId:randomUUID()},async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return new BottleCustodyRepository(tx,protector).photo(result.order.id,depositId)})).rejects.toMatchObject({statusCode:404})
 })
 it('automatically snapshots the active membership phone and rejects overriding it',async()=>{
  const person=randomUUID(),contact=randomUUID(),phone=protector.protectPhone('+8613900098765')
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)",[person,scope.tenantId,scope.storeId,`CUST-${person}`])
  await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-AUTOPHONE')",[scope.tenantId,scope.storeId,person])
  await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.customer_verified_contacts(id,tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,encrypted_value,encryption_key_version,contact_encryption_key_id,masked_value,verification_source,verified_by_customer_id,provider_reference_sha256,verified_at) VALUES($1,$2,$3,$4,$5,'phone',$6,$7,1,$8,$9,'wechat_phone_authorization',$10,repeat('a',64),clock_timestamp())`,[contact,scope.tenantId,scope.storeId,`CVC${contact.replaceAll('-','').toUpperCase()}`,person,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId,phone.maskedValue,person]))
  expect(await run(repo=>repo.memberContact('MBX-AUTOPHONE'))).toMatchObject({maskedPhone:phone.maskedValue,source:'membership'})
  const base={memberNo:'MBX-AUTOPHONE',categoryId:category,itemName:'自动手机号',unit:'瓶',quantity:'0.5'}
  await expect(run(repo=>repo.create(input(base),employee))).rejects.toThrow('会员已有手机号')
  const created=await run(repo=>repo.create(input({...base,evidence:{...evidence(),phone:null,fraction:'1/2'}}),employee))
  expect(created.deposits[0]).toMatchObject({phone_source:'membership',phone_masked:phone.maskedValue})
  expect((await pool.query('SELECT encrypted_phone FROM mbox.bottle_custody_deposits WHERE order_id=$1',[created.order.id])).rows[0].encrypted_phone).toEqual(phone.encryptedValue)
 })

})
