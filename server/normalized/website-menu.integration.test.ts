import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {describe,it,expect} from 'vitest'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {websiteMenuApiPlugin} from './website-menu-api.js'
const integration=process.env.TEST_NORMALIZED_DATABASE_URL?describe:describe.skip
integration('website menu real isolated PostgreSQL',()=>{
 it('enforces store and publication scope, standard price, sold-out status and complete snapshots',async()=>{
  const admin=new Pool({connectionString:process.env.TEST_NORMALIZED_DATABASE_URL});const runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL});const tenantId=randomUUID(),storeId=randomUUID(),otherStore=randomUUID();const scope={tenantId,storeId};const app=Fastify();
  try{
   await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Website test')",[tenantId,'web-'+tenantId]);
   for(const id of [storeId,otherStore])await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,$3,'Website test','Asia/Shanghai','06:00')",[id,tenantId,'web-'+id]);
   await admin.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,display_name,guest_visible) VALUES($1,$2,'web-parent','测试大类',true)",[tenantId,storeId]);
   await admin.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,display_name,parent_code,guest_visible) VALUES($1,$2,'web-child','测试子类','web-parent',true)",[tenantId,storeId]);
   const ids=[];for(let i=0;i<188;i++){
    const id=randomUUID();ids.push(id);
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,guest_visible,status,menu_sort_order) VALUES($1,$2,$3,$4,$5,'web-child','none','not_managed',$6,'active',$7)",[id,tenantId,i===187?otherStore:storeId,'WEB'+i,'公开商品'+i,i!==186,i]);
    await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',5850,'CNY',clock_timestamp()-interval '1 minute'),($1,$2,$3,'member',1,'CNY',clock_timestamp()-interval '1 minute')",[tenantId,i===187?otherStore:storeId,id]);
   }
   await app.register(websiteMenuApiPlugin,{prefix:'/api',scope,transactions:new ScopedPostgresTransactionRunner(runtime as never)});
   const get=async()=>{const r=await app.inject('/api/public/website/menu');expect(r.statusCode,r.body).toBe(200);return r.json().data};
   const a=await get();expect(a.products).toHaveLength(186);expect(a.products.every((p:any)=>p.amountMinor===5850)).toBe(true);expect(a.products.some((p:any)=>[ids[186],ids[187]].includes(p.id))).toBe(false);
   await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[ids[0]]);const sold=await get();expect(sold.products.find((p:any)=>p.id===ids[0]).availability).toBe('unavailable');
   await admin.query("UPDATE mbox.products SET status='inactive' WHERE id=$1",[ids[0]]);const removed=await get();expect(removed.products).toHaveLength(185);expect(removed.version).not.toBe(a.version);
   await admin.query("UPDATE mbox.product_prices SET amount_minor=6011 WHERE product_id=$1 AND price_type='standard'",[ids[1]]);expect((await get()).products.find((p:any)=>p.id===ids[1]).amountMinor).toBe(6011);
   await admin.query("UPDATE mbox.menu_categories SET guest_visible=false WHERE tenant_id=$1 AND store_id=$2 AND code='web-parent'",[tenantId,storeId]);expect((await get()).products).toEqual([]);
   expect(Number((await admin.query('SELECT count(*) n FROM mbox.customers WHERE tenant_id=$1',[tenantId])).rows[0].n)).toBe(0);
  }finally{await app.close();await runtime.end();await admin.end()}
 },30000)
})
