import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/event-card-v3-20261022/activity-recovery-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-activity-ui-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/activity-recovery-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true}),results=[]
async function run(name,fn){const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'passed'});console.log('PASS',name)}catch(e){results.push({name,status:'failed',message:String(e)});await page.screenshot({path:join(output,`failure-${results.length}.png`),fullPage:true});console.error('FAIL',name,e)}finally{await context.close()}}
async function waitEnabled(page,name){await page.getByRole('button',{name,exact:true}).waitFor();await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent===label&&!b.disabled),name)}
try{
await run('unknown production recovery requires current board and respects blocked',async page=>{
 await page.addInitScript(()=>{localStorage.setItem('mbox.staff-command.v1:activity-production:pickup:'+ 'a'.repeat(64),JSON.stringify({key:'original-key-A',body:{action:'take',lines:[{lineId:'10000000-0000-4000-8000-000000000001',quantity:1,expectedVersion:1}]}}))})
 await page.goto(url);await page.evaluate(()=>window.activityHarness.render({blocked:true}));
 await page.getByRole('button',{name:'恢复原操作',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'恢复原操作',exact:true}).isDisabled(),true)
 await page.evaluate(()=>{window.activityHarness.gate(true);window.activityHarness.render({owner:'B'})});
 await page.evaluate(()=>window.activityHarness.render({owner:'A',blocked:false}));
 await page.getByText('网络暂时无法读取',{exact:false}).waitFor();const unavailable=page.getByRole('button',{name:'恢复原操作',exact:true});assert.equal(await unavailable.count()===0||await unavailable.isDisabled(),true)
 await page.evaluate(()=>window.activityHarness.gate(false));await page.getByRole('button',{name:'重新读取',exact:true}).click();await waitEnabled(page,'恢复原操作');await page.getByRole('button',{name:'恢复原操作',exact:true}).click()
 await page.waitForFunction(()=>window.activityHarness.calls.length===1);assert.equal((await page.evaluate(()=>window.activityHarness.calls))[0].key,'original-key-A')
 await page.evaluate(()=>window.activityHarness.resolve('A'));await page.getByText('本批已取走，按餐号送餐，无需再点手机',{exact:false}).waitFor()
})
await run('late production receipt cannot replace another owner board or expose undo there',async page=>{
 await page.goto(url);await page.getByRole('button',{name:/核对本批取走/}).click();await page.getByRole('button',{name:'本批已取走',exact:true}).click();await page.waitForFunction(()=>window.activityHarness.calls.length===1)
 await page.evaluate(()=>window.activityHarness.render({owner:'B'}));await page.getByText('餐号 23',{exact:true}).waitFor();await page.evaluate(()=>window.activityHarness.resolve('A'));await page.waitForTimeout(120)
 assert.equal(await page.getByText('餐号 12',{exact:true}).count(),0);assert.equal(await page.getByText('核对所选原批次 · 餐号 12',{exact:true}).count(),0)
 assert.equal((await page.evaluate(()=>window.activityHarness.calls)).length,1)
 await page.screenshot({path:join(output,'scope-isolation.png'),fullPage:true})
})
await run('same employee new login discovers old journal and sends explicit original-session recovery',async page=>{
 await page.goto(url);await page.evaluate(()=>window.activityHarness.dropProduction());await page.getByRole('button',{name:/核对本批取走/}).click();await page.getByRole('button',{name:'本批已取走',exact:true}).click();await page.getByRole('button',{name:'恢复原操作',exact:true}).waitFor()
 const first=(await page.evaluate(()=>window.activityHarness.calls))[0]
 await page.evaluate(()=>window.activityHarness.render({login:2}));await page.getByText('发现本机原登录的取餐记录',{exact:false}).waitFor();await waitEnabled(page,'恢复原操作');await page.getByRole('button',{name:'恢复原操作',exact:true}).click();await page.getByText('本批已取走，按餐号送餐，无需再点手机',{exact:false}).waitFor()
 const calls=await page.evaluate(()=>window.activityHarness.calls);assert.equal(calls.length,2);assert.equal(calls[1].kind,'recovery');assert.equal(calls[1].key,first.key);assert.deepEqual(calls[1].body,first.body)
 assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('mbox.activity-pickup-origin'))),[])
 await page.screenshot({path:join(output,'same-employee-login-recovery.png'),fullPage:true})
})
await run('manager lost exception receipt restores original key and never creates a second intent',async page=>{
 await page.goto(url);await page.evaluate(()=>{window.activityHarness.render({kind:'exception'});window.activityHarness.dropException()})
 await page.getByLabel('原菜品',{exact:true}).selectOption('10000000-0000-4000-8000-000000000001');await page.getByLabel('处理原因',{exact:true}).fill('先核对过敏原');await page.getByRole('button',{name:'确认暂停本菜',exact:true}).click()
 await page.getByRole('button',{name:'恢复原异常操作',exact:true}).waitFor();assert.equal(await page.getByLabel('原菜品',{exact:true}).count(),0)
 const first=(await page.evaluate(()=>window.activityHarness.calls)).at(-1)
 await page.evaluate(()=>window.activityHarness.render({mount:false}));await page.evaluate(()=>window.activityHarness.render({mount:true}));await page.getByRole('button',{name:'恢复原异常操作',exact:true}).click()
 await page.getByText('暂停本菜已登记',{exact:false}).waitFor();const records=await page.evaluate(()=>window.activityHarness.calls.filter(c=>c.kind==='exception'))
 assert.equal(records.length,2);assert.equal(records[1].key,first.key);assert.deepEqual(records[1].body,first.body)
 await page.getByLabel('原菜品',{exact:true}).selectOption('10000000-0000-4000-8000-000000000001');assert.equal(await page.getByLabel('处理方式',{exact:true}).inputValue(),'resume')
 await page.screenshot({path:join(output,'manager-exception-recovery.png'),fullPage:true})
})
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'local-browser-component-fault-injection',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
