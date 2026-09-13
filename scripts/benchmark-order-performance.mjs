import {mkdirSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {createOrderPage} from './test-support/order-performance-harness.mjs'
const directory='artifacts/order-performance-20260914'
const reports=[]
const summarize=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return {samples:values.length,failures:values.length-sorted.length,failureRate:(values.length-sorted.length)/values.length,medianMs:sorted[Math.ceil(sorted.length/2)-1]??null,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null}}
for(const platform of ['miniprogram','alipay-miniprogram'])for(const scenario of ['first_scan','reentry','switch_table','light_load']) {
 const buckets={before:{menu:[],ready:[],add:[],submit:[]},after:{menu:[],ready:[],add:[],submit:[]}}
 for(let i=0;i<30;i++)for(const baseline of [true,false]) {
  const mode=baseline?'before':'after';const delays={identity:5,menu:15,cart:25,orders:30,optional:scenario==='light_load'?0:250,add:25,submit:50}
  const h=createOrderPage({platform,baseline,delays})
  try {
   if(scenario==='reentry'||scenario==='switch_table'){await h.page.preparePage();await h.page.orderExtrasPending}
   if(scenario==='switch_table')h.state.session={tableCode:'B02',tableToken:'test-b',cartScope:'scope-b',scanNonce:'scan-b'}
   h.state.timings={};const start=Date.now();await h.page.preparePage()
   buckets[mode].menu.push(h.state.timings.menu-start);buckets[mode].ready.push((h.state.timings.ready??Date.now())-start)
   assert.equal(h.page.data.visibleProducts.length,180);assert.equal(h.page.data.table.code,h.state.session.tableCode)
   const addStart=Date.now();await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.page.data.cartCount,1);assert.equal(h.page.data.cartTotal,'¥8.00');buckets[mode].add.push(Date.now()-addStart)
   const submitStart=Date.now();await h.page.submitOrder(null,false);assert.equal(h.state.calls.filter(x=>x==='submit').length,1);buckets[mode].submit.push(Date.now()-submitStart)
  }catch(error){for(const stage of Object.keys(buckets[mode]))if(buckets[mode][stage].length<=i)buckets[mode][stage].push(null);process.stderr.write(`${platform}/${scenario}/${mode}: ${error.message}\n`)}finally{h.dispose()}
 }
 const before=Object.fromEntries(Object.entries(buckets.before).map(([k,v])=>[k,summarize(v)])),after=Object.fromEntries(Object.entries(buckets.after).map(([k,v])=>[k,summarize(v)]))
 const passed=Object.entries(after).every(([stage,v])=>v.failures===0&&(scenario==='light_load'?v.p95Ms<=before[stage].p95Ms*1.1+50:stage==='menu'?v.p95Ms<=80&&v.p95Ms<=before.menu.p95Ms*.4:stage==='ready'?v.p95Ms<=100&&v.p95Ms<=before.ready.p95Ms*.4:stage==='add'?v.p95Ms<=100:true))
 reports.push({platform,scenario,before,after,passed,rawMs:buckets});mkdirSync(directory,{recursive:true});writeFileSync(`${directory}/simulation-comparison.json`,JSON.stringify({generatedAt:new Date().toISOString(),kind:'VM page logic with fixed synthetic API latency; no native rendering, real devices, payment rails or production traffic',menuCount:180,samplesPerScenarioPerVersion:30,diagnosticSubmitBoundary:'submitOrder entry to authority checkout response; native channel payment excluded',reports},null,2)+'\n');process.stdout.write(`${platform}/${scenario}: ${passed?'PASS':'FAIL'} menu ${before.menu.p95Ms}->${after.menu.p95Ms} ready ${before.ready.p95Ms}->${after.ready.p95Ms} add ${before.add.p95Ms}->${after.add.p95Ms}\n`)
}
if(reports.some(x=>!x.passed))process.exitCode=1
