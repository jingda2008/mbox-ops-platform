import Fastify from 'fastify'
import { describe,it,expect,vi } from 'vitest'
import { websiteMenuApiPlugin,websiteProduct } from './website-menu-api.js'
import { publicCatalogProduct } from './guest-commerce-service-api.js'
const scope={tenantId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222'}
const row=(i=0)=>({id:`55555555-5555-4555-8555-${String(i).padStart(12,'0')}`,code:`P${i}`,name:'测试商品',category_code:'beer',category_name:'啤酒',category_parent_name:null,category_sort_order:1,top_category_sort_order:1,product_snapshot:{imageUrl:'/menu/test.jpg'},amount_minor:'5850',currency:'CNY',guest_visible:true,status:'active',product_kind:'single',menu_sort_order:i,inventory_configuration_complete:true,inventory_available:true,within_availability:true,bundle_choice_groups:[],cost_amount_minor:10,customer_phone:'SECRET'} as never)
async function fixture(rows:any[]=[],reject=false){
 const query=vi.fn(async(sql:string,values:any[])=>{if(sql.includes('SET LOCAL'))return {rows:[],rowCount:0};if(reject)throw Error('db secret');return {rows,rowCount:rows.length}})
 const run=vi.fn(async(s:any,fn:any)=>fn({scope:s,query}));const app=Fastify();await app.register(websiteMenuApiPlugin,{prefix:'/api',scope,transactions:{run} as never});return {app,query,run}
}
describe('anonymous website menu publication',()=>{
 it('returns a complete >100-row whitelist snapshot with fixed scope and no identity',async()=>{
  const f=await fixture(Array.from({length:187},(_,i)=>row(i)));const r=await f.app.inject({url:'/api/public/website/menu',headers:{'x-store-id':'foreign',cookie:'customer=foreign'}});expect(r.statusCode).toBe(200);const d=r.json();expect(d.data.products).toHaveLength(187);expect(d.meta.complete).toBe(true);expect(d.data.products[0].amountMinor).toBe(5850);expect(r.body).not.toMatch(/SECRET|cost_amount|customer_phone|recommendation/);expect(f.run.mock.calls[0]?.[0]).toEqual(scope);const params=f.query.mock.calls[1]?.[1];expect(params?.[2]).toBeNull();expect(params?.[6]).toBe(2001);expect(params?.[8]).toBeNull();expect(f.query.mock.calls[1]?.[0]).toContain("price_type = 'standard'");await f.app.close()
 });
 it('rejects caller scope/pagination and does not create guest sessions',async()=>{
  const f=await fixture();expect((await f.app.inject('/api/public/website/menu?storeId=other')).statusCode).toBe(400);expect(f.run).not.toHaveBeenCalled();expect((await f.app.inject({method:'POST',url:'/api/public/website/menu'})).statusCode).toBe(404);await f.app.close()
 });
 it('distinguishes empty success from unavailable and refuses truncation',async()=>{
  for(const [rows,reject,status] of [[[],false,200],[[],true,503],[Array.from({length:2001},(_,i)=>row(i)),false,503]] as const){const f=await fixture([...rows],reject);const r=await f.app.inject('/api/public/website/menu');expect(r.statusCode).toBe(status);if(status===200)expect(r.json().data.products).toEqual([]);else expect(r.body).not.toContain('db secret');await f.app.close()}
 });
 it('never publishes hidden products, arbitrary image URLs or invalid prices',()=>{
  const p=publicCatalogProduct(row());expect(websiteProduct({...p,guestVisible:false})).toBeNull();expect(websiteProduct({...p,imageUrl:'https://evil.test/x.jpg'})?.imageUrl).toBeNull();for(const amountMinor of [null,-1,NaN,0.5])expect(()=>websiteProduct({...p,amountMinor})).toThrow();expect(()=>websiteProduct({...p,currency:'USD'})).toThrow();expect(websiteProduct({...p,amountMinor:0})?.amountMinor).toBe(0)
 });
 it('version changes on price, removal and availability; no stale backend fallback',async()=>{
  const rows=[row()];const f=await fixture(rows);const a=(await f.app.inject('/api/public/website/menu')).json().data;Object.assign(rows[0] as object,{amount_minor:'6001',inventory_available:false});const b=(await f.app.inject('/api/public/website/menu')).json().data;expect(a.version).not.toBe(b.version);expect(b.products[0].availability).toBe('unavailable');rows.pop();const c=(await f.app.inject('/api/public/website/menu')).json().data;expect(c.products).toEqual([]);await f.app.close()
 });
})
