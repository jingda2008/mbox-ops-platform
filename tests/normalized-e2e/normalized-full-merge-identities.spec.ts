import {build} from 'esbuild'
import {expect,test,type Page} from '@playwright/test'

let javascript:string,css:string
test.beforeAll(async()=>{
  const bundle=await build({entryPoints:['tests/normalized-e2e/fixtures/participant-full-merge-harness.tsx'],bundle:true,write:false,outdir:'unused',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}})
  javascript=bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text
  css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))!.text
})
async function open(page:Page){
  await page.goto('about:blank')
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><output id="result"></output>')
  await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0}'+css})
  await page.addScriptTag({content:javascript})
  await page.getByRole('button',{name:'人员并桌',exact:true}).click()
  await page.getByLabel('目标桌').selectOption('DST')
  await page.getByRole('button',{name:'选择全部',exact:false}).click()
}
for(const width of [320,390])test(`full merge keeps 2 people and all 3 identities at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:844});await open(page)
  await expect(page.getByLabel('实际移动人数')).toHaveValue('2')
  await page.getByRole('button',{name:'下一步：执行前预检'}).click()
  await expect(page.getByText('移动人数：2人；关联账号：3个',{exact:true})).toBeVisible()
  await expect(page.getByText('预计目标桌：3 / 容量3人',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'确认执行',exact:true}).click()
  await expect(page.locator('#result')).toContainText('人员并桌已完成')
  const requests=await page.evaluate(()=>window.mergeHarness)
  expect(requests.previews).toHaveLength(1);expect(requests.moves).toHaveLength(1)
  expect(requests.moves[0]).toMatchObject({movedGuestCount:2,participantPublicIds:['person-0','person-1','person-2']})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
test('full merge still requires every identity and partial movement keeps its count guard',async({page})=>{
  await open(page)
  await page.getByRole('checkbox').first().uncheck()
  await page.getByRole('button',{name:'下一步：执行前预检'}).click()
  await expect(page.getByText('全员并桌必须选择源桌全部已识别顾客',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>window.mergeHarness.previews)).toHaveLength(0)
  await page.getByRole('checkbox').first().check()
  await page.getByLabel('实际移动人数').fill('1')
  await page.getByRole('button',{name:'下一步：执行前预检'}).click()
  await expect(page.getByText('部分移动人数不能少于已选择的顾客账号数',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>window.mergeHarness.previews)).toHaveLength(0)
})
test('extra identities never enable confirmation while preview reports unsettled commerce',async({page})=>{
  await open(page);await page.evaluate(()=>{window.mergeHarness.blocked=true})
  await page.getByRole('button',{name:'下一步：执行前预检'}).click()
  await expect(page.getByText('请先处理以下未结事项：',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'确认执行',exact:true})).toBeDisabled()
  expect(await page.evaluate(()=>window.mergeHarness.moves)).toHaveLength(0)
})
