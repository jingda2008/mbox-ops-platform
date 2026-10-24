import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/product-sale-quantity-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-sale-quantity-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/product-sale-quantity-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true}),results=[]
async function run(name,fn){const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await page.goto(url);await page.getByRole('button',{name:'保存可售数量'}).waitFor();await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'passed'})}catch(error){results.push({name,status:'failed',message:String(error)});console.error(name,error)}finally{await page.screenshot({path:join(output,`${results.length}.png`),fullPage:true});await context.close()}}
try{
 await run('blank zero and replenishment keep distinct meanings',async page=>{
  const input=page.getByLabel('剩余可售份数'),save=page.getByRole('button',{name:'保存可售数量'})
  for(const value of ['0','12','']){await input.fill(value);await save.click();await page.getByText('可售数量已保存并重新读取',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.quantityHarness.rows.one.remaining),value===''?null:Number(value))}
 })
 await run('invalid quantities do not send a command',async page=>{
  for(const value of ['-1','1.5','1000001']){await page.getByLabel('剩余可售份数').fill(value);await page.getByRole('button',{name:'保存可售数量'}).click();await page.getByText('请填写0到1000000的整数，或留空沿用原管理方式',{exact:true}).waitFor()}
  assert.deepEqual(await page.evaluate(()=>window.quantityHarness.calls),[])
 })
 await run('lost receipt retries the same command without replacing later sales',async page=>{
  await page.evaluate(()=>window.quantityHarness.set({drop:true}));await page.getByLabel('剩余可售份数').fill('10');await page.getByRole('button',{name:'保存可售数量'}).click();await page.getByText(/网络断开，结果尚未确认/).waitFor()
  await page.evaluate(()=>{window.quantityHarness.rows.one.remaining=9;window.quantityHarness.rows.one.version='2'})
  await page.getByRole('button',{name:'保存可售数量'}).click();await page.getByText('可售数量已保存并重新读取',{exact:true}).waitFor()
  const calls=await page.evaluate(()=>window.quantityHarness.calls);assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.equal(await page.getByLabel('剩余可售份数').inputValue(),'9')
 })
 await run('stale save requires a fresh read and switching product clears previous amount',async page=>{
  await page.evaluate(()=>{window.quantityHarness.rows.one.remaining=4;window.quantityHarness.rows.one.version='1'})
  await page.getByLabel('剩余可售份数').fill('10');await page.getByRole('button',{name:'保存可售数量'}).click();await page.getByText(/可售数量已变化，本次未保存/).waitFor()
  await page.getByRole('button',{name:'重新读取'}).click();await page.getByText('已读取当前数量',{exact:true}).waitFor();assert.equal(await page.getByLabel('剩余可售份数').inputValue(),'4')
  await page.evaluate(()=>window.quantityHarness.render('two'));await page.waitForFunction(()=>document.querySelector('input').value==='3');assert.equal(await page.getByLabel('剩余可售份数').inputValue(),'3')
 })
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'real-react-component-with-local-api-fault-fixture',results},null,2))}
console.log(JSON.stringify(results));if(results.some(r=>r.status!=='passed'))process.exitCode=1
