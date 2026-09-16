import {readLaunchPopup} from './launch-popup-api.js'
import {PricingAuthorizationPolicy} from './pricing-authorization-policy.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {searchGuestCatalog} from './guest-commerce-service-api.js'
import Fastify from 'fastify'
import {NormalizedCommandExecutor} from './command-executor.js'
import {memberNumberApiPlugin} from './member-number-api.js'
import {socialAccountApiPlugin} from './social-account-api.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import {defaultMemberNumberPolicy} from './member-number-policy.js'
import {SocialBroadcastRepository,broadcastSchema,sendNextBroadcast} from './social-broadcast-repository.js'
import {randomUUID,createCipheriv,createHash} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {SocialAccountRepository} from './social-account-repository.js'
import {MemberCardRepository} from './member-card-repository.js'
import {OrderRepository} from './order-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL,integration=url?describe:describe.skip
integration('v9 authoritative social card and incremental menu',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),reviewer=randomUUID(),deniedEmployee=randomUUID(),customer=randomUUID(),other=randomUUID(),role=randomUUID(),product=randomUUID()
 const protection=createActivityContactProtectionKeyring(null,'v9-social-local-test-secret-only')
 let pool:Pool,runner:ScopedPostgresTransactionRunner,serviceId:string,wecomId:string
 const run=<T>(fn:(repo:SocialAccountRepository)=>Promise<T>)=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return fn(new SocialAccountRepository(tx,protection))})
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:4});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'social')",[scope.tenantId,`social-${scope.tenantId}`]);await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'social','social')",[scope.storeId,scope.tenantId])
  for(const id of [employee,reviewer,deniedEmployee])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,id])
  await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'SOCIAL','social')",[role,scope.tenantId,scope.storeId])
  for(const id of [employee,reviewer])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,id,role])
  await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN('member.card.manage','member.card.review','loyalty.policy.publish')",[scope.tenantId,scope.storeId,role])
  for(const [id,no] of [[customer,'200001'],[other,'200002']]){await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,scope.tenantId,scope.storeId,`social-${id}`]);await pool.query('INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,id,no])}
  const account=(kind:'service_account'|'wecom',appId:string)=>run(repo=>repo.save({kind,appId,name:kind,enabled:true,credentials:{secret:'test-only-social-secret',token:'SocialToken',encodingAesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/,'')},codeTemplateId:'test-code',codeDataKey:'character_string1',reminderTemplateId:'test-reminder',reminderDataKey:'thing1'},employee))
  serviceId=(await account('service_account','wxSocialTest01')).id;wecomId=(await account('wecom','wwSocialTest01')).id
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible,inventory_control_mode,cost_amount_minor) VALUES($1,$2,$3,'SOCIAL_ONLY','专属单品','DRINK','none',false,'not_managed',100)",[product,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',500,'CNY',clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,product])
 },30000)
 afterAll(async()=>pool?.end())
 async function relations(){
  for(const [accountId,externalId,staffId] of [[serviceId,'openid-social',''],[wecomId,'external-social','staff1']]){
   await run(repo=>repo.applyRelationship({accountId:accountId!,externalId:externalId!,staffId:staffId!,active:true,unionId:null,occurredAt:new Date(Date.now()-10000).toISOString()}))
   await pool.query('UPDATE mbox.social_relationships SET customer_id=$2 WHERE account_id=$1',[accountId,customer])
  }
 }
 async function project(autoRestore:boolean){
  return runner.run(scope,async tx=>{
   const repo=new MemberCardRepository(tx),businessDate='2026-09-16',p=await repo.createProject({code:`SOCIAL_${randomUUID().slice(0,8).toUpperCase()}`,name:'歌迷卡',terms:'企微及服务号双条件',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:employee,businessDate})
   await tx.query('UPDATE mbox.member_card_projects SET require_social_conditions=true,service_account_id=$2,wecom_account_id=$3,auto_restore=$4 WHERE id=$1',[p.projectId,serviceId,wecomId,autoRestore])
   await repo.setProjectState({projectId:p.projectId,state:'open',employeeId:reviewer,businessDate,reason:'核验双条件项目'})
   return p.projectId
  })
 }
 it('cannot open a new v9 card draft without configuring both account gates',async()=>{
  const id=await runner.run(scope,async tx=>{const repo=new MemberCardRepository(tx);return(await repo.createProject({requireSocialConfiguration:true,code:`GATE_${randomUUID().slice(0,8).toUpperCase()}`,name:'新歌迷卡',terms:'双条件要求',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:employee,businessDate:'2026-09-16'})).projectId})
  await expect(runner.run(scope,tx=>new MemberCardRepository(tx).setProjectState({projectId:id,state:'open',employeeId:reviewer,businessDate:'2026-09-16',reason:'本地未配置门槛测试'}))).rejects.toThrow('双条件门槛')
 })
 it('rejects issuing a card when either relationship is missing',async()=>{
  const id=await project(false)
  await expect(runner.run(scope,tx=>new MemberCardRepository(tx).apply({projectId:id,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-09-16'}))).rejects.toThrow('企业微信添加与服务号关注')
 })
 it('allows the holder only, revokes on unsubscribe and ignores an older subscribe',async()=>{
  await relations();const id=await project(false)
  await runner.run(scope,async tx=>{const repo=new MemberCardRepository(tx),a=await repo.apply({projectId:id,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-09-16'});await repo.review({applicationId:a.applicationId,decision:'approve',employeeId:reviewer,businessDate:'2026-09-16',reason:'平台关系齐备'});await tx.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive) VALUES($1,$2,$3,$4,true)',[scope.tenantId,scope.storeId,id,product])})
  expect((await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:product,quantity:1}],'guest_qr'))).subtotalAmountMinor).toBe(500)
  await expect(runner.run(scope,tx=>new OrderRepository(tx,other).quoteCurrent([{productId:product,quantity:1}],'guest_qr'))).rejects.toThrow()
  const now=new Date().toISOString();await run(repo=>repo.applyRelationship({accountId:serviceId,externalId:'openid-social',staffId:'',active:false,unionId:null,occurredAt:now}))
  expect((await pool.query('SELECT status FROM mbox.member_cards WHERE project_id=$1',[id])).rows[0].status).toBe('revoked')
  await run(repo=>repo.applyRelationship({accountId:serviceId,externalId:'openid-social',staffId:'',active:true,unionId:null,occurredAt:new Date(Date.now()-60000).toISOString()}))
  await expect(runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:product,quantity:1}],'guest_qr'))).rejects.toThrow()
 })
 it('restores only automatic suspension after both conditions recover, preserving manual revocation',async()=>{
  const base=Date.now()+1000
  for(const [accountId,externalId,staffId] of [[serviceId,'openid-social',''],[wecomId,'external-social','staff1']])await run(repo=>repo.applyRelationship({accountId:accountId!,externalId:externalId!,staffId:staffId!,active:true,unionId:null,occurredAt:new Date(base).toISOString()}))
  const id=await project(true)
  const cardId=await runner.run(scope,async tx=>{const repo=new MemberCardRepository(tx),a=await repo.apply({projectId:id,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-09-16'});await repo.review({applicationId:a.applicationId,decision:'approve',employeeId:reviewer,businessDate:'2026-09-16',reason:'本地双条件恢复测试'});return(await tx.query<{id:string}>('SELECT id FROM mbox.member_cards WHERE project_id=$1',[id])).rows[0]!.id})
  const change=(active:boolean,offset:number)=>run(repo=>repo.applyRelationship({accountId:serviceId,externalId:'openid-social',staffId:'',active,unionId:null,occurredAt:new Date(base+offset).toISOString()}))
  await change(false,1000);expect((await pool.query('SELECT status,social_suspended FROM mbox.member_cards WHERE id=$1',[cardId])).rows[0]).toMatchObject({status:'suspended',social_suspended:true})
  await change(true,2000);expect((await pool.query('SELECT status,social_suspended FROM mbox.member_cards WHERE id=$1',[cardId])).rows[0]).toMatchObject({status:'active',social_suspended:false})
  await pool.query("UPDATE mbox.member_cards SET status='revoked',social_suspended=false WHERE id=$1",[cardId])
  await change(false,3000);await change(true,4000)
  expect((await pool.query('SELECT status FROM mbox.member_cards WHERE id=$1',[cardId])).rows[0].status).toBe('revoked')
 })
 it('keeps public dishes and unions only live card increments, including an exclusive bundle',async()=>{
  for(const [accountId,externalId,staffId] of [[serviceId,'openid-social',''],[wecomId,'external-social','staff1']])await run(repo=>repo.applyRelationship({accountId:accountId!,externalId:externalId!,staffId:staffId!,active:true,unionId:null,occurredAt:new Date(Date.now()+10000).toISOString()}))
  const a=await project(false),b=await project(false),publicProduct=randomUUID(),bundle=randomUUID()
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,guest_visible,inventory_control_mode,cost_amount_minor) VALUES($1,$3,$4,'V9_PUBLIC','公共菜','DRINK','single','none',true,'not_managed',100),($2,$3,$4,'V9_EXCLUSIVE_BUNDLE','另一张卡套餐','DRINK','bundle','none',false,'not_managed',200)",[publicProduct,bundle,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 minute'),($1,$2,$4,'standard',1500,'CNY',clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,publicProduct,bundle])
  await pool.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,2,1)',[scope.tenantId,scope.storeId,bundle,publicProduct])
  await runner.run(scope,async tx=>{const repo=new MemberCardRepository(tx);for(const [id,item] of [[a,product],[b,bundle]]){const app=await repo.apply({projectId:id!,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-09-16'});await repo.review({applicationId:app.applicationId,decision:'approve',employeeId:reviewer,businessDate:'2026-09-16',reason:'本地多卡并集测试'});await tx.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive,sort_order) VALUES($1,$2,$3,$4,true,0)',[scope.tenantId,scope.storeId,id,item])}})
  const menu=(id:string)=>runner.run(scope,tx=>searchGuestCatalog(tx,null,{search:'',categoryCode:null,limit:100,offset:0},id),{readOnly:true})
  expect((await menu(customer)).map(p=>p.id).sort()).toEqual([publicProduct,bundle,product].sort())
  expect((await menu(other)).map(p=>p.id)).toEqual([publicProduct])
  expect((await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:bundle,quantity:1}],'guest_qr'))).subtotalAmountMinor).toBe(1500)
  await pool.query("UPDATE mbox.member_cards SET status='revoked' WHERE project_id=$1",[a])
  expect((await menu(customer)).map(p=>p.id).sort()).toEqual([publicProduct,bundle].sort())
 })
 it('uses the lowest live card price across menu/cart/order and replaces it when another discount is authorized',async()=>{
  for(const [accountId,externalId,staffId] of [[serviceId,'openid-social',''],[wecomId,'external-social','staff1']])await run(repo=>repo.applyRelationship({accountId:accountId!,externalId:externalId!,staffId:staffId!,active:true,unionId:null,occurredAt:new Date(Date.now()+20000).toISOString()}))
  const a=await project(false),b=await project(false)
  for(const [projectId,price] of [[a,300],[b,250]] as const)await runner.run(scope,async tx=>{const repo=new MemberCardRepository(tx),app=await repo.apply({projectId,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-09-16'});await repo.review({applicationId:app.applicationId,decision:'approve',employeeId:reviewer,businessDate:'2026-09-16',reason:'验证专属价'});await tx.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive,exclusive_price_minor) VALUES($1,$2,$3,$4,true,$5)',[scope.tenantId,scope.storeId,projectId,product,price])})
  const quoted=await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:product,quantity:1}],'guest_qr'));expect(quoted.subtotalAmountMinor).toBe(250)
  expect((await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:product,quantity:1}],'guest_qr',false))).subtotalAmountMinor).toBe(500)
  expect((await runner.run(scope,tx=>searchGuestCatalog(tx,null,{search:'',categoryCode:null,limit:100,offset:0},customer))).find(p=>p.id===product)?.amount_minor).toBe('250')
  await runner.run(scope,async tx=>{
   await tx.query("INSERT INTO mbox.launch_popup_policies(tenant_id,store_id,enabled) VALUES($1,$2,true)",[scope.tenantId,scope.storeId])
   await tx.query('INSERT INTO mbox.launch_popup_products(tenant_id,store_id,product_id,sort_order) VALUES($1,$2,$3,0)',[scope.tenantId,scope.storeId,product])
   expect((await readLaunchPopup(tx,true,customer)).products).toEqual([])
   await tx.query(`UPDATE mbox.products SET guest_visible=true,product_snapshot=jsonb_build_object('imageUrl','/menu/v3-pilot/items/v3-signature-urban-oasis.jpg') WHERE id=$1`,[product])
   const memberPopup=await readLaunchPopup(tx,true,customer),guestPopup=await readLaunchPopup(tx,true,other)
   expect(memberPopup.products).toHaveLength(1)
   expect(memberPopup.products[0]).toMatchObject({id:product,amountMinor:250,currency:'CNY',imageUrl:'/menu/v3-pilot/items/v3-signature-urban-oasis.jpg'})
   expect(guestPopup.products[0]).toMatchObject({id:product,amountMinor:500})
   expect(JSON.stringify(memberPopup.products)).not.toMatch(/cost_amount|product_snapshot|customer_id/)
   expect(await searchGuestCatalog(tx,null,{search:'',categoryCode:null,limit:8,offset:0,productIds:[]},customer)).toEqual([])
   await tx.query("UPDATE mbox.products SET guest_visible=false,product_snapshot='{}'::jsonb WHERE id=$1",[product])
  })
  const area=randomUUID(),table=randomUUID(),session=randomUUID()
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'PRICE','Price','indoor')",[area,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'PRICE','PRICE',2)",[table,scope.tenantId,scope.storeId,area])
  await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'PRICE-SESSION',CURRENT_DATE,2,'open')",[session,scope.tenantId,scope.storeId,table])
  const cart=await runner.run(scope,async tx=>{const repo=new GuestSharedCartRepository(tx,customer),cart=await repo.readOpen(session,'GSC00000000000000000000000000000001');await tx.query('INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity) VALUES($1,$2,$3,$4,1)',[scope.tenantId,scope.storeId,cart.id,product]);return repo.readOpen(session,'GSC00000000000000000000000000000001')});expect(cart.totalAmountMinor).toBe(250)
  const input={tableSessionId:session,createdByCustomerId:customer,publicId:'CARD-PRICE-ORDER',channel:'guest_qr' as const,lines:[{productId:product,quantity:1}]}
  const order=await runner.run(scope,tx=>new OrderRepository(tx,customer).createSubmitted(input));expect(order.totalAmountMinor).toBe(250);expect(order.items[0]!.productSnapshot).toMatchObject({priceType:'member_card',standardAmountMinor:500,cardPriceMinor:250})
  const discounted=await runner.run(scope,async tx=>{const source=randomUUID(),authorization=await new PricingAuthorizationPolicy({authorize:async()=>({authorized:true,authorizationId:source,kind:'discount',sourceType:'benefit',sourceId:source,amountMinor:100,maximumAmountMinor:100,currency:'CNY'}),consume:async()=>{}}).authorize(tx,{scope,actor:{type:'system',ref:'local-exclusive-price-test'},tableSessionId:session,channel:'guest_qr',lines:input.lines},{sourceType:'benefit',sourceId:source});return new OrderRepository(tx,customer).createSubmitted({...input,publicId:'COUPON-REPLACES-CARD'},authorization)})
  expect(discounted.totalAmountMinor).toBe(400);expect(discounted.items[0]!.unitPriceMinor).toBe(500)
  await pool.query("UPDATE mbox.member_cards SET status='revoked' WHERE project_id=$1",[b]);expect((await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent(input.lines,'guest_qr'))).subtotalAmountMinor).toBe(300)
  expect((await pool.query('SELECT total_amount_minor FROM mbox.orders WHERE id=$1',[order.id])).rows[0].total_amount_minor).toBe('250')
 })
 it('enforces HTTP authentication, authorization, replay and optimistic member-number configuration',async()=>{
  const app=Fastify(),commands=new NormalizedCommandExecutor(runner)
  await app.register(memberNumberApiPlugin,{transactions:runner,commands,resolveStaffContext:async request=>{if(!request.headers['x-test-actor'])throw new NormalizedAuthenticationRequiredError();return{scope,employeeId:String(request.headers['x-test-actor']),businessDate:'2026-09-16'}}})
  try{
   expect((await app.inject({method:'GET',url:'/staff/member-number-policy'})).statusCode).toBe(401)
   expect((await app.inject({method:'GET',url:'/staff/member-number-policy',headers:{'x-test-actor':deniedEmployee}})).statusCode).toBe(403)
   const payload={policy:defaultMemberNumberPolicy,version:0,reason:'本地接口版本测试'},headers={'x-test-actor':employee,'idempotency-key':'local-number-config-1'}
   const saved=await app.inject({method:'POST',url:'/staff/member-number-policy',headers,payload});expect(saved.statusCode).toBe(200)
   expect((await app.inject({method:'POST',url:'/staff/member-number-policy',headers,payload})).json().meta.replayed).toBe(true)
   expect((await app.inject({method:'POST',url:'/staff/member-number-policy',headers:{...headers,'idempotency-key':'local-number-config-2'},payload})).statusCode).toBe(409)
  }finally{await app.close()}
 })
 it('persists a signed service callback once and rejects forged signatures',async()=>{
  const app=Fastify();await app.register(socialAccountApiPlugin,{scope,transactions:runner,commands:new NormalizedCommandExecutor(runner),protection,resolveStaffContext:async()=>({scope,employeeId:employee,businessDate:'2026-09-16'})})
  const timestamp=String(Math.floor(Date.now()/1000)),nonce='localCallback1',xml=`<xml><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[unsubscribe]]></Event><FromUserName><![CDATA[callback-test-openid]]></FromUserName></xml>`
  const bytes=Buffer.from(xml),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length)
  const raw=Buffer.concat([Buffer.alloc(16,3),length,bytes,Buffer.from('wxSocialTest01')]),padding=32-raw.length%32,key=Buffer.alloc(32,7),cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false)
  const encrypted=Buffer.concat([cipher.update(Buffer.concat([raw,Buffer.alloc(padding,padding)])),cipher.final()]).toString('base64'),signature=createHash('sha1').update(['SocialToken',timestamp,nonce,encrypted].sort().join('')).digest('hex')
  const url=`/social-accounts/${serviceId}/callback?timestamp=${timestamp}&nonce=${nonce}&msg_signature=${signature}`,payload=`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,headers={'content-type':'text/xml'}
  try{
   expect((await app.inject({method:'POST',url:url.replace(signature,'0'.repeat(40)),headers,payload})).statusCode).toBe(403)
   for(let i=0;i<2;i++)expect((await app.inject({method:'POST',url,headers,payload})).body).toBe('success')
   const row=(await pool.query('SELECT count(*)::int AS n FROM mbox.social_callback_events WHERE account_id=$1 AND fingerprint=$2',[serviceId,createHash('sha256').update(xml).digest('hex')])).rows[0];expect(row.n).toBe(1)
   expect((await pool.query('SELECT active FROM mbox.social_relationships WHERE account_id=$1 AND external_hash=$2',[serviceId,protection.protect('callback-test-openid').hash])).rows[0].active).toBe(false)
  }finally{await app.close()}
 })
 it('links a verified follow after later Mini Program sign-in without trusting a supplied customer id',async()=>{
  const union='local-union-after-follow',principal='local-principal-after-follow',externalId='follow-before-login'
  await run(repo=>repo.applyRelationship({accountId:serviceId,externalId,staffId:'',active:true,unionId:union,occurredAt:new Date().toISOString()}))
  expect((await pool.query('SELECT customer_id FROM mbox.social_relationships WHERE external_hash=$1 AND account_id=$2',[protection.protect(externalId).hash,serviceId])).rows[0].customer_id).toBeNull()
  await pool.query("INSERT INTO mbox.customer_identities(tenant_id,store_id,customer_id,identity_kind,identity_hash) VALUES($1,$2,$3,'wechat',encode(digest('wechat:'||$4,'sha256'),'hex'))",[scope.tenantId,scope.storeId,other,principal])
  await pool.query(`INSERT INTO mbox.wechat_identities(tenant_id,store_id,external_identity_id,principal_type,principal_id,channel,app_id,openid_sha256,openid_ciphertext,openid_key_version,unionid_sha256,unionid_ciphertext,unionid_key_version,consent_version,consented_at,last_authenticated_at)
   VALUES($1,$2,'local-follow-before-login','guest',$3,'mini_program','wxLocalMiniTest',encode(digest('local-openid','sha256'),'hex'),decode(repeat('00',29),'hex'),1,encode(digest($4,'sha256'),'hex'),decode(repeat('00',29),'hex'),1,'login-v1',clock_timestamp(),clock_timestamp())`,[scope.tenantId,scope.storeId,principal,union])
  await run(repo=>repo.relinkVerifiedRelationships())
  expect(await run(repo=>repo.recipient(serviceId,other))).toBe(externalId)
 })
 it('keeps broadcast drafts inert, permits cancellation and accepts the final signed receipt only for the matching account',async()=>{
  const input=broadcastSchema.parse({accountId:serviceId,title:'本地测试',content:'测试草稿，禁止真实发送',scheduledAt:new Date(Date.now()+3600000).toISOString()})
  const job=await runner.run(scope,tx=>new SocialBroadcastRepository(tx).create(input,employee))
  const request=vi.fn<typeof fetch>();vi.stubGlobal('fetch',request)
  try{expect(await sendNextBroadcast(runner,scope,protection)).toBe(false);expect(request).not.toHaveBeenCalled()}finally{vi.unstubAllGlobals()}
  await runner.run(scope,tx=>new SocialBroadcastRepository(tx).transition(job.id,'schedule'))
  await runner.run(scope,tx=>new SocialBroadcastRepository(tx).transition(job.id,'cancel'))
  await expect(runner.run(scope,tx=>new SocialBroadcastRepository(tx).transition(job.id,'schedule'))).rejects.toThrow('草稿')
  const receipt=await runner.run(scope,tx=>new SocialBroadcastRepository(tx).create(input,employee))
  await pool.query("UPDATE mbox.social_broadcasts SET status='accepted',provider_reference='receipt-local' WHERE id=$1",[receipt.id])
  await runner.run(scope,tx=>new SocialBroadcastRepository(tx).recordReceipt(wecomId,'receipt-local','send success'))
  expect((await pool.query('SELECT status FROM mbox.social_broadcasts WHERE id=$1',[receipt.id])).rows[0].status).toBe('accepted')
  await runner.run(scope,tx=>new SocialBroadcastRepository(tx).recordReceipt(serviceId,'receipt-local','send success'))
  expect((await pool.query('SELECT status FROM mbox.social_broadcasts WHERE id=$1',[receipt.id])).rows[0].status).toBe('delivered')
 })
 it('never exposes stored credentials through the configuration read model',async()=>{
  const rows=await run(repo=>repo.list());expect(JSON.stringify(rows)).not.toMatch(/test-only-social-secret|SocialToken|encrypted_credentials|credential_hash/)
 })
})
