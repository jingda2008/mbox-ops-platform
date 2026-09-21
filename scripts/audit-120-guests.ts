import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {Client} from 'pg'
import {runNormalizedMigrations} from '../server/migrate-normalized.js'
import {parseStoreProvisionConfig,provisionNormalizedStore} from '../server/provision-normalized-store.js'
import {parseNormalizedCatalog,provisionNormalizedCatalog} from '../server/provision-normalized-catalog.js'
import {createNormalizedApp} from '../server/normalized/normalized-app.js'
import {loadNormalizedRuntimeConfig} from '../server/normalized/normalized-runtime-config.js'
import {TableQrProvisioner} from '../server/normalized/table-qr-provisioner.js'

// Deliberately isolated HTTP exercise. No external payment adapters or printers.
const output='/Users/jingda/mbox/outputs/120-guests-audit-20260921'
const name=`mbox120_http_${Date.now()}`
const admin=new Client({connectionString:'postgresql://mbox_audit@127.0.0.1:56521/postgres'})
const url=`postgresql://mbox_audit@127.0.0.1:56521/${name}`
const db=new Client({connectionString:url})
const base='http://127.0.0.1:56522',secret='isolated-120-guest-audit-secret-at-least-32-bytes'
const observations:any[]=[],checks:any[]=[],errors:any[]=[]
const staff:Record<string,any>={},sessions:any[]=[],orders:any[]=[],guests:any[]=[]
let runtime:any,created=false,connected=false,active=0,maxActive=0
const startedAt=new Date().toISOString()
const id=(s:string)=>`audit120-${s}`
function check(name:string,passed:boolean,actual:unknown,expected:unknown){checks.push({name,passed,actual,expected})}
async function request(label:string,method:string,path:string,actor:any,body?:unknown,key?:string,extra:Record<string,string>={}){
  const started=performance.now();active++;maxActive=Math.max(maxActive,active)
  try{
    const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(actor?.token?{authorization:`Bearer ${actor.token}`} : {}),...(actor?.device?{'x-mbox-guest-device':actor.device}:{}),...(key?{'idempotency-key':key}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)})
    const parsed=await r.json();observations.push({label,status:r.status,ms:Math.round((performance.now()-started)*100)/100,code:parsed.error?.code??null})
    return {ok:r.ok,status:r.status,body:parsed,data:parsed.data??parsed,headers:r.headers}
  }catch(e){observations.push({label,status:0,ms:performance.now()-started,error:String(e)});throw e}
  finally{active--}
}
function required(r:any,label:string){if(!r.ok)throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);return r.data}
async function login(code:string){
  const r=await request('device','POST','/api/auth/device-access',null,{credential:'AUDIT120',deviceKey:`audit120-${code}`})
  const token=(r.headers.get('set-cookie')??'').match(/__Host-mbox_device_lease=([A-Za-z0-9_-]+)/)?.[1]
  const l=await request('login','POST','/api/auth/login',{token},{employeeCode:code,pin:'5210'})
  const data=required(l,'login '+code)
  return {token:(l.headers.get('set-cookie')??'').match(/__Host-mbox_staff_session=([A-Za-z0-9_-]+)/)?.[1],employeeId:data.employee.id,code}
}
async function lane(items:any[],work:(item:any,index:number)=>Promise<unknown>){for(let i=0;i<items.length;i++)await work(items[i],i)}
try{
  await mkdir(output,{recursive:true});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;await db.connect();connected=true
  await runNormalizedMigrations(url)
  const store=parseStoreProvisionConfig(JSON.parse(await readFile('deploy/normalized-store/mbox-lujiazui.store.json','utf8')))
  const catalog=parseNormalizedCatalog(JSON.parse(await readFile('config/menu-catalog-2026-07-27.json','utf8')))
  await provisionNormalizedStore({databaseUrl:url,config:store,environment:{...Object.fromEntries(store.employees.map(e=>[e.pinEnv,'5210'])),[store.dailyCredentialEnv??'MBOX_STORE_DAILY_CREDENTIAL']:'AUDIT120'},sourceCommitSha:'77744bc4e9ed308546b630590bdfa5dfe5ce5b7d'})
  await provisionNormalizedCatalog({databaseUrl:url,tenantId:store.tenant.id,storeId:store.store.id,catalog,sourceCommitSha:'77744bc4e9ed308546b630590bdfa5dfe5ce5b7d'})
  const scope={tenantId:store.tenant.id,storeId:store.store.id}
  await db.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.store_id',$2,false)",[scope.tenantId,scope.storeId])
  await db.query("INSERT INTO mbox.store_commerce_policies(tenant_id,store_id,online_payment_enabled,reason,updated_by_employee_id) SELECT $1,$2,true,'isolated simulation payment only',id FROM mbox.employees WHERE employee_code='liyan' ON CONFLICT(tenant_id,store_id) DO UPDATE SET online_payment_enabled=true",[scope.tenantId,scope.storeId])
  const config=loadNormalizedRuntimeConfig({NODE_ENV:'test',DATABASE_URL:url,MBOX_TENANT_ID:scope.tenantId,MBOX_STORE_ID:scope.storeId,MBOX_NORMALIZED_SECRET:secret,MBOX_GUEST_PAYMENT_MODE:'simulation',MBOX_START_WORKERS:'false',MBOX_DATABASE_POOL_MAX:'12',MBOX_QUANTITY_AFTER_SALES_ENABLED:'true',MBOX_KITCHEN_BATCH_BOARD_ENABLED:'true',HOST:'127.0.0.1',PORT:'56522'})
  runtime=await createNormalizedApp({config,logger:{level:'error'}});await runtime.app.listen({host:'127.0.0.1',port:56522})
  for(const code of ['liyan','tom','jerry','tyke','sanmu','lengyanzhi','shenliangliang'])staff[code]=await login(code)
  const tables=(await db.query("SELECT id,code FROM mbox.tables WHERE status='available' AND capacity>=4 ORDER BY code LIMIT 30")).rows
  check('30 tables available',tables.length===30,tables.length,30)
  if(tables.length!==30)throw new Error('insufficient four-seat tables')
  const products:any[]=[]
  for(const station of ['bar','kitchen']){
    const p=(await db.query("SELECT p.id,p.name,p.inventory_control_mode FROM mbox.products p JOIN mbox.product_prices pp ON pp.product_id=p.id WHERE p.product_kind='single' AND p.status='active' AND p.fulfillment_station=$1 AND p.guest_visible AND 'guest_qr'=ANY(p.allowed_channels) AND pp.amount_minor>0 ORDER BY (p.name='金汤力') DESC,pp.amount_minor,p.code LIMIT 1",[station])).rows[0]
    if(!p)throw new Error('no product '+station)
    p.station=station;p.inventory=randomUUID();products.push(p)
    await db.query("UPDATE mbox.products SET inventory_control_mode='tracked' WHERE id=$1",[p.id])
    await db.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,$4,'ingredient','piece')",[p.inventory,scope.tenantId,scope.storeId,`AUDIT120-${station}`])
    const recipe=(await db.query("INSERT INTO mbox.recipes(tenant_id,store_id,product_id,version,yield_quantity,instructions_snapshot,status,effective_at) VALUES($1,$2,$3,1,1,'{}','active',clock_timestamp()) RETURNING id",[scope.tenantId,scope.storeId,p.id])).rows[0].id
    await db.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity,expected_waste_quantity) VALUES($1,$2,$3,$4,1,0)',[scope.tenantId,scope.storeId,recipe,p.inventory])
    await db.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10000,0)',[scope.tenantId,scope.storeId,p.inventory])
  }
  const printer=randomUUID()
  await db.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'audit-cashier','Isolated queue only','printer','cashier','offline')",[printer,scope.tenantId,scope.storeId])
  await db.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'audit-cashier','Isolated cashier','cashier',$3)",[scope.tenantId,scope.storeId,printer])
  await writeFile(output+'/fixture.json',JSON.stringify({products,roles:store.employees.filter(e=>staff[e.code]).map(e=>({code:e.code,roles:e.roleCodes})),inventory:'both chosen synthetic recipes set tracked',printer:'offline virtual queue'},null,2))
  const servers=['liyan','tom','jerry','tyke']
  for(let i=0;i<tables.length;i++){
    const actor=staff[servers[i%4]!],t=tables[i]
    // Provision each simulated floor actor's assigned tables; opening is a separate permission.
    await db.query('UPDATE mbox.table_assignments SET ends_at=clock_timestamp() WHERE table_id=$1 AND ends_at IS NULL',[t.id])
    const role=(await db.query('SELECT role_id FROM mbox.employee_roles WHERE employee_id=$1 AND ends_at IS NULL LIMIT 1',[actor.employeeId])).rows[0].role_id
    await db.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason) VALUES($1,$2,$3,$4,$5,'primary',clock_timestamp()-interval '1 minute','isolated audit roster')",[scope.tenantId,scope.storeId,t.id,actor.employeeId,role])
    const session=required(await request('open','POST','/api/table-sessions',actor,{tableId:t.id,guestCount:4,employeeId:actor.employeeId},id(`open-${i}`)),'open')
    const context=required(await request('context','POST','/api/commerce/assisted-order-contexts',actor,{tableSessionId:session.id,employeeId:actor.employeeId}),'context')
    sessions.push({...session,code:t.code,actor,context:context.token})
  }
  console.log('fixture ready: 30 tables, 120 guests, 7 staff')
  const serviceFlow=async(s:any,i:number)=>{
    const r=await request('service_create','POST','/api/service-tasks',s.actor,{tableId:s.tableId,tableSessionId:s.id,taskType:i%5===0?'complaint':'water',title:i%5===0?'顾客投诉口味与等待':'顾客加水',priority:i%5===0?'urgent':'normal',employeeId:s.actor.employeeId},id(`service-${i}`))
    if(!r.ok){errors.push({stage:'service',i,status:r.status,body:r.body});return}
    for(const transition of ['acknowledge','start','complete'])required(await request(`service_${transition}`,'POST',`/api/service-tasks/${r.data.id}/${transition}`,s.actor,{employeeId:s.actor.employeeId},id(`service-${i}-${transition}`)),transition)
  }
  const submit=async(i:number)=>{
    const s=sessions[i%30],body={tableSessionId:s.id,employeeId:s.actor.employeeId,items:products.map(p=>({productId:p.id,quantity:1})),settlementMode:'table_tab',note:`独立顾客${i+1}，模拟加单`}
    const r=await request('order_submit','POST','/api/commerce/orders',s.actor,body,id(`order-${i}`),{'x-assisted-order-context':s.context})
    if(!r.ok){errors.push({stage:'order',i,status:r.status,body:r.body});return}
    orders.push({i,s,response:r.body,body,key:id(`order-${i}`)})
  }
  // 120 simultaneous submissions are a stress envelope, not a claim of human operating speed.
  await Promise.all([Promise.all(Array.from({length:120},(_,i)=>submit(i))),...servers.map(code=>lane(sessions.filter(s=>s.actor.code===code),(s,i)=>serviceFlow(s,sessions.indexOf(s))))])
  check('120 orders accepted',orders.length===120,orders.length,120)
  const ids=(await db.query("SELECT id,table_session_id,total_amount_minor FROM mbox.orders WHERE channel='staff_assisted' ORDER BY created_at")).rows
  check('no duplicated orders',ids.length===120,ids.length,120)
  // Lost responses: replay 12 original order keys concurrently.
  await Promise.all(orders.slice(0,12).map(async o=>{const r=await request('order_replay','POST','/api/commerce/orders',o.s.actor,o.body,o.key,{'x-assisted-order-context':o.s.context});check(`order replay ${o.i}`,r.ok,r.status,'2xx')}))
  const tasks=(await db.query('SELECT k.id,k.station_code,k.order_item_id FROM mbox.kds_tasks k ORDER BY k.created_at')).rows
  // Each station has one actor. Payments, two stations and floor service run concurrently.
  await Promise.all([
    ...products.map(p=>lane(tasks.filter(t=>t.station_code===p.station),async t=>{
      const actor=staff[p.station==='bar'?'lengyanzhi':'shenliangliang']
      for(const action of ['start','complete']){const payload={taskId:t.id,action,employeeId:actor.employeeId},key=id(`${action}-${t.id}`);const r=await request(`kds_${action}`,'POST',`/api/commerce/kds/${t.id}/actions`,actor,payload,key);if(!r.ok){errors.push({stage:action,task:t.id,status:r.status,body:r.body});const retry=await request(`kds_${action}_recovery`,'POST',`/api/commerce/kds/${t.id}/actions`,actor,payload,key);check(`kds recovery ${t.id} ${action}`,retry.ok,retry.status,'2xx')}}
      const actor2=staff[['tom','jerry','tyke'][tasks.indexOf(t)%3]!]
      const r=await request('deliver','POST',`/api/commerce/kds/${t.id}/actions`,actor2,{taskId:t.id,action:'deliver',employeeId:actor2.employeeId},id(`deliver-${t.id}`));if(!r.ok)errors.push({stage:'deliver',status:r.status,body:r.body})
    })),
    lane(ids,async(o,i)=>{const body={orderId:o.id,provider:'cash',method:'cash',employeeId:staff.sanmu.employeeId};const r=await request('cash_payment','POST','/api/payments/manual',staff.sanmu,body,id(`cash-${i}`));if(!r.ok)errors.push({stage:'cash',status:r.status,body:r.body});if(i%10===0){const replay=await request('cash_replay','POST','/api/payments/manual',staff.sanmu,body,id(`cash-${i}`));if(!replay.ok)errors.push({stage:'cash-replay',status:replay.status,body:replay.body})}})
  ])
  // Preserve the failed peak snapshot, then model a staff retry with the exact original keys.
  const beforeRecovery=(await db.query("SELECT (SELECT count(*)::int FROM mbox.payments WHERE status='succeeded') paid,(SELECT count(*)::int FROM mbox.order_items WHERE status='delivered') delivered")).rows[0]
  await writeFile(output+'/before-recovery.json',JSON.stringify(beforeRecovery,null,2))
  const unpaid=(await db.query("SELECT id FROM mbox.orders WHERE payment_status='unpaid'")).rows
  for(const o of unpaid){const index=ids.findIndex(row=>row.id===o.id);required(await request('cash_sequential_recovery','POST','/api/payments/manual',staff.sanmu,{orderId:o.id,provider:'cash',method:'cash',employeeId:staff.sanmu.employeeId},id(`cash-${index}`)),'cash sequential recovery')}
  for(const t of tasks){
    const current=(await db.query('SELECT k.status,i.status item_status FROM mbox.kds_tasks k JOIN mbox.order_items i ON i.id=k.order_item_id WHERE k.id=$1',[t.id])).rows[0]
    if(current.item_status==='delivered')continue
    const actor=staff[t.station_code==='bar'?'lengyanzhi':'shenliangliang']
    if(current.status!=='ready'&&current.status!=='completed')required(await request('kds_complete_sequential_recovery','POST',`/api/commerce/kds/${t.id}/actions`,actor,{taskId:t.id,action:'complete',employeeId:actor.employeeId},id(`complete-${t.id}`)),'complete sequential recovery')
    const deliverer=staff[['tom','jerry','tyke'][tasks.indexOf(t)%3]!]
    required(await request('deliver_sequential_recovery','POST',`/api/commerce/kds/${t.id}/actions`,deliverer,{taskId:t.id,action:'deliver',employeeId:deliverer.employeeId},id(`deliver-${t.id}`)),'deliver sequential recovery')
  }
  const after=(await db.query(`SELECT (SELECT count(*)::int FROM mbox.orders) orders,(SELECT count(*)::int FROM mbox.payments WHERE status='succeeded') payments,(SELECT count(*)::int FROM mbox.reconciliation_entries WHERE entry_type='payment') receipts,(SELECT sum(total_amount_minor)::text FROM mbox.orders) gross,(SELECT sum(amount_minor)::text FROM mbox.reconciliation_entries WHERE entry_type='payment') ledger,(SELECT count(*)::int FROM mbox.order_items WHERE status='delivered') delivered,(SELECT count(*)::int FROM mbox.service_tasks WHERE status='completed') services`)).rows[0]
  check('payment count',after.payments===120,after.payments,120);check('ledger count',after.receipts===120,after.receipts,120);check('paid amount equals ledger',after.gross===after.ledger,after, 'gross=ledger');check('delivered lines',after.delivered===240,after.delivered,240)
  const stock=(await db.query('SELECT inventory_item_id,on_hand_quantity::text,reserved_quantity::text FROM mbox.inventory_balances WHERE inventory_item_id=ANY($1::uuid[])',[products.map(p=>p.inventory)])).rows
  for(const row of stock)check(`stock ${row.inventory_item_id}`,Number(row.on_hand_quantity)===9880&&Number(row.reserved_quantity)===0,row,{on_hand:9880,reserved:0})
  console.log('staff phase finished',JSON.stringify({after,errors:errors.length}))
  // Refund 12 customer complaints; requester and cashier decision maker are different people.
  for(const [i,o] of ids.slice(0,12).entries()){
    const p=(await db.query('SELECT id FROM mbox.payments WHERE order_id=$1 AND status=\'succeeded\'',[o.id])).rows[0]
    const line=(await db.query('SELECT id,total_amount_minor FROM mbox.order_items WHERE order_id=$1 ORDER BY created_at LIMIT 1',[o.id])).rows[0]
    const r=await request('refund_request','POST',`/api/payments/${p.id}/refunds`,staff.liyan,{reason:'口味投诉服务补偿，保留实际商品',purpose:'service_compensation',allocations:[{orderItemId:line.id,amountMinor:100}]},id(`refund-${i}`))
    if(!r.ok){errors.push({stage:'refund-request',status:r.status,body:r.body});continue}
    const rid=r.data.id
    for(const step of ['approve','execute','manual-result']){
      const body=step==='manual-result'?{succeeded:true,receiptReference:`AUDIT-REFUND-${i}`}:{reason:'独立审核顾客投诉补偿'}
      const result=await request(`refund_${step}`,'POST',`/api/refunds/${rid}/${step}`,staff.sanmu,body,id(`refund-${i}-${step}`))
      if(!result.ok){errors.push({stage:`refund-${step}`,status:result.status,body:result.body});break}
      if(step==='manual-result')required(await request('refund_replay','POST',`/api/refunds/${rid}/${step}`,staff.sanmu,body,id(`refund-${i}-${step}`)),'refund replay')
    }
  }
  // Virtual print queue only; no bridge or physical receipt is present.
  for(const s of sessions.slice(0,6)){
    const r=await request('bill','POST',`/api/hardware/table-sessions/${s.id}/bill`,staff.sanmu,{},id(`bill-${s.id}`))
    if(!r.ok)errors.push({stage:'bill',status:r.status,body:r.body})
    else required(await request('bill_replay','POST',`/api/hardware/table-sessions/${s.id}/bill`,staff.sanmu,{},id(`bill-${s.id}`)),'bill replay')
  }
  // 120 independent scanned devices on the same 30 four-person tables.
  const day=(await db.query("SELECT to_char(mbox.current_operating_business_date($1,$2),'YYYY-MM-DD') d",[scope.tenantId,scope.storeId])).rows[0].d
  const qrs=await new TableQrProvisioner(runtime.transactions,secret).provision({scope,businessDate:day,actorEmployeeId:staff.liyan.employeeId,tableCodes:sessions.map(s=>s.code),reason:'隔离120顾客并发扫码模拟'})
  const scanFailures:number[]=[]
  const scan=async(i:number,recovery=false)=>{
    const s=sessions[i%30],qr=qrs.find(q=>q.tableId===s.tableId)!,device=`audit120-guest-device-${i}`
    const r=await request(recovery?'guest_scan_recovery':'guest_scan','POST','/api/guest/session/scan',{device},{tableQrToken:qr.tableQrToken,deviceKey:device})
    if(!r.ok||!r.data.sessionToken){errors.push({stage:recovery?'guest-scan-recovery':'guest-scan',i,status:r.status,body:r.body});if(!recovery)scanFailures.push(i);return}
    guests.push({i,s,device,token:r.data.sessionToken})
  }
  await Promise.all(Array.from({length:120},(_,i)=>scan(i)))
  check('120 simultaneous scans first-attempt',scanFailures.length===0,{accepted:guests.length,failed:scanFailures.length},'120 accepted')
  for(const i of scanFailures)await scan(i,true)
  check('120 guest identities',guests.length===120,guests.length,120)
  // Each table has four distinct devices adding items; checkout races below use one shared version.
  for(let round=0;round<4;round++){
    await Promise.all(sessions.map(async s=>{
      const g=guests.find(g=>g.s.id===s.id&&Math.floor(g.i/30)===round)
      if(!g)return
      let cart=required(await request('cart_read','GET','/api/guest/shared-cart',g),'cart')
      for(const p of products){
        const r=await request('cart_add','POST','/api/guest/shared-cart/lines',g,{productId:p.id,delta:1,expectedGeneration:cart.generation,expectedVersion:cart.version},id(`cart-${g.i}-${p.station}`))
        if(!r.ok){errors.push({stage:'cart-add',status:r.status,body:r.body});break}
        cart=r.data
      }
    }))
  }
  await Promise.all(sessions.map(async s=>{
    const group=guests.filter(g=>g.s.id===s.id);if(group.length!==4)return
    const cart=required(await request('cart_read','GET','/api/guest/shared-cart',group[0]),'cart')
    check(`cart quantities ${s.code}`,cart.lines.reduce((n:number,l:any)=>n+l.quantity,0)===8,cart.lines.map((l:any)=>({q:l.quantity})),8)
    const results=await Promise.all(group.map(g=>request('guest_checkout_race','POST','/api/guest/shared-cart/checkout',g,{expectedGeneration:cart.generation,expectedVersion:cart.version},id(`checkout-${g.i}`))))
    check(`one checkout ${s.code}`,results.filter(r=>r.ok).length===1,results.map(r=>({status:r.status,code:r.body.error?.code})), '1 accepted,3 stale conflicts')
  }))
  const snapshot=(await db.query(`SELECT (SELECT count(*)::int FROM mbox.orders) orders,(SELECT count(*)::int FROM mbox.payments) payments,(SELECT count(*)::int FROM mbox.refunds WHERE status='succeeded') refunds,(SELECT count(*)::int FROM mbox.reconciliation_entries WHERE entry_type='refund') refund_entries,(SELECT COALESCE(sum(amount_minor),0)::text FROM mbox.reconciliation_entries WHERE entry_type='refund') refund_minor,(SELECT count(*)::int FROM mbox.print_jobs) print_jobs,(SELECT count(*)::int FROM mbox.outbox_messages WHERE delivered_at IS NULL) pending_outbox`)).rows[0]
  check('12 distinct refunds',snapshot.refunds===12&&snapshot.refund_entries===12&&snapshot.refund_minor==='-1200',snapshot,'12 refunds,ledger -1200 minor');check('30 shared-cart orders exactly once',snapshot.orders===150,snapshot.orders,150)
  check('print replay does not duplicate jobs',snapshot.print_jobs===6,snapshot.print_jobs,6)
  const finalMoney=(await db.query("SELECT (SELECT count(*)::int FROM mbox.payments WHERE status='pending') pending,(SELECT COALESCE(sum(amount_minor),0)::text FROM mbox.reconciliation_entries WHERE entry_type='payment') received,(SELECT COALESCE(sum(amount_minor),0)::text FROM mbox.reconciliation_entries) net,(SELECT count(*)::int FROM mbox.kds_tasks) kds_tasks")).rows[0]
  const finalStock=(await db.query('SELECT on_hand_quantity::text,reserved_quantity::text FROM mbox.inventory_balances WHERE inventory_item_id=ANY($1::uuid[])',[products.map(p=>p.inventory)])).rows
  check('unpaid guest checkout is not a receipt',finalMoney.pending===30&&finalMoney.received===after.ledger,finalMoney,{pending:30,received:after.ledger})
  check('unpaid guest checkout does not release KDS',finalMoney.kds_tasks===240,finalMoney.kds_tasks,240)
  check('refund net equals actual ledger',Number(finalMoney.net)===Number(after.ledger)-1200,finalMoney.net,Number(after.ledger)-1200)
  check('guest pending inventory reserved only',finalStock.every(r=>Number(r.on_hand_quantity)===9880&&Number(r.reserved_quantity)===120),finalStock,{on_hand:9880,reserved:120})
  await writeFile(output+'/snapshot.json',JSON.stringify({after,stock,snapshot,finalMoney,finalStock},null,2))
}catch(e){errors.push({stage:'fatal',message:String(e),stack:(e as Error).stack});console.error(e);process.exitCode=1}
finally{
  const grouped=Object.fromEntries([...new Set(observations.map(o=>o.label))].map(label=>{const rows=observations.filter(o=>o.label===label),times=rows.map(o=>o.ms).sort((a,b)=>a-b);return[label,{count:rows.length,statuses:rows.reduce((a,o)=>(a[o.status]=(a[o.status]??0)+1,a),{}),p95:times[Math.ceil(times.length*.95)-1],p99:times[Math.ceil(times.length*.99)-1]}]}))
  await writeFile(output+`/run-${name}.json`,JSON.stringify({startedAt,finishedAt:new Date().toISOString(),source:'77744bc4e9ed308546b630590bdfa5dfe5ce5b7d',mode:'isolated_local_http_postgres',staff:7,tables:30,guests:120,workersEnabled:false,maxActive,grouped,checks,errors,databaseTelemetry:runtime?.databaseTelemetry(),observations},null,2))
  console.log(JSON.stringify({database:name,requests:observations.length,checks:checks.length,failed:checks.filter(c=>!c.passed),errors},null,2))
  if(checks.some(c=>!c.passed)||errors.length)process.exitCode=1
  await runtime?.app.close();if(connected)await db.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end()
}
