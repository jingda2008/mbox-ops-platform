import {loadNormalizedMigrations} from '../migrate-normalized.js'
import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {OrderRepository} from './order-repository.js'
import {PostarPaymentProviderAdapter,hashPostarPayload} from '../postar-adapter.js'
import {PostarRsaPaymentProviderVerifier} from './postar-provider-verifier.js'
import {POSTAR_BASE_URLS,POSTAR_ENDPOINTS,type PostarTopLevelPayload} from '../../src/shared/postar-contracts.js'
import {ProviderObservationAuthorizationError} from './provider-verification-observation.js'
import {randomUUID,generateKeyPairSync,privateEncrypt,privateDecrypt,constants} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ScopedPostgresTransactionRunner,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {paymentApiPlugin} from './payment-api.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {OnlinePaymentService} from './online-payment-service.js'

// Real RSA adapter and financial command chain; only its network port and
// authenticated HTTP context are injected. Admin constructs synthetic history.
// Adapted from the independent BQ01–05 acceptance fixture; no production data.
const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const caps=['payment.initiate.staff','payment.manual.cash.record','payment.manual.pos.record','payment.manual.external.record','payment.collect.all_tables','payment.recollect.authorize','reconciliation.view','refund.request','refund.approve','refund.execute']
type Fx={scope:StoreScope;cashier:string;requester:string;role:string;date:string;table:string;session:string;order:string;item:string;orders:string[];items:string[];pending?:{id:string;publicId:string;amountMinor:number};otherPending?:{id:string;publicId:string;amountMinor:number}}
const observations:unknown[]=[]
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048})
const publicKeyPem=publicKey.export({format:'pem',type:'spki'}).toString()
const config={provider:'postar' as const,environment:'test' as const,agencyId:'SYNTHETICAGENCY',merchantId:'SYNTHETICMERCHANT',publicKey:publicKeyPem,callbackUrl:'https://example.test/unused-callback',timeoutMs:1000,wechat:null}
let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService
const meta=(f:Fx,employeeId=f.cashier)=>({scope:f.scope,actor:{type:'employee' as const,employeeId},businessDate:f.date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
;(adminUrl&&runtimeUrl?describe:describe.skip)('historical local-close active query with real RSA and restricted LOGIN',()=>{
  beforeAll(async()=>{
    pool=new Pool({connectionString:adminUrl,max:4});runtimePool=new Pool({connectionString:runtimeUrl,max:4});runner=new ScopedPostgresTransactionRunner(runtimePool)
    const identity=(await runtimePool.query("SELECT session_user,current_user,rolsuper,rolbypassrls,rolcanlogin,pg_has_role(current_user,'mbox_runtime','MEMBER') AS runtime_member FROM pg_roles WHERE rolname=session_user")).rows[0]
    expect(identity).toMatchObject({rolsuper:false,rolbypassrls:false,rolcanlogin:true,runtime_member:true});expect(identity.session_user).toBe(identity.current_user)
    const schema=(await pool.query('SELECT schema_version FROM mbox.normalized_schema_metadata')).rows[0].schema_version
    observations.push({schema});expect(schema).toBe((await loadNormalizedMigrations()).at(-1)!.version)
    money=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
  })
  afterAll(async()=>{await runtimePool?.end();await pool?.end()})

  async function permissions(f:Fx){return runner.run(f.scope,async tx=>(await tx.query<{code:string;allowed:boolean}>(`SELECT code,mbox.employee_has_effective_permission($1,$2,$3,code) allowed FROM unnest($4::text[]) code ORDER BY code`,[f.scope.tenantId,f.scope.storeId,f.cashier,caps])).rows)}
  async function post(f:Fx,path:string,payload:object,phase='fixture',key=randomUUID(),onlinePayments?:OnlinePaymentService){
    const effective=await permissions(f),allowed=effective.filter(row=>row.allowed).map(row=>row.code)
    const app=Fastify({logger:false}),context=()=>({scope:f.scope,actor:{type:'employee' as const,employeeId:f.cashier},employeeId:f.cashier,businessDate:f.date,capabilities:allowed})
    const unused=async()=>{throw new Error('Unexpected unused external port')}
    await app.register(paymentApiPlugin,{commands:money,onlinePayments,providerVerifier:new PostarRsaPaymentProviderVerifier({bindings:[{agencyId:config.agencyId,merchantId:config.merchantId,scope:f.scope,publicKey:publicKeyPem}]}),providerObservations:new VerifiedProviderObservationService(runner),reconciliationQuery:{list:unused},cashierWorkbenchQuery:new PostgresCashierWorkbenchQuery(runner),orderCancellation:{cancel:unused},orderSettlementException:{settle:unused},resolveActorContext:context,resolveStaffContext:context,resolveProviderBusinessDate:()=>f.date})
    try{const response=await app.inject({method:'POST',url:path,headers:{'idempotency-key':key},payload});if(phase!=='fixture')observations.push({phase,scope:f.scope,order:f.order,orders:f.orders,payment:f.pending?.id,permissions:effective,path,payload,status:response.statusCode,body:response.json()});return response}finally{await app.close()}
  }
  const authorize=(f:Fx,phase='fixture')=>post(f,`/orders/${f.order}/recollection-authorizations`,{reason:'独立验收确认历史原欠款后补收'},phase)
  const closeLocal=(f:Fx,phase:string)=>post(f,`/payments/${f.pending!.id}/close-unpresented-history`,{reason:'独立验收核对本地未外送原付款'},phase)
  const manual=(f:Fx,phase='fixture',provider='cash')=>post(f,'/payments/manual',{orderId:f.order,provider,method:provider==='cash'?'cash':provider==='physical_pos'?'card':'manual',...(provider==='cash'?{}:{receiptReference:randomUUID()}),...(provider==='external_manual'?{externalMethodCode:'bank_transfer',collectionNote:'独立验收银行回执'}:{})},phase)
  async function unusedView(f:Fx){const effective=await permissions(f);return (await new PostgresCashierWorkbenchQuery(runner).get({scope:f.scope,employeeId:f.cashier,businessDate:f.date,capabilities:effective.filter(r=>r.allowed).map(r=>r.code),query:f.order,limit:20})).orders.find(r=>r.id===f.order)!}
  async function revoke(f:Fx,code:string){await pool.query(`DELETE FROM mbox.role_permission_assignments assignment USING mbox.staff_permission_definitions permission WHERE assignment.permission_id=permission.id AND assignment.tenant_id=permission.tenant_id AND assignment.store_id=permission.store_id AND assignment.role_id=$1 AND permission.code=$2`,[f.role,code]);expect((await permissions(f)).find(r=>r.code===code)?.allowed).toBe(false)}
  async function fresh(withSecondAttempt=false,singlePayment=false):Promise<Fx>{
    const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),inventory=randomUUID(),recipe=randomUUID()
    const f:Fx={scope,cashier:randomUUID(),requester:randomUUID(),role:randomUUID(),date:'',table:randomUUID(),session:randomUUID(),order:'',item:'',orders:[],items:[]}
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'independent batch query synthetic')",[scope.tenantId,scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'query','independent batch query synthetic','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    f.date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'ITEM','Synthetic','drink','bar','tracked')",[product,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,'QUERY','Query material','ingredient','piece')",[inventory,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,instructions_snapshot,status,effective_at) VALUES($1,$2,$3,$4,1,1,'{}','active',clock_timestamp())",[recipe,scope.tenantId,scope.storeId,product])
    await pool.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity,expected_waste_quantity) VALUES($1,$2,$3,$4,1,0)',[scope.tenantId,scope.storeId,recipe,inventory])
    await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,100,0)',[scope.tenantId,scope.storeId,inventory])
    for(const employeeId of [f.cashier,f.requester]){
      const role=employeeId===f.cashier?f.role:randomUUID()
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Synthetic')",[role,scope.tenantId,scope.storeId,`G_${role.replaceAll('-','').toUpperCase()}`])
      await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
      for(const code of employeeId===f.cashier?caps:['refund.request']){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(employeeId===f.cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'T','T',4)",[f.table,scope.tenantId,scope.storeId,area])
    await pool.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,reason,created_by_employee_id) VALUES($1,$2,$3,$4,$5,'primary','独立验收本人负责原桌',$4)",[scope.tenantId,scope.storeId,f.table,f.cashier,f.role])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[f.session,scope.tenantId,scope.storeId,f.table,f.session,f.date])
    for(let i=0;i<2;i++){
      const order=randomUUID(),item=randomUUID();f.orders.push(order);f.items.push(item)
      await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000,'immediate_payment','awaiting_payment')",[order,scope.tenantId,scope.storeId,f.session,order])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'bar','{"name":"Synthetic","inventoryControlMode":"tracked"}')`,[item,scope.tenantId,scope.storeId,order,product])
    }
    for(const order of f.orders)await runner.run(f.scope,async tx=>{
      const submitted=await new OrderRepository(tx).getSubmittedForFulfillment(order)
      await new PaymentFulfillmentRepository(tx).prepareSubmittedOrder(submitted,{priorityByOrderItemId:new Map(submitted.items.map(item=>[item.id,100])),dueAtByOrderItemId:new Map(submitted.items.map(item=>[item.id,null]))})
    })
    f.order=f.orders[0]!;f.item=f.items[0]!
    const paid=await post(f,'/payments/manual',{orderId:f.order,orderIds:f.orders,provider:'cash',method:'cash'});expect(paid.statusCode,paid.body).toBe(201)
    for(let i=0;i<2;i++){
      const refund=(await money.requestRefund({...meta(f,f.requester),paymentId:paid.json().data.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'独立夹具原始普通调价退款',allocations:[{orderItemId:f.items[i]!,amountMinor:2000}]})).value
      await money.approveRefund({...meta(f),refundId:refund.id,decisionReason:'独立夹具异人审核'});await money.beginRefundExecution({...meta(f),refundId:refund.id});await money.recordManualRefundResult({...meta(f),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      const auth=await post(f,`/orders/${f.orders[i]}/recollection-authorizations`,{reason:'独立夹具关桌前明确原始欠款'});expect(auth.statusCode,auth.body).toBe(201)
    }
    f.pending=(await money.initiate({...meta(f),orderId:f.order,...(singlePayment?{}:{orderIds:f.orders}),publicId:randomUUID().replaceAll('-',''),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:f.cashier}})).value
    expect(f.pending).toMatchObject({payableKind:singlePayment?'order':'order_batch',amountMinor:singlePayment?2000:4000,status:'pending'})
    if(withSecondAttempt){
      for(const orderId of f.orders)expect((await post(f,`/orders/${orderId}/recollection-authorizations`,{reason:'原桌未关桌再次明确原款待核与重收'})).statusCode).toBe(201)
      f.otherPending=(await money.initiate({...meta(f),orderId:f.order,orderIds:f.orders,publicId:randomUUID().replaceAll('-',''),provider:'postar',method:'auth_code',principal:{type:'employee',employeeId:f.cashier}})).value
    }
    // Synthetic historical guard fixture ONLY: not a normal closing route or an actual schema234 upgrade.
    // Money/refunds/reservation/activation above are real commands using the restricted LOGIN.
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,f.cashier])
    const state=await snapshot(f)
    expect(state.operation.orders).toHaveLength(2);expect(state.operation.orders.every((r:any)=>r.fulfillment_state==='active')).toBe(true)
    expect(state.operation.tasks).toHaveLength(2);expect(state.operation.stock).toHaveLength(1)
    expect(state.operation.stock[0]).toMatchObject({on_hand_quantity:'98.000000',reserved_quantity:'0.000000'})
    expect(state.facts.map((r:any)=>r.due)).toEqual(['2000','2000'])
    observations.push({phase:'synthetic-historical-fixture-established',scope,orders:f.orders,session:f.session,payment:f.pending,operation:state.operation})
    return f
  }
  async function snapshot(f:Fx){return runner.run(f.scope,async tx=>{
    const a=[f.scope.tenantId,f.scope.storeId]
    const rows=async(sql:string)=>(await tx.query(sql,a)).rows
    const operation={
      session:await rows('SELECT to_jsonb(s) value FROM mbox.table_sessions s WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
      orders:await rows('SELECT id,status,settlement_mode,fulfillment_state,fulfillment_activated_at::text,total_amount_minor::text,table_session_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
      tasks:await rows('SELECT to_jsonb(t) value FROM mbox.kds_tasks t WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
      stock:await rows('SELECT inventory_item_id,on_hand_quantity::text,reserved_quantity::text FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 ORDER BY inventory_item_id'),
      movements:await rows('SELECT to_jsonb(m) value FROM mbox.inventory_movements m WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
      reservations:await rows('SELECT to_jsonb(r) value FROM mbox.inventory_order_reservations r WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
      plans:await rows('SELECT to_jsonb(p) value FROM mbox.customer_experience_plans p WHERE tenant_id=$1 AND store_id=$2 ORDER BY id'),
    }
    const facts=await rows('SELECT id,status,payment_status,mbox.order_collection_due_amount(tenant_id,store_id,id)::text due FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 ORDER BY id')
    const payments=await rows('SELECT id,order_id,payable_kind,provider,status,amount_minor::text,provider_transaction_id,settlement_channel FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 ORDER BY id,order_id')
    const ledger=await rows('SELECT id,entry_type,amount_minor::text,payment_id,refund_id,provider_reference FROM mbox.reconciliation_entries WHERE tenant_id=$1 AND store_id=$2 ORDER BY id')
    const auth=await rows('SELECT id,status,amount_minor::text,consumed_payment_id FROM mbox.order_recollection_authorizations WHERE tenant_id=$1 AND store_id=$2 ORDER BY id')
    const provider=await rows('SELECT id,payment_id,verification_kind,integration_ref,observed_status,reported_amount_minor::text,reported_currency,consumed_at::text,consumed_operation,provider_transaction_id FROM mbox.verified_provider_observations WHERE tenant_id=$1 AND store_id=$2 ORDER BY id')
    return {operation,facts,payments,ledger,auth,provider}
  })}
  type Mode='success'|'pending'|'failed'|'not-found'|'offline'|'signature-tampered'|'wrong-order'|'wrong-amount'|'wrong-agency'|'wrong-merchant'
  function onlineFor(f:Fx,mode:Mode,calls:unknown[]){
    const unused=async()=>{throw new Error('Unexpected network operation')}
    const adapter=new PostarPaymentProviderAdapter({environment:'test',billSource:{downloadBill:unused},metadataSource:{getPaymentMetadata:unused,getRefundMetadata:unused,getRefundQueryMetadata:unused},httpClient:{post:async request=>{
      // Local in-process HTTP port, no fetch/socket/provider traffic. Production RSA adapter is retained.
      if(mode==='offline')throw new Error('Synthetic provider unavailable')
      const sent=JSON.parse(new TextDecoder().decode(request.body)),sign=sent.sign;delete sent.sign
      const decrypted=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(sign,'base64')).toString('utf8')
      expect(decrypted).toBe(hashPostarPayload(sent));expect(request.url).toBe(POSTAR_BASE_URLS.test+POSTAR_ENDPOINTS.queryPayment)
      expect(sent).toMatchObject({agetId:config.agencyId,custId:config.merchantId,orderNo:f.pending!.publicId})
      const date=new Date(Date.now()+8*3600000).toISOString().replace(/[-:T]/g,'').slice(0,14)
      const raw:PostarTopLevelPayload={code:mode==='pending'?'222222':mode==='failed'?'555555':mode==='not-found'?'ORDER_NOT_FOUND':'000000',msg:'local synthetic query response',data:{agetId:mode==='wrong-agency'?'ANOTHERAGENCY':config.agencyId,custId:mode==='wrong-merchant'?'ANOTHERMERCHANT':config.merchantId,orderNo:`SYNQUERY${f.pending!.id.replaceAll('-','')}`,orderStatus:mode==='pending'?'2':mode==='failed'?'0':'1',orderTime:date,threeOrderNo:mode==='wrong-order'?'UnrelatedSyntheticOrder':f.pending!.publicId,txamt:String(f.pending!.amountMinor-(mode==='wrong-amount'?1:0)),payChannel:'2'}}
      const signed:any={...raw,sign:privateEncrypt({key:privateKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(hashPostarPayload(raw),'utf8')).toString('base64')}
      if(mode==='signature-tampered')signed.msg='tampered after signing'
      calls.push({mode,request:sent,response:{code:signed.code,data:signed.data},signedWithEphemeralSyntheticRsa:true,transport:'local-in-process-post-port'})
      return {status:200,headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(signed))}
    }}})
    return new OnlinePaymentService(runner,'independent-query-ephemeral-fixture-secret',config,adapter,new VerifiedProviderObservationService(runner))
  }
  const query=(f:Fx,online:OnlinePaymentService,phase:string,key=randomUUID())=>post(f,`/payments/${f.pending!.id}/provider-query`,{},phase,key,online)
  it('BQ01 local-closed original batch remains queryable for a trusted late success',async()=>{
    const f=await fresh(),calls:unknown[]=[],online=onlineFor(f,'success',calls)
    const closed=await closeLocal(f,'BQ01:local-close');expect(closed.statusCode,closed.body).toBe(201);expect(closed.json().data.status).toBe('closed')
    expect((await unusedView(f)).payments.find(p=>p.id===f.pending!.id)?.localUnpresentedHistoryClosed).toBe(true)
    const before=await snapshot(f),response=await query(f,online,'BQ01:query-local-closed'),after=await snapshot(f)
    observations.push({phase:'BQ01:state',before,after,calls})
    expect(after.operation).toEqual(before.operation)
    // Correct required behavior, deliberately remains red if the public query rejects local closed attempts.
    expect(response.statusCode,response.body).toBe(200)
    expect(response.json().data).toMatchObject({id:f.pending!.id,status:'succeeded',amountMinor:4000})
    expect(after.ledger.filter((r:any)=>r.payment_id===f.pending!.id)).toHaveLength(1)
    expect(after.facts.every((r:any)=>r.due==='0')).toBe(true)
  })
  it('queries a real locally closed single-order attempt without reactivating either original order',async()=>{
    const f=await fresh(false,true),calls:unknown[]=[]
    expect((await closeLocal(f,'single-local-close')).statusCode).toBe(201)
    const before=await snapshot(f),response=await query(f,onlineFor(f,'success',calls),'single-late-success')
    expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toMatchObject({payableKind:'order',status:'succeeded',amountMinor:2000})
    const after=await snapshot(f);expect(after.operation).toEqual(before.operation)
    expect(after.ledger.filter((r:any)=>r.payment_id===f.pending!.id)).toEqual([expect.objectContaining({amount_minor:'2000'})])
    expect(after.facts.find((r:any)=>r.id===f.order)?.due).toBe('0');expect(calls).toHaveLength(1)
  })
  it('BQ02 pending batch on a closed table applies RSA-bound success once and financial facts remain idempotent',async()=>{
    const f=await fresh(),calls:unknown[]=[],online=onlineFor(f,'success',calls),key=randomUUID(),before=await snapshot(f)
    const first=await query(f,online,'BQ02:first',key),after=await snapshot(f)
    observations.push({phase:'BQ02:first-state',before,after,calls})
    expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({id:f.pending!.id,payableKind:'order_batch',status:'succeeded',amountMinor:4000})
    expect(after.operation).toEqual(before.operation);expect(after.auth).toEqual(before.auth)
    expect(after.facts.map((r:any)=>r.due)).toEqual(['0','0'])
    expect(after.ledger.filter((r:any)=>r.payment_id===f.pending!.id)).toEqual([expect.objectContaining({entry_type:'payment',amount_minor:'4000'})])
    expect(after.payments.filter((r:any)=>r.id===f.pending!.id)).toEqual(f.orders.slice().sort().map(order_id=>expect.objectContaining({order_id,status:'succeeded',amount_minor:'2000'})))
    expect(after.provider).toEqual([expect.objectContaining({verification_kind:'active_query_binding',integration_ref:'postar-active-query',observed_status:'payment_succeeded',reported_amount_minor:'4000',reported_currency:'CNY',consumed_operation:'payment.provider-query',consumed_at:expect.any(String)})])
    for(const [phase,replayKey] of [['same-key',key],['fresh-key',randomUUID()]] as const){const repeat=await query(f,online,`BQ02:${phase}`,replayKey);expect(repeat.statusCode,repeat.body).toBe(200);expect(repeat.json().data.status).toBe('succeeded');expect(repeat.json().meta.replayed).toBe(phase==='same-key');expect(await snapshot(f)).toEqual(after)}
    expect(calls).toHaveLength(1)
    await pool.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='payment.provider-query' AND idempotency_key=$3",[f.scope.tenantId,f.scope.storeId,key])
    const expired=await query(f,online,'BQ02:expired-original-key',key)
    expect(expired.statusCode,expired.body).toBe(200);expect(expired.json().meta).toEqual({replayed:false,resultSource:'local_payment',providerQueried:false})
    await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='payment.provider-query' AND idempotency_key=$3",[f.scope.tenantId,f.scope.storeId,key])
    const deleted=await query(f,online,'BQ02:deleted-original-receipt',key);expect(deleted.statusCode,deleted.body).toBe(200);expect(deleted.json().meta.replayed).toBe(false)
    await revoke(f,'reconciliation.view')
    expect((await query(f,online,'BQ02:revoked-after-success',key)).statusCode).toBe(403)
    expect(await snapshot(f)).toEqual(after);expect(calls).toHaveLength(1)
    observations.push({phase:'BQ02:idempotent-final',after:await snapshot(f),calls})
  })
  it('BQ03 signed pending is not revenue and a current reconciliation revocation blocks query before the provider',async()=>{
    const f=await fresh(),calls:unknown[]=[],before=await snapshot(f),online=onlineFor(f,'pending',calls)
    const pending=await query(f,online,'BQ03:pending');expect(pending.statusCode,pending.body).toBe(200);expect(pending.json().data.status).toBe('pending');expect(await snapshot(f)).toEqual(before)
    await revoke(f,'reconciliation.view')
    const denied=await query(f,onlineFor(f,'success',calls),'BQ03:revoked');expect(denied.statusCode,denied.body).toBe(403);expect(calls).toHaveLength(1);expect(await snapshot(f)).toEqual(before)
    observations.push({phase:'BQ03:state',before,after:await snapshot(f),calls})
  })
  it('BQ04 signature, subject and amount failures cannot create a verified payment observation or revenue',async()=>{
    const f=await fresh(),calls:unknown[]=[],before=await snapshot(f)
    for(const mode of ['signature-tampered','wrong-order','wrong-amount','wrong-agency','wrong-merchant'] as const){
      const result=await query(f,onlineFor(f,mode,calls),`BQ04:${mode}`)
      expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('PAYMENT_STATUS_UNKNOWN');expect(await snapshot(f)).toEqual(before)
    }
    expect(calls).toHaveLength(5);observations.push({phase:'BQ04:state',before,after:await snapshot(f),calls})
  })
  it('BQ05 invented or wrong-payment query proof cannot authorize a financial command',async()=>{
    const f=await fresh(),calls:unknown[]=[],before=await snapshot(f)
    const input={...meta(f),actor:{type:'integration' as const,ref:'postar-active-query'},paymentPublicId:f.pending!.publicId,verifiedObservationId:randomUUID(),provider:'postar' as const,providerTransactionId:`SYNQUERY${f.pending!.id.replaceAll('-','')}`,reportedAmountMinor:4000,reportedCurrency:'CNY',settlementChannel:'wechat' as const,status:'succeeded' as const,occurredAt:new Date().toISOString()}
    await expect(money.recordProviderQueryResult(input)).rejects.toBeInstanceOf(ProviderObservationAuthorizationError);expect(await snapshot(f)).toEqual(before)
    // Get a real signed, bound, unconsumed proof through OnlinePaymentService; do not inject a recorder result.
    const trusted=await onlineFor(f,'success',calls).query({scope:f.scope,paymentId:f.pending!.id,queryBindingId:randomUUID(),principal:{type:'employee',employeeId:f.cashier}})
    expect(trusted.verifiedObservationId).toBeTruthy()
    const withProof=await snapshot(f),originalPublicId=(await runner.run(f.scope,async tx=>(await tx.query<{public_id:string}>('SELECT public_id FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND id<>$3 ORDER BY created_at LIMIT 1',[f.scope.tenantId,f.scope.storeId,f.pending!.id])).rows[0]!.public_id))
    await expect(money.recordProviderQueryResult({...input,idempotencyKey:randomUUID(),verifiedObservationId:trusted.verifiedObservationId!,paymentPublicId:originalPublicId})).rejects.toBeInstanceOf(ProviderObservationAuthorizationError)
    expect(await snapshot(f)).toEqual(withProof);expect(withProof.ledger).toEqual(before.ledger);expect(withProof.provider[0]).toMatchObject({consumed_at:null,consumed_operation:null})
    observations.push({phase:'BQ05:state',before,after:await snapshot(f),calls,fabricatedProofRejected:true,wrongPaymentProofRejected:true})
  })
  it('retains the local close for signed processing/failed and unknown nonexistent provider orders',async()=>{
    const f=await fresh(),calls:unknown[]=[];expect((await closeLocal(f,'local-close-nonsuccess')).statusCode).toBe(201)
    const before=await snapshot(f)
    for(const mode of ['pending','failed','not-found'] as const){
      const response=await query(f,onlineFor(f,mode,calls),`closed:${mode}`)
      if(mode==='not-found'){expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('PAYMENT_STATUS_UNKNOWN')}
      else{expect(response.statusCode,response.body).toBe(200);expect(response.json().data.status).toBe('closed');expect(response.json().meta.localStatusRetained).toBe(true);expect(response.json().provider.status).toBe(mode==='pending'?'processing':'failed')}
      expect(await snapshot(f)).toEqual(before)
    }
    expect(calls).toHaveLength(3)
  })
  it('recovers an already verified unconsumed late success without contacting an unavailable provider',async()=>{
    const f=await fresh(),calls:unknown[]=[],key=randomUUID();await closeLocal(f,'local-close-before-proof')
    const online=onlineFor(f,'success',calls),before=await snapshot(f)
    const proof=await online.query({scope:f.scope,paymentId:f.pending!.id,queryBindingId:key,principal:{type:'employee',employeeId:f.cashier}})
    expect(proof.verifiedObservationId).toBeTruthy();expect((await snapshot(f)).provider[0]).toMatchObject({consumed_at:null})
    const recovered=await query(f,onlineFor(f,'offline',calls),'recover-saved-proof',key)
    expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().data.status).toBe('succeeded')
    const after=await snapshot(f);expect(after.operation).toEqual(before.operation);expect(after.provider).toHaveLength(1)
    expect(after.ledger.filter((row:any)=>row.payment_id===f.pending!.id)).toHaveLength(1);expect(calls).toHaveLength(1)
  })
  it('rejects an original key reused for another real payment and a valid employee in another scope',async()=>{
    const first=await fresh(true),second=await fresh(),calls:unknown[]=[],key=randomUUID()
    expect((await query(first,onlineFor(first,'success',calls),'first-scope-original-key',key)).statusCode).toBe(200)
    const before=await snapshot(first)
    await expect(onlineFor(first,'success',calls).query({scope:second.scope,paymentId:first.pending!.id,queryBindingId:key,principal:{type:'employee',employeeId:second.cashier}})).rejects.toThrow('支付记录不存在')
    const other={...first,pending:first.otherPending!}
    const mismatch=await query(other,onlineFor(other,'success',calls),'different-payment-original-key',key)
    expect(mismatch.statusCode,mismatch.body).toBe(409)
    expect(await snapshot(first)).toEqual(before);expect(calls).toHaveLength(1)
  })
  it('does not admit arbitrary provider-closed attempts or a marker without the real local-close audit',async()=>{
    for(const marker of [false,true]){
      const f=await fresh(),calls:unknown[]=[]
      await pool.query("UPDATE mbox.payments SET status='closed',provider_snapshot=$2::jsonb WHERE id=$1",[f.pending!.id,JSON.stringify(marker?{localUnpresentedHistoryClosed:true}:{})])
      const before=await snapshot(f)
      expect((await query(f,onlineFor(f,'success',calls),marker?'marker-without-audit':'provider-closed')).statusCode).toBe(503)
      expect(await snapshot(f)).toEqual(before);expect(calls).toHaveLength(0)
    }
  })
})
