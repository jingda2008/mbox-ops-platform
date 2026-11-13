import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWebsiteContent} from '../lib/mbox/website-content.js';
import {shanghaiDate} from '../public/performance-model.js';
import pages from '../data/pages.json' with {type:'json'};
const langs=['zh','en','ru','ja','ko','fr','de'];
const date='2026-11-13';
const payload={timezone:'Asia/Shanghai',localDate:date,schedules:[{performerStageName:'Test <voice>',startsAt:date+'T23:45:00+08:00',endsAt:'2026-11-14T00:30:00+08:00',status:'scheduled'},{performerStageName:'Cancelled singer',startsAt:date+'T20:30:00+08:00',endsAt:date+'T21:00:00+08:00',status:'cancelled'}]};
test('all language homes expose verified contact and visitor facts without claiming unknown opening hours or card acceptance',()=>{
 for(const lang of langs){
  const html=pages['/'+lang+'/'];assert.equal((html.match(/id="visit-facts"/g)||[]).length,1);
  assert.ok(html.includes('176 2139 2152'));assert.ok(!html.includes('61106528'));
  assert.ok(html.includes(`href="/${lang}/reserve/"`));assert.ok(html.includes(`href="/${lang}/menu/"`));
  assert.ok(!html.includes('"openingHours"'));assert.ok(!html.includes('"paymentAccepted"'));
 }
});
test('date permalink stays fixed in seven languages with canonical, alternates, escaped names and overnight end date',async()=>{
 let calls=0;const serve=createWebsiteContent(async(url,options)=>{calls++;assert.ok(url.endsWith('date='+date));assert.deepEqual(options.headers,{accept:'application/json'});return Response.json(payload)});
 for(const lang of langs){
  const path=`/${lang}/performances/${date}/`,response=await serve(new Request('https://www.shmbox.com'+path,{headers:{cookie:'private',authorization:'private'}}));
  assert.equal(response.status,200);const html=await response.text();
  assert.ok(html.includes(`rel="canonical" href="https://www.shmbox.com${path}"`));
  for(const l of langs)assert.ok(html.includes(`hreflang="${l}" href="https://www.shmbox.com/${l}/performances/${date}/"`));
  assert.equal((html.match(/<h1[ >]/g)||[]).length,1);assert.match(html,/<h1>[^<]*2026-11-13/);
  assert.ok(!html.includes('/performance.js'));assert.ok(!html.includes('id="schedule-refresh"'));assert.ok(!html.includes('class="hero"'));
  assert.ok(html.includes('Test &lt;voice&gt;'));assert.ok(!html.includes('Cancelled singer'));assert.ok(html.includes('2026-11-14T00:30:00+08:00'));
  assert.ok(html.includes(`value="/${lang}/performances/${date}/"`));assert.ok(html.includes(`href="/${lang}/#live"`));
 }
 assert.equal(calls,1);
 const head=await serve(new Request(`https://www.shmbox.com/en/performances/${date}/`,{method:'HEAD'}));assert.equal(await head.text(),'');
});
test('invalid calendar date is rejected without an upstream call and unsupported methods never render a programme',async()=>{
 let calls=0;const serve=createWebsiteContent(async()=>{calls++;throw Error()});
 assert.equal((await serve(new Request('https://www.shmbox.com/en/performances/2026-02-30/'))).status,404);
 assert.equal(await serve(new Request(`https://www.shmbox.com/en/performances/${date}/`,{method:'POST'})),null);assert.equal(calls,0);
});
test('dated programme distinguishes empty response, wrong-date data and unavailable upstream',async()=>{
 const url=`https://www.shmbox.com/en/performances/${date}/`;
 const empty=createWebsiteContent(async()=>Response.json({...payload,schedules:[]}));const ok=await empty(new Request(url));assert.equal(ok.status,200);assert.match(await ok.text(),/No published, non-cancelled performances for this date/);
 for(const send of [async()=>{throw Error('offline')},async()=>Response.json({...payload,localDate:'2026-11-12'})]){
  const r=await createWebsiteContent(send)(new Request(url));assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'60');assert.equal(r.headers.get('x-robots-tag'),'noindex');const h=await r.text();assert.ok(!h.includes('Test &lt;voice&gt;'));assert.match(h,/<div class="schedule" id="schedule-list"><\/div>/);
 }
});
test('homepage exposes a current-date heading and matching permanent link in server HTML',async()=>{
 const today=shanghaiDate();const serve=createWebsiteContent(async()=>Response.json({...payload,localDate:today,schedules:[]}));
 for(const lang of langs){const html=await(await serve(new Request(`https://www.shmbox.com/${lang}/`))).text();assert.ok(html.includes(`href="/${lang}/performances/${today}/"`));assert.match(html,new RegExp('id="schedule-title">[^<]*'+today));}
});
test('initial reservation HTML does not tell a first-time visitor they already have an uncertain submission',async()=>{
 for(const lang of langs)for(const folder of ['public','aliyun/public-overrides']){
  const html=await readFile(new URL(`../${folder}/${lang}/reserve/index.html`,import.meta.url),'utf8');
  const messages=JSON.parse(html.match(/id="booking-messages" type="application\/json">(.*?)<\/script>/s)[1]);
  const body=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');assert.ok(!body.includes(messages.uncertain));assert.match(body,/<p id="booking-recovery-note"><\/p>/);assert.ok(body.includes('id="booking-recover"'));
 }
});
