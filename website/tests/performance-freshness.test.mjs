import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteContent} from '../lib/mbox/website-content.js';
import {shanghaiDate} from '../public/performance-model.js';
const langs=['zh','en','ru','ja','ko','fr','de'];
test('server failure hides obsolete schedule from HTML readers in all seven languages',async()=>{
 const serve=createWebsiteContent(async()=>{throw Error('unavailable')});
 for(const lang of langs){
  const html=await (await serve(new Request('https://www.shmbox.com/'+lang+'/'))).text();
  const data=JSON.parse(html.match(/id="performance-snapshot" type="application\/json">(.*?)<\/script>/s)[1]);
  const m=JSON.parse(html.match(/id="performance-messages" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.equal(data.localDate,shanghaiDate());assert.deepEqual(data.schedules,[]);assert.equal(data.unavailable,true);
  assert.ok(html.includes(m.staleLabel));assert.ok(html.includes(m.staleNote));
  assert.match(html,/<div class="schedule" id="schedule-list"><\/div>/);
 }
});
test('confirmed empty current-day programme is distinguished from fetch failure',async()=>{
 const serve=createWebsiteContent(async()=>Response.json({timezone:'Asia/Shanghai',localDate:shanghaiDate(),schedules:[]}));
 const html=await (await serve(new Request('https://www.shmbox.com/en/'))).text();
 const data=JSON.parse(html.match(/id="performance-snapshot" type="application\/json">(.*?)<\/script>/s)[1]);
 assert.equal(data.unavailable,undefined);assert.deepEqual(data.schedules,[]);
 const m=JSON.parse(html.match(/id="performance-messages" type="application\/json">(.*?)<\/script>/s)[1]);
 assert.ok(html.includes(m.empty));
});
