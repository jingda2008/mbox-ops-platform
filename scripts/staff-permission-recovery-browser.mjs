import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/staff-permission-recovery-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-permission-recovery-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/staff-employee-recovery-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),results=[]
const employeeId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222'
const intent={version:1,scopeKey:'tenant:store',employeeId,key:'staff-access-55555555-5555-4555-8555-555555555555',createdAt:'2026-11-05T00:00:00Z',body:{expectedVersion:'a'.repeat(64),reason:'Local original intent',changes:[{kind:'employee_override',employeeId:targetId,permissionCode:'order.create',effect:'grant'}]}}
const storageKey=`mbox.staff-permission-intent.v1:tenant:store:${employeeId}:${intent.key}`
const board={generatedAt:new Date().toISOString(),scopeKey:'tenant:store',configurationVersion:'a'.repeat(64),roles:[],employees:[],permissions:[],areas:[],configurationDefinitions:[]}
const receipt={status:'verified',verifiedAt:'2026-11-05T00:00:00Z',replayed:true,overview:null,changes:[{kind:'employee_override',targetId,configurationCode:'order.create',applied:true,effectiveEmployeeCount:1,affectedEmployeeCount:1}]}
try {
 for(const failure of ['STAFF_ACCESS_VERSION_CONFLICT','PERMISSION_DEPLOYMENT_INVALID','STAFF_ACCESS_FORBIDDEN','empty','wrong-target']){
  const context=await browser.newContext(),page=await context.newPage(),calls=[],errors=[];let correct=false
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message))
  try {
   await context.addInitScript(({key,intent})=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem(key,JSON.stringify(intent));sessionStorage.setItem('seeded','yes')}},{key:storageKey,intent})
   await page.route('**/api/**',async route=>{
    const request=route.request(),reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(request.method()==='GET')return reply(200,{data:board})
    assert.equal(new URL(request.url()).pathname,'/api/staff-access/deploy')
    calls.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()})
    if(correct)return reply(200,{data:receipt})
    if(failure.startsWith('STAFF_')||failure==='PERMISSION_DEPLOYMENT_INVALID')return reply(409,{error:{code:failure,message:'local recovery refusal'}})
    const bad=structuredClone(receipt);if(failure==='empty')bad.changes=[];else bad.changes[0].targetId='other'
    return reply(200,{data:bad})
   })
   await page.goto(url);await page.getByRole('button',{name:'恢复原发布结果',exact:true}).click()
   await page.getByText('权限发布结果尚未确认',{exact:true}).waitFor()
   assert.equal(await page.getByText('本次修改未写入，请重新核对当前配置',{exact:true}).count(),0)
   assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),storageKey)),intent)
   await page.reload();await page.getByRole('button',{name:'恢复原发布结果',exact:true}).waitFor();correct=true
   await page.getByRole('button',{name:'恢复原发布结果',exact:true}).click();await page.getByText('原权限发布已确认，当前配置已重新读取',{exact:true}).waitFor()
   assert.equal(await page.evaluate(key=>localStorage.getItem(key),storageKey),null)
   assert.deepEqual(calls,[1,2].map(()=>({key:intent.key,body:{...intent.body,receiptOnly:true}})))
   assert.deepEqual(errors,[]);results.push({failure,status:'passed'});console.log('PASS',failure)
  }catch(error){results.push({failure,status:'failed',error:String(error)});console.error(error)}finally{await context.close()}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'real-component-local-fault-injection',results},null,2))}
if(results.some(result=>result.status!=='passed'))process.exitCode=1
