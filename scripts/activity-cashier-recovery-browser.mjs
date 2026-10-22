import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/event-card-v3-20261022/activity-cashier-browser';await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-activity-cashier-ui-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/activity-cashier-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/?registrationId=one`
const browser=await chromium.launch({headless:true}),results=[]
async function run(name,fn){const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'passed'});console.log('PASS',name)}catch(e){results.push({name,status:'failed',message:String(e)});await page.screenshot({path:join(output,`failure-${results.length}.png`),fullPage:true});console.error('FAIL',name,e)}finally{await context.close()}}
async function fill(page){await page.goto(url);await page.getByRole('combobox',{name:'活动退款处理',exact:true}).selectOption('compensation');await page.getByLabel('本次补偿金额（元）',{exact:true}).fill('12');await page.getByLabel('退款原因',{exact:true}).fill('少送菜品补偿');await page.getByLabel('已与顾客确认退款金额及剩余内容安排',{exact:true}).check()}
try{
 await run('unknown compensation survives full reload with original amount body and key',async page=>{
  await fill(page);await page.getByRole('button',{name:'提交补偿退款申请',exact:true}).click();await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).waitFor()
  assert.equal(await page.getByLabel('本次补偿金额（元）',{exact:true}).count(),0)
  const first=(await page.evaluate(()=>window.cashierHarness.calls))[0];assert.equal(first.body.amountMinor,1200);assert.equal(first.body.disposition,'retain_fulfillment')
  await page.reload();await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).waitFor();await page.evaluate(()=>window.cashierHarness.render({drop:false}))
  await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).click();await page.getByText('原活动退款申请已核对，请按当前审核状态继续。',{exact:true}).waitFor()
  const replay=(await page.evaluate(()=>window.cashierHarness.calls))[0];assert.equal(replay.key,first.key);assert.deepEqual(replay.body,first.body)
  await page.waitForFunction(()=>Object.keys(localStorage).filter(key=>key.includes('activity-refund:')).length===0)
  await page.screenshot({path:join(output,'refund-original-recovery.png'),fullPage:true})
 })
 await run('other registration and another employee cannot inherit or submit the unknown compensation',async page=>{
  await fill(page);await page.getByRole('button',{name:'提交补偿退款申请',exact:true}).click();await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).waitFor()
  await page.locator('[data-cashier-activity-registration-id="two"] .cashier-order-toggle').click();assert.equal(await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).count(),0)
  await page.locator('[data-cashier-activity-registration-id="one"] .cashier-order-toggle').click();await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).waitFor()
  await page.evaluate(()=>window.cashierHarness.render({permitted:false}));await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='恢复原活动退款申请'&&button.disabled));assert.equal(await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).isDisabled(),true)
  await page.evaluate(()=>window.cashierHarness.render({employee:'22222222-2222-4222-8222-222222222222',permitted:true}));await page.getByRole('combobox',{name:'活动退款处理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).count(),0)
  assert.equal((await page.evaluate(()=>window.cashierHarness.calls)).length,1)
 })
 await run('a late compensation receipt cannot restore the previous customer search and its original request remains recoverable',async page=>{
  await fill(page);await page.evaluate(()=>window.cashierHarness.render({drop:false,defer:true}));await page.getByRole('button',{name:'提交补偿退款申请',exact:true}).click();await page.waitForFunction(()=>window.cashierHarness.calls.length===1)
  await page.getByLabel('查找收银订单',{exact:true}).fill('two');await page.getByRole('button',{name:'查找',exact:true}).click();await page.locator('[data-cashier-activity-registration-id="two"]').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-cashier-activity-registration-id="one"]'))
  await page.evaluate(()=>window.cashierHarness.resolve());await page.getByText('已切换收银查询，请回原订单恢复核对',{exact:false}).waitFor();assert.equal(await page.locator('[data-cashier-activity-registration-id="one"]').count(),0)
  await page.getByLabel('查找收银订单',{exact:true}).fill('one');await page.getByRole('button',{name:'查找',exact:true}).click();await page.getByRole('button',{name:'恢复原活动退款申请',exact:true}).click();await page.getByText('原活动退款申请已核对，请按当前审核状态继续。',{exact:true}).waitFor()
  assert.equal((await page.evaluate(()=>window.cashierHarness.calls)).length,1)
 })
 await run('compensation requires positive available amount and renewed customer agreement after disposition changes',async page=>{
  await fill(page);const submit=page.getByRole('button',{name:'提交补偿退款申请',exact:true});assert.equal(await submit.isEnabled(),true)
  await page.getByRole('combobox',{name:'剩余内容安排',exact:true}).selectOption('stop_unstarted');assert.equal(await submit.isDisabled(),true)
  await page.getByLabel('已与顾客确认退款金额及剩余内容安排',{exact:true}).check();assert.equal(await submit.isEnabled(),true)
  assert.ok((await page.locator('body').innerText()).includes('管理者须先在活动异常处理中停妥'))
  await page.getByLabel('本次补偿金额（元）',{exact:true}).fill('100');await page.getByLabel('已与顾客确认退款金额及剩余内容安排',{exact:true}).check();assert.equal(await submit.isDisabled(),true)
  await page.getByLabel('本次补偿金额（元）',{exact:true}).fill('0');await page.getByLabel('已与顾客确认退款金额及剩余内容安排',{exact:true}).check();assert.equal(await submit.isDisabled(),true)
  assert.equal((await page.evaluate(()=>window.cashierHarness.calls)).length,0)
 })
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'local-browser-component-fault-injection',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
