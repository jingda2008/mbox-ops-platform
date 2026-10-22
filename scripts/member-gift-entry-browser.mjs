import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/event-card-v3-20261022/member-gift-entry-browser'
await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-gift-ui-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/member-gift-entry-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},loader:{'.css':'empty'}})
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?await readFile(join(tmp,'app.js')):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true}),results=[]
async function run(name,fn){const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await page.goto(url);await page.getByText('A原券',{exact:false}).waitFor();await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'passed'});console.log('PASS',name)}catch(e){results.push({name,status:'failed',message:String(e)});await page.screenshot({path:join(output,`failure-${results.length}.png`),fullPage:true});console.error('FAIL',name,e)}finally{await context.close()}}
async function select(page){await page.getByRole('group',{name:'第 1 份选款'}).getByRole('checkbox',{name:'可乐'}).check();await page.getByRole('group',{name:'第 2 份选款'}).getByRole('checkbox',{name:'茶',exact:false}).check()}
try{
await run('two physical gifts require their own valid selections and submit both',async page=>{
 const button=page.getByRole('button',{name:'确认核销并出品'});assert.equal(await button.isDisabled(),true)
 assert.equal(await page.getByRole('checkbox',{name:'售罄选项',exact:false}).first().isDisabled(),true)
 await select(page);await button.click();await page.getByText('原券已核销，所选商品已进入出品。').waitFor()
 const calls=await page.evaluate(()=>window.giftHarness.calls);assert.equal(calls.length,1);assert.deepEqual(calls[0].command.body.bundleSelections,[{groups:[{groupId:'group',productIds:['cola']}]},{groups:[{groupId:'group',productIds:['tea']}]}])
})
await run('unknown receipt survives remount and restores exact body and key',async page=>{
 await page.evaluate(()=>window.giftHarness.mode('lost'));await select(page);await page.getByRole('button',{name:'确认核销并出品'}).click();await page.getByRole('button',{name:'恢复原操作'}).waitFor()
 assert.equal(await page.getByRole('checkbox').first().isDisabled(),true)
 await page.evaluate(()=>window.giftHarness.render({mount:false}));await page.evaluate(()=>window.giftHarness.render({mount:true}));await page.getByRole('button',{name:'恢复原操作'}).click();await page.getByText('原券已核销，所选商品已进入出品。').waitFor()
 const calls=await page.evaluate(()=>window.giftHarness.calls);assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].command,calls[1].command)
})
await run('confirmed non-commit releases unknown intent without submitting another order',async page=>{
 await page.evaluate(()=>window.giftHarness.mode('lost'));await select(page);await page.getByRole('button',{name:'确认核销并出品'}).click();await page.getByRole('button',{name:'恢复原操作'}).waitFor()
 await page.evaluate(()=>window.giftHarness.mode('not-committed'));await page.getByRole('button',{name:'恢复原操作'}).click();await page.getByText('已确认原请求未提交').waitFor()
 assert.equal(await page.getByRole('button',{name:'恢复原操作'}).count(),0);assert.equal(await page.getByRole('checkbox').first().isEnabled(),true)
 const calls=await page.evaluate(()=>window.giftHarness.calls);assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key)
})
await run('late receipt cannot replace another employee and member scope',async page=>{
 await page.evaluate(()=>window.giftHarness.mode('late'));await select(page);await page.getByRole('button',{name:'确认核销并出品'}).click();await page.waitForFunction(()=>window.giftHarness.calls.length===1)
 await page.evaluate(()=>window.giftHarness.render({owner:'B'}));await page.getByText('B原券',{exact:false}).waitFor();await page.evaluate(()=>window.giftHarness.resolve());await page.waitForTimeout(100)
 assert.equal(await page.getByText('原券已核销，所选商品已进入出品。').count(),0);assert.equal(await page.getByText('A原券',{exact:false}).count(),0);assert.equal((await page.evaluate(()=>window.giftHarness.calls)).length,1)
})
await run('lack of fulfillment permission keeps existing reservation read only',async page=>{
 await page.evaluate(()=>{window.giftHarness.permission();window.giftHarness.render({mount:false})});await page.evaluate(()=>window.giftHarness.render({mount:true}));await page.getByText('当前账号没有权益核销权限',{exact:false}).waitFor()
 assert.equal(await page.getByRole('button',{name:'确认核销并出品'}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'取消本次暂留'}).count(),0)
})
await run('member scan card opens the existing gift workflow only on explicit action',async page=>{
 await page.evaluate(()=>window.giftHarness.render({parent:true}));await page.getByRole('button',{name:'办理赠品券',exact:true}).waitFor()
 assert.equal(await page.getByRole('region',{name:'办理会员赠品券'}).count(),0)
 await page.getByRole('button',{name:'办理赠品券',exact:true}).click();await page.getByRole('region',{name:'办理会员赠品券'}).waitFor()
 assert.equal(await page.getByRole('group',{name:'第 1 份选款'}).count(),1)
})
await run('simple gift needs no option step',async page=>{
 await page.evaluate(()=>{window.giftHarness.single();window.giftHarness.render({mount:false})});await page.evaluate(()=>window.giftHarness.render({mount:true}));await page.getByRole('button',{name:'确认核销并出品'}).waitFor()
 assert.equal(await page.getByRole('group').count(),0);assert.equal(await page.getByRole('button',{name:'确认核销并出品'}).isEnabled(),true)
})
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'local-component-browser-fault-injection',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
