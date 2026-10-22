import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/requirements-20261023/b06-validation'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-b06-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/customer-experience-b06-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),results=[]
const code='MBOX_ACTIVITY_V3:b06-registration:12345678-1234-4234-8234-123456789abc'
async function query(page){await page.getByLabel('会员号或套餐码',{exact:true}).fill(code);await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByRole('heading',{name:'体验核对活动 · 固定套餐'}).waitFor()}
async function run(name,fn){const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await page.goto(url);await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'passed'});console.log('PASS',name)}catch(e){results.push({name,status:'failed',message:String(e)});console.error('FAIL',name,e)}finally{await page.screenshot({path:join(output,`scan-${results.length}.png`),fullPage:true});await context.close()}}
try{
 await run('invalid arrival counts explain the exact range and never submit',async page=>{
  await query(page)
  for(const value of ['0','1.5','6']){await page.getByLabel('本批首次入场人数').fill(value);await page.getByRole('alert').filter({hasText:'请填写 1 至 5 的整数人数'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认本次办理'}).isDisabled(),true)}
  await page.getByLabel('本批首次入场人数').fill('3');assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.getByRole('button',{name:'确认本次办理'}).isEnabled(),true)
  assert.deepEqual(await page.evaluate(()=>window.b06.calls),[])
 })
 await run('verifier sees the next responsible person for returned plaque and missing task recovery',async page=>{
  await page.evaluate(()=>window.b06.set({returned:true}));await query(page)
  await page.getByText('恢复原号码牌需领班或活动管理人员处理，请保留原号。',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'恢复原号码牌',exact:true}).count(),0)
  await page.getByText('制作明细与异常恢复',{exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'核对并恢复缺失任务',exact:true}).isDisabled(),true)
  await page.getByText('当前账号无权恢复缺失任务，请联系领班或活动管理人员核对原号；不要重新核销。',{exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>window.b06.calls),[])
 })
 await run('no-permission original receipt stays recoverable with the same intent and explains handoff',async page=>{
  await page.evaluate(()=>{localStorage.setItem('mbox.activity-door.v3:employee-b06:b06-registration',JSON.stringify({registrationPublicId:'b06-registration',command:{action:'admit',arrivedCount:2},key:'original-b06-key'}));window.b06.set({mode:'read'})})
  await query(page);assert.equal(await page.getByRole('button',{name:'恢复原操作',exact:true}).isDisabled(),true)
  await page.getByText('当前账号无权恢复，请交有活动办理权限的同事或领班核对原操作，勿重新登记。',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mbox.activity-door.v3:employee-b06:b06-registration')).key),'original-b06-key');assert.deepEqual(await page.evaluate(()=>window.b06.calls),[])
 })
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'browser-report.json'),JSON.stringify({kind:'local-real-component-with-api-fixture',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
