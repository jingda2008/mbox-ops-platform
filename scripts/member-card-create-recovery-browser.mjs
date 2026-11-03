import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/member-card-create-recovery-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-card-recovery-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/member-card-create-recovery-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true}),results=[]
try{
 for(const mode of ['draft','open','revoked-retry']){
  const page=await browser.newPage(),calls=[],receipts=new Map();let writes=0,denied=false
  try{
   await page.route('**/api/**',async route=>{
    const req=route.request(),reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
    if(req.method()==='GET')return reply(200,{data:{items:[],nextCursor:null}})
    const body=req.postDataJSON(),key=req.headers()['idempotency-key'];calls.push({body,key})
    if(denied)return reply(403,{error:{code:'CARD_ACCESS_DENIED',message:'发布权限已撤销'}})
    const existing=receipts.get(key)
    if(existing){if(existing.fingerprint!==JSON.stringify(body))return reply(409,{error:{message:'原请求内容不同'}});return reply(200,{data:existing.result,meta:{replayed:true}})}
    // A different key for the same generated card cannot recover its receipt.
    if(writes)return reply(409,{error:{message:'卡编号已存在，请核对原操作'}})
    writes++;const result={projectId:'22222222-2222-4222-8222-222222222222',status:body.openImmediately?'open':'draft'}
    receipts.set(key,{fingerprint:JSON.stringify(body),result});return route.abort('failed')
   })
   await page.goto(`http://127.0.0.1:${server.address().port}`)
   await page.getByText('卡项目配置与开放',{exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('合成恢复卡')
   const button=page.getByRole('button',{name:mode==='draft'?'保存未开放草稿':'保存并开放申请',exact:true})
   await button.click();await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent?.length>0)
   assert.equal(calls.length,1);assert.equal(await button.isEnabled(),true)
   if(mode==='revoked-retry'){
    denied=true;await button.click();await page.getByText('发布权限已撤销',{exact:true}).waitFor();denied=false
   }
   await button.click();await page.waitForFunction(()=>{const text=document.querySelector('[role="status"]')?.textContent;return text?.startsWith('已保存')||text?.includes('卡编号已存在')},{},{timeout:3000})
   assert.equal(calls.length,mode==='revoked-retry'?3:2)
   for(const call of calls){assert.equal(call.key,calls[0].key);assert.deepEqual(call.body,calls[0].body)}
   assert.equal(writes,1);assert.match(await page.getByRole('status').textContent(),/^已保存/);results.push({mode,status:'passed',requests:calls.length,writes});console.log(`PASS ${mode}`)
  }catch(error){results.push({mode,status:'failed',error:String(error)});console.error(`FAIL ${mode}: ${error}`)}finally{await page.close()}
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'local-component-response-loss-fault-injection',results},null,2))}
if(results.some(r=>r.status==='failed'))process.exitCode=1
