import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeMenu,renderMenu,displayName,publicImage} from '../public/menu-model.js';
import {MENU_COPY} from '../public/menu-copy.js';import {createReader} from '../lib/mbox/content-cache.js';
import {createWebsiteContent,renderPage} from '../lib/mbox/website-content.js';
import pages from '../data/pages.json' with {type:'json'};
const item=(i=0)=>({id:'id-'+i,code:i===0?'CK025':'P'+i,name:'商品'+i,categoryName:'鸡尾酒',imageUrl:'/menu/test.jpg',specification:'150 ml',amountMinor:5850,currency:'CNY',availability:'available'});
const payload=(products=[item()])=>({data:{schemaVersion:1,version:'a'.repeat(64),checkedAt:'2026-10-13T16:00:00Z',currency:'CNY',products},meta:{complete:true,count:products.length}});
test('all 7 languages render the same complete prices, availability, specification and source time',()=>{
 const products=Array.from({length:187},(_,i)=>item(i));products[0].availability='unavailable';const data=normalizeMenu(payload(products));
 for(const [lang,c] of Object.entries(MENU_COPY)){const html=renderMenu(data,lang,c);assert.equal((html.match(/data-product-id=/g)||[]).length,187);assert.match(html,/¥58.50/);assert.ok(html.includes(c.unavailable));assert.ok(html.includes('150 ml'));assert.ok(html.includes(c.checked));}
});
test('translations require same ID and original name; hostile fields never become markup',()=>{
 const p=item();const t={[p.id]:{sourceName:p.name,en:'Reviewed name'}};assert.equal(displayName(p,'en',t),'Reviewed name');assert.equal(displayName({...p,id:'new'},'en',t),p.name);assert.equal(displayName({...p,name:'New name'},'en',t),'New name');
 const html=renderMenu(normalizeMenu(payload([{...p,name:'<script>alert(1)</script>',imageUrl:'https://evil.test/image'}])),'en',MENU_COPY.en);assert.ok(!html.includes('<script>'));assert.equal(publicImage('/menu/../secret.jpg'),null);assert.equal(publicImage('/menu/a.jpg'),'https://mbox.shmbox.com/menu/a.jpg');
});
test('partial, duplicate or invalid snapshots fail; empty success and unavailable differ',()=>{
 for(const x of [{...payload(),meta:{complete:false,count:1}},payload([item(),item()]),payload([{...item(),amountMinor:null}]),payload([{...item(),currency:'USD'}])])assert.throws(()=>normalizeMenu(x));
 assert.ok(renderMenu(normalizeMenu(payload([])),'zh',MENU_COPY.zh).includes(MENU_COPY.zh.empty));assert.ok(renderMenu(null,'zh',MENU_COPY.zh).includes(MENU_COPY.zh.failure));
});
test('SSR replaces all homepage and catalog prices; removal cannot survive in budget or static tiles',()=>{
 for(const lang of Object.keys(MENU_COPY)){for(const path of ['/'+lang+'/','/'+lang+'/menu/']){const html=renderPage(pages[path],lang,normalizeMenu(payload([])));assert.ok(!html.includes('¥98'));assert.ok(!html.includes('¥108'));assert.ok(!html.includes('catalog-price'));assert.ok(!html.includes('menu-mojito-v1'));assert.ok(html.includes(MENU_COPY[lang].empty));}}
});
test('cache coalesces, retains original check time, expires and never revives a removed product after failure',async()=>{
 let time=0,calls=0,body=payload(),fail=false;const read=createReader('https://fixed.test',normalizeMenu,100,async()=>{calls++;if(fail)throw Error('offline');return Response.json(body)},()=>time);
 const [a,b]=await Promise.all([read(),read()]);assert.equal(calls,1);assert.equal(a.checkedAt,b.checkedAt);body=payload([]);time=101;assert.equal((await read()).products.length,0);time=202;fail=true;await assert.rejects(read);time=203;await assert.rejects(read);assert.equal(calls,3);
});
test('disabled website sync never queries unpublished endpoint; enabled route does not forward cookies',async()=>{
 let calls=[];const content=createWebsiteContent(async(url,init)=>{calls.push({url,init});return Response.json(payload())});
 const req=new Request('https://website.test/en/menu/',{headers:{cookie:'secret','authorization':'secret'}});
 const staticPage=await content(req,false);assert.equal(calls.length,0);assert.ok((await staticPage.text()).includes('¥98'));
 const live=await content(req,true);assert.ok((await live.text()).includes('¥58.50'));assert.equal(calls.length,1);assert.deepEqual(calls[0].init.headers,{accept:'application/json'});
 const api=await content(new Request('https://website.test/api/website/menu'),true);assert.equal(normalizeMenu(await api.json()).products.length,1);
});
test('dynamic empty/failure pages keep budget anchor and remove fixed count/translation claims and dated metadata',()=>{
 for(const lang of Object.keys(MENU_COPY))for(const data of [null,normalizeMenu(payload([]))]){
  const home=renderPage(pages['/'+lang+'/'],lang,data);assert.match(home,/id="budget"/);
  const menu=renderPage(pages['/'+lang+'/menu/'],lang,data);assert.ok(menu.includes(MENU_COPY[lang].intro));assert.ok(!menu.includes('187'));assert.ok(!menu.includes('2026-10-13'));assert.ok(!menu.includes('13 October 2026'));
 }
});

test('synchronous fetch failure clears in-flight state and can recover after the retry window',async()=>{
 let time=0,calls=0;const read=createReader('https://fixed.test',normalizeMenu,100,()=>{if(++calls===1)throw TypeError('edge request rejected');return Promise.resolve(Response.json(payload()))},()=>time);
 await assert.rejects(read);time=15001;assert.equal((await read()).products.length,1);assert.equal(calls,2);
});
test('Cloudflare runtime accepts reader requests and redirects remain rejected without following',async()=>{
 const {Miniflare}=await import('miniflare');const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../lib/mbox/content-cache.js',import.meta.url),'utf8');
 const mf=new Miniflare({modules:true,script:source+`
export default {async fetch(){let mode;const read=createReader('https://fixed.test',x=>x,100,async(url,init)=>{mode=new Request(url,init).redirect;return Response.json({ok:true})});const data=await read();const redirected=createReader('https://fixed.test',x=>x,100,async()=>new Response(null,{status:302,headers:{location:'https://elsewhere.test'}}));let rejected=false;try{await redirected()}catch{rejected=true}return Response.json({mode,data,rejected})}}`});
 try{const r=await mf.dispatchFetch('http://localhost/');assert.deepEqual(await r.json(),{mode:'manual',data:{ok:true},rejected:true})}finally{await mf.dispose()}
});
