import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/staff-employee-recovery-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-employee-recovery-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/staff-employee-recovery-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true}),results=[]
const admin='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',role='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444'
function overview(s){return {generatedAt:new Date().toISOString(),scopeKey:'tenant:store',configurationVersion:'a'.repeat(64),roles:[{id:role,code:'STAFF',name:'员工',status:'active',permissionCodes:[],dataScopes:[],approvalLimits:[],navigation:[],employeeCount:1}],employees:[{id:target,code:'EXISTING',displayName:'Existing staff',status:s.targetStatus,roleCodes:['STAFF'],overrides:[]}],permissions:[],areas:[],configurationDefinitions:[]}}
async function setup(page){
 const s={actor:admin,authorized:true,targetStatus:'active',loss:true,reject:false,readFail:false,afterCommitReadFail:false,delay:null,calls:[],receipts:new Map(),writes:0}
 await page.route('**/api/**',async route=>{
  const req=route.request(),requestPath=new URL(req.url()).pathname,receiptOnly=requestPath.endsWith('/recover'),path=receiptOnly?requestPath.slice(0,-8):requestPath
  const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
  if(!s.authorized)return reply(403,{error:{code:'STAFF_ACCESS_FORBIDDEN',message:'当前账号没有权限管理授权配置',retryable:false}})
  if(req.method()==='GET')return s.readFail?reply(503,{error:{message:'列表读取失败'}}):reply(200,{data:overview(s)})
  const body=req.postDataJSON(),key=req.headers()['idempotency-key'],fingerprint=JSON.stringify({actor:s.actor,path,body})
  s.calls.push({key,body,path:requestPath,actor:s.actor})
  if(s.reject)return reply(400,{error:{code:'PERMISSION_DEPLOYMENT_INVALID',message:'所选岗位不存在或已停用',retryable:false}})
  const old=s.receipts.get(key)
  if(old&&old.fingerprint!==fingerprint)return reply(409,{error:{code:'PERMISSION_DEPLOYMENT_CONFLICT',message:'原请求内容已变化'}})
  if(old)return reply(200,{data:{...old.result,replayed:true}})
  if(receiptOnly)return reply(409,{error:{code:'STAFF_EMPLOYEE_RECEIPT_UNAVAILABLE',message:'原操作回执不存在或已过期，请核对当前记录'}})
  s.writes++
  if(path.endsWith('/status'))s.targetStatus=body.status
  const result={employeeId:target,status:path.endsWith('/status')?body.status:'active',verifiedAt:new Date().toISOString(),replayed:false,overview:overview(s)}
  s.receipts.set(key,{fingerprint,result})
  if(s.afterCommitReadFail)s.readFail=true
  if(s.delay)await s.delay
  if(s.loss){s.loss=false;return route.abort('failed')}
  return reply(path.endsWith('/status')?200:201,{data:result})
 })
 return s
}
async function run(name,fn){const context=await browser.newContext(),page=await context.newPage(),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));try{const state=await setup(page);await page.goto(url);await page.getByText('员工账号管理',{exact:true}).waitFor();await fn(page,state);assert.deepEqual(errors,[]);results.push({name,status:'passed'});console.log('PASS',name)}catch(error){results.push({name,status:'failed',message:String(error)});await page.screenshot({path:join(output,`failure-${results.length}.png`),fullPage:true});console.error('FAIL',name,error)}finally{await context.close()}}
async function fillCreate(page){await page.getByText('员工账号管理',{exact:true}).click();await page.getByLabel('员工账号',{exact:true}).fill('LOCAL');await page.getByLabel('员工姓名',{exact:true}).fill('Local new staff');await page.getByLabel('初始PIN',{exact:true}).fill('4826')}
async function pending(page){await page.getByText('员工操作结果尚未确认',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).waitFor()}
async function saved(page){return page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('mbox.staff-employee-intent.v1:')))}
try {
 await run('lost create response survives reload, wrong PIN conflicts, original PIN recovers once',async(page,s)=>{
  await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await pending(page)
  assert.equal(await page.getByLabel('员工姓名',{exact:true}).isDisabled(),true)
  const original=s.calls[0],records=await saved(page);assert.equal(records.length,1);assert.ok(!Object.values(JSON.parse(records[0][1]).operation.body).includes('4826'));assert.ok(!JSON.stringify(records).includes('"pin"'))
  await page.reload();await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).waitFor();assert.equal(await page.getByLabel('原创建PIN',{exact:true}).inputValue(),'')
  await page.getByLabel('原创建PIN',{exact:true}).fill('7391');await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await pending(page);assert.equal(s.calls.at(-1).key,original.key);assert.equal((await saved(page)).length,1)
  await page.getByLabel('原创建PIN',{exact:true}).fill('4826');await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await page.getByText('原员工操作已确认',{exact:true}).waitFor()
  assert.deepEqual(s.calls.at(-1),{...original,path:`${original.path}/recover`});assert.equal(s.writes,1);assert.deepEqual(await saved(page),[])
 })
 await run('lost status response recovers old target but refreshes later current status',async(page,s)=>{
  await page.getByText('员工账号管理',{exact:true}).click();await page.getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('button',{name:'确认停用',exact:true}).click();await pending(page)
  const original=s.calls[0];s.targetStatus='active'
  await page.reload();await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await page.getByText('原员工操作已确认',{exact:true}).waitFor()
  await page.getByText('员工账号管理',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'停用',exact:true}).count(),1)
  assert.deepEqual(s.calls.at(-1),{...original,path:`${original.path}/recover`});assert.equal(s.writes,1);assert.deepEqual(await saved(page),[])
 })
 await run('revocation hides management data and retains recovery until authority returns',async(page,s)=>{
  await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await pending(page);const key=s.calls[0].key;s.authorized=false
  await page.getByLabel('原创建PIN',{exact:true}).fill('4826');await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await page.getByRole('button',{name:'重新读取',exact:true}).waitFor()
  assert.equal(await page.getByText('员工账号管理',{exact:true}).count(),0);assert.equal((await saved(page)).length,1)
  s.authorized=true;await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByLabel('原创建PIN',{exact:true}).fill('4826');await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await page.getByText('原员工操作已确认',{exact:true}).waitFor();assert.equal(s.calls.at(-1).key,key);assert.equal(s.writes,1)
 })
 await run('missing server receipt remains unresolved without re-executing the old operation',async(page,s)=>{
  await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await pending(page)
  const key=s.calls[0].key;s.receipts.clear()
  await page.getByLabel('原创建PIN',{exact:true}).fill('4826');await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).click();await pending(page)
  assert.equal(s.calls.at(-1).key,key);assert.equal(s.calls.at(-1).path.endsWith('/recover'),true);assert.equal(s.writes,1);assert.equal((await saved(page)).length,1)
 })
 await run('known first rejection allows corrected retry with a new key',async(page,s)=>{
  s.reject=true;await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await page.getByText('本次员工操作未提交',{exact:true}).waitFor();const key=s.calls[0].key
  assert.deepEqual(await saved(page),[]);s.reject=false;s.loss=false;await page.getByLabel('初始PIN',{exact:true}).fill('4826');await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await page.getByText('员工操作已完成',{exact:true}).waitFor();assert.notEqual(s.calls.at(-1).key,key);assert.equal(s.writes,1)
 })
 await run('confirmed command stays confirmed if the subsequent current-state read fails',async(page,s)=>{
  s.loss=false;s.afterCommitReadFail=true;await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await page.getByText('员工操作已确认，当前列表暂未读取',{exact:true}).waitFor();assert.deepEqual(await saved(page),[])
  s.readFail=false;await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByText('员工账号管理',{exact:true}).waitFor();assert.equal(s.calls.length,1)
 })
 await run('late result and saved intent never appear for a different administrator',async(page,s)=>{
  let finish;s.delay=new Promise(resolve=>{finish=resolve});s.loss=false;await fillCreate(page);await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('mbox.staff-employee-intent.v1:')))
  s.actor=other;await page.evaluate(actor=>window.employeeHarness.render(actor),other);await page.getByText('员工账号管理',{exact:true}).waitFor();finish();await page.waitForTimeout(150)
  assert.equal(await page.getByRole('button',{name:'恢复原员工操作结果',exact:true}).count(),0);assert.equal(await page.getByText('员工操作已完成',{exact:true}).count(),0);assert.equal(s.writes,1)
 })
 await run('storage failure blocks writes and a double submit sends only one command',async(page,s)=>{
  await fillCreate(page);await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('storage unavailable')}})
  await page.getByRole('button',{name:'建立员工账号',exact:true}).click();await page.getByText('本次员工操作未提交',{exact:true}).waitFor();assert.equal(s.calls.length,0)
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem});await page.getByLabel('初始PIN',{exact:true}).fill('4826')
  await page.locator('form').first().evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});await pending(page);assert.equal(s.calls.length,1)
 })
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'browser-component-fault-injection',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
