import {build} from 'esbuild'
import {chromium} from '@playwright/test'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const output='outputs/operating-dashboard-20261023/browser';await mkdir(output,{recursive:true})
const tmp=await mkdtemp(join(tmpdir(),'mbox-operating-dashboard-'))
await build({entryPoints:['tests/normalized-e2e/fixtures/operating-dashboard-harness.tsx'],bundle:true,outfile:join(tmp,'app.js'),format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}})
const server=createServer(async(req,res)=>{const file=req.url==='/app.js'?'app.js':req.url==='/app.css'?'app.css':null;res.setHeader('content-type',file==='app.js'?'text/javascript':file==='app.css'?'text/css':'text/html');res.end(file?await readFile(join(tmp,file)):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true}),results=[]
async function run(name,fn){const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));try{await page.goto(url);await page.getByText('有效订单 151 笔',{exact:false}).waitFor();await fn(page);assert.deepEqual(errors,[]);assert.equal((await page.evaluate(()=>window.dashboardHarness.writes)).length,0);results.push({name,status:'passed'});console.log('PASS',name)}catch(e){results.push({name,status:'failed',message:String(e)});await page.screenshot({path:join(output,`failure-${results.length}.png`),fullPage:true});console.error('FAIL',name,e)}finally{await context.close()}}
try{
 await run('period selection coordinates finance sales and paginated sources without limiting totals',async page=>{
  await page.getByRole('button',{name:'本月',exact:true}).click();await page.getByLabel('经营期间选择').fill('2026-09');await page.getByText('2026-09-01 至 2026-09-30 · 更新于',{exact:false}).waitFor()
  await page.waitForFunction(()=>window.dashboardHarness.calls.some(path=>path.includes('/employee-sales?startDate=2026-09-01&endDate=2026-09-30'))&&window.dashboardHarness.calls.some(path=>path.includes('/owner-finance?startDate=2026-09-01&endDate=2026-09-30')))
  await page.getByRole('button',{name:/经营费用.*查看 2 条来源/}).click();await page.getByRole('button',{name:'下一页来源',exact:true}).click();await page.getByText('房租来源第2页',{exact:false}).waitFor();await page.getByText('待补充',{exact:true}).waitFor()
  assert.ok((await page.locator('body').innerText()).includes('有效订单 151 笔'));assert.ok((await page.evaluate(()=>window.dashboardHarness.calls)).some(path=>path.includes('sourceKind=cost&sourceCategory=operating_expenses&sourcePage=1')))
 })
 await run('late previous month response cannot overwrite the selected year',async page=>{
  await page.evaluate(()=>window.dashboardHarness.render({holdMonth:true}));await page.getByRole('button',{name:'本月',exact:true}).click();await page.getByRole('button',{name:'本年',exact:true}).click();await page.getByText('2026-01-01 至 2026-10-23 · 更新于',{exact:false}).waitFor();await page.evaluate(()=>window.dashboardHarness.release());await page.waitForTimeout(60)
  assert.equal(await page.getByText('2026-10-01 至 2026-10-23 · 更新于',{exact:false}).count(),0);assert.ok((await page.locator('body').innerText()).includes('¥2026.00'))
 })
 await run('profit failure preserves labeled old data while independent finance and sales remain usable',async page=>{
  await page.evaluate(()=>window.dashboardHarness.render({failProfit:true}));await page.getByRole('button',{name:'刷新经营数据',exact:true}).click();await page.getByText('经营接口读取中断',{exact:false}).waitFor();assert.ok((await page.locator('body').innerText()).includes('尚未更新'));await page.getByRole('region',{name:'财务仪表盘'}).waitFor();await page.getByText('茶',{exact:true}).waitFor();assert.equal(await page.getByText('数据已完整核对',{exact:false}).count(),0)
 })
 await run('current todo uses authoritative counts beyond list cap and returns to original historical range',async page=>{
  await page.getByRole('button',{name:'本月',exact:true}).click();await page.getByLabel('经营期间选择').fill('2026-09');await page.getByText('共 201 项',{exact:false}).waitFor();await page.getByRole('button',{name:'活动待复核 101 项',exact:true}).click();await page.waitForFunction(()=>window.dashboardHarness.calls.some(path=>path.includes('/payments/workbench?')&&path.includes('activityFilter=requested')));await page.getByText('普通订单保持原筛选',{exact:false}).waitFor();assert.ok((await page.getByRole('region',{name:'活动完整范围待办'}).getByRole('button').filter({hasText:'活动待复核'}).innerText()).includes('101'));await page.getByRole('button',{name:'返回经营仪表盘',exact:true}).click();await page.getByText('2026-09-01 至 2026-09-30 · 更新于',{exact:false}).waitFor();assert.equal(await page.getByLabel('经营期间选择').inputValue(),'2026-09')
 })
 await run('failed aggregate is unknown rather than counting its small page as complete',async page=>{
  await page.evaluate(()=>window.dashboardHarness.render({failCounts:true}));await page.getByRole('button',{name:'刷新待办',exact:true}).click();await page.getByText('退款完整范围汇总暂未读取，数量未知',{exact:false}).waitFor();assert.equal(await page.getByText('共 201 项',{exact:false}).count(),0);await page.evaluate(()=>window.dashboardHarness.navigate('/staff/payments?activityFilter=requested'));await page.getByRole('region',{name:'活动完整范围待办'}).getByText('完整范围汇总暂未读取，数量未知',{exact:false}).waitFor();assert.equal(await page.getByRole('region',{name:'活动完整范围待办'}).getByRole('button').filter({hasText:'活动待复核'}).count(),0)
 })
 await run('revoked profit permission clears sensitive metrics and switching account resets remembered period',async page=>{
  await page.getByRole('button',{name:'本月',exact:true}).click();await page.getByLabel('经营期间选择').fill('2026-09');await page.evaluate(()=>window.dashboardHarness.render({permissions:['commercial.sales.view_all','commercial.cost.view']}));await page.getByText('当前账号没有全店经营利润查看权限',{exact:false}).waitFor();assert.equal(await page.getByRole('region',{name:'老板经营仪表盘'}).count(),0);await page.getByRole('region',{name:'财务仪表盘'}).waitFor()
  await page.evaluate(()=>window.dashboardHarness.render({employee:'22222222-2222-4222-8222-222222222222',permissions:['commercial.profit.view']}));await page.getByText('2026-10-23 至 2026-10-23 · 更新于',{exact:false}).waitFor();assert.equal(await page.getByLabel('经营期间选择').inputValue(),'2026-10-23')
 })
 await run('catalog list remembers search and expansion but never restores an editing object',async page=>{
  await page.getByRole('button',{name:'商品管理入口',exact:true}).click();await page.getByRole('button',{name:/商品、售价与推荐/}).click();await page.getByLabel('搜索配置商品').fill('上次商品');await page.getByRole('button',{name:'返回经营仪表盘',exact:true}).click();await page.getByRole('button',{name:'商品管理入口',exact:true}).click();await page.getByLabel('搜索配置商品').waitFor();assert.equal(await page.getByLabel('搜索配置商品').inputValue(),'上次商品');assert.equal(await page.getByRole('button',{name:'保存商品',exact:true}).count(),0)
 })
 await run('cost source details stay permission-gated even when profit aggregate is visible',async page=>{
  await page.getByRole('button',{name:/经营费用.*查看 2 条来源/}).click();await page.getByText('房租来源第1页',{exact:false}).waitFor()
  await page.evaluate(()=>window.dashboardHarness.render({permissions:['commercial.profit.view']}));await page.getByText('订单来源第1页',{exact:false}).waitFor()
  assert.equal(await page.getByRole('option',{name:'经营成本',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/经营费用.*费用明细需对应权限/}).isDisabled(),true);assert.equal(await page.getByText('房租来源第1页',{exact:false}).count(),0)
 })
 await run('historical report remains readable while authoritative print access blocks new output',async page=>{
  await page.evaluate(()=>window.dashboardHarness.render({permissions:[...window.dashboardHarness.state.permissions,'order.bill.print'],printAllowed:false}));await page.getByRole('button',{name:'本月',exact:true}).click();await page.getByLabel('经营期间选择').fill('2026-09');await page.getByText('2026-09-01 至 2026-09-30 · 更新于',{exact:false}).waitFor()
  await page.getByText('当前账号不能打印此历史期间',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'打印经营汇总',exact:true}).isDisabled(),true);assert.equal((await page.evaluate(()=>window.dashboardHarness.printCalls)).length,0)
 })
 await run('unknown print survives page reload and failed report refresh with its original scope body and key',async page=>{
  await page.evaluate(()=>window.dashboardHarness.render({permissions:[...window.dashboardHarness.state.permissions,'order.bill.print'],printUnknown:true}));await page.getByRole('button',{name:'打印经营汇总',exact:true}).click();await page.getByText('打印结果未知',{exact:false}).waitFor();const original=await page.evaluate(()=>window.dashboardHarness.printCalls[0]);assert.ok(original.options.idempotencyKey)
  await page.reload();await page.getByText('有效订单 151 笔',{exact:false}).waitFor();await page.evaluate(()=>window.dashboardHarness.render({permissions:[...window.dashboardHarness.state.permissions,'order.bill.print'],failProfit:true}));await page.getByText('经营接口读取中断',{exact:false}).waitFor();await page.getByText('已保留的原打印请求仍可核对',{exact:false}).waitFor();await page.getByRole('button',{name:'核对原打印请求',exact:true}).click();await page.getByText('已生成经营汇总打印任务',{exact:false}).waitFor()
  const recovered=await page.evaluate(()=>window.dashboardHarness.printCalls);assert.equal(recovered.length,1);assert.deepEqual(recovered[0],original);await page.getByText('原打印记录',{exact:true}).click();assert.equal(await page.getByRole('button',{name:'已核对原票，准备重新生成',exact:true}).isDisabled(),true)
  await page.evaluate(()=>window.dashboardHarness.render({employee:'33333333-3333-4333-8333-333333333333',failProfit:false}));await page.getByRole('button',{name:'打印经营汇总',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'核对原打印请求',exact:true}).count(),0)
 })
 await run('phone dashboard remains within viewport with legible negative and provisional values',async page=>{
  assert.ok((await page.locator('body').innerText()).includes('¥-60.00'));assert.ok((await page.locator('body').innerText()).includes('已知部分暂估'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:join(output,'phone-dashboard.png'),fullPage:true})
  await page.getByRole('button',{name:'本月',exact:true}).click();await page.locator('.operating-trend svg').waitFor()
  const palette=await page.evaluate(()=>{
   const color=selector=>getComputedStyle(document.querySelector(selector)).color
   return {ink:getComputedStyle(document.documentElement).getPropertyValue('--mbox-ink').trim(),theme:getComputedStyle(document.querySelector('.staff-module-panel')).backgroundImage,text:color('.operating-dashboard p'),negative:color('.operating-metrics .is-negative'),income:color('.operating-trend .trend-income'),cost:color('.operating-trend .trend-cost'),lines:[...document.querySelectorAll('.operating-trend svg polyline')].map(line=>getComputedStyle(line).stroke),axes:color('.operating-trend svg')}
  })
  assert.equal(palette.ink,'#171b18');assert.ok(palette.theme.includes('linear-gradient'),'actual staff light theme is loaded')
  const luminance=color=>{const values=color.match(/[\d.]+/g).slice(0,3).map(value=>{const channel=Number(value)/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4});return values[0]*.2126+values[1]*.7152+values[2]*.0722}
  const contrast=(foreground,background)=>{const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
  // Staff module gradient uses pale cream/green, with white nested surfaces.
  for(const background of ['rgb(242, 238, 230)','rgb(238, 241, 235)','rgb(255, 255, 255)']){
   for(const color of [palette.text,palette.negative,palette.income,palette.cost,palette.axes])assert.ok(contrast(color,background)>=4.5,`${color} must be readable on ${background}`)
   for(const stroke of palette.lines)assert.ok(contrast(stroke,background)>=3,`trend ${stroke} must be visible on ${background}`)
  }
  assert.deepEqual(palette.lines,[palette.income,palette.cost]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:join(output,'phone-dashboard-month.png'),fullPage:true})
 })
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});await writeFile(join(output,'report.json'),JSON.stringify({kind:'local-component-browser-fault-injection',results},null,2))}
if(results.some(r=>r.status!=='passed'))process.exitCode=1
