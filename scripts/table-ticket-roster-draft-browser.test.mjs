// Actual staff component in a loopback-only synthetic fixture. No DB, guest accounts or payments.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {chromium} from 'playwright'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'

const testPath='/__ticket_roster_fixture'
const fixture=`
import React from 'react'
import {createRoot} from 'react-dom/client'
import {ConfirmationDialogProvider} from '/src/normalized-ui/ConfirmationDialog.tsx'
import {TableTicketOffers} from '/src/normalized-ui/TableTicketOffers.tsx'
import '/src/normalized-ui/activity-operations-panel.css'
const base={terms:{version:1},draftAuthor:null,creatorId:'manager',activityStatus:'published',isOnSale:false,remaining:99,categoryVisible:true,
  id:null,categoryCode:null,categories:[],version:null,name:null,saleFrom:null,saleUntil:null,visibleFrom:null,visibleUntil:null,
  priceMinor:null,giftPoints:null,status:null,rosterConfigured:true,draftTableIds:null,recommendInCommunity:false}
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',c='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let rows=[
  {...base,areaId:'indoor',areaName:'室内',ticketTables:[{id:a,code:'A01'},{id:b,code:'A02'}],tableCodes:['OLD99']},
  {...base,areaId:'vip',areaName:'贵宾区',ticketTables:[{id:c,code:'V01'}],tableCodes:['OLD98']},
  {...base,areaId:'empty',areaName:'空区域',ticketTables:[]},
]
let requests=[]
const api={
  getEndpoint:async()=>({data:structuredClone(rows)}),
  postEndpoint:async(_path,body)=>{
    requests.push(body)
    if(body.status !== 'draft')throw Error('非草稿调用')
    rows=rows.map(row=>row.areaId===body.areaId?{...row,id:'draft',version:(row.version??0)+1,status:'draft',name:body.name,
      priceMinor:body.priceMinor,giftPoints:body.giftPoints,draftTableIds:body.draftTableIds}:row)
    document.querySelector('output').textContent=JSON.stringify(requests)
    return {data:{}}
  },
}
function App(){return <><button type="button" onClick={()=>{rows=rows.map(row=>row.areaId==='indoor'?{...row,ticketTables:[{id:b,code:'A02'}]}:row)}}>模拟当期名单调整</button>
  <output aria-label="模拟请求回执">{JSON.stringify(requests)}</output>
  <ConfirmationDialogProvider><TableTicketOffers api={api} activityId="show" employeeId="manager" activityUpdatedAt="2026-11-24" reviewSummary="隔离验收" initiallyOpen onPublished={()=>{throw Error('不得发布')}} canManage canPublish canAssist={false}/></ConfirmationDialogProvider></>}
createRoot(document.getElementById('root')).render(<App/>)
`
test('desktop and mobile explicitly select and persist only confirmed tables; stale ids do not become saleable',async()=>{
  const server=await createServer({configFile:false,root:new URL('..',import.meta.url).pathname,plugins:[react(),{
    name:'local-table-ticket-roster-fixture',
    resolveId(id){if(id===testPath+'.tsx')return id},
    load(id){if(id===testPath+'.tsx')return fixture},
    configureServer(vite){vite.middlewares.use(testPath,async(req,res,next)=>{
      if(req.originalUrl!==testPath)return next()
      res.setHeader('Content-Type','text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml(testPath,'<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="max-width:760px;margin:8px"><div id="root"></div><script type="module" src="'+testPath+'.tsx"></script></body></html>'))
    })},
  }],server:{host:'127.0.0.1',port:0}})
  let browser
  try{
    await server.listen()
    const port=server.httpServer.address().port
    browser=await chromium.launch({executablePath:process.env.MBOX_BROWSER_EXECUTABLE||undefined})
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}})
      try{
        await page.goto('http://127.0.0.1:'+port+testPath)
        const save=page.getByRole('button',{name:'保存草稿',exact:true})
        await save.waitFor()
        assert.equal(await page.getByText(/OLD9[89]|99 桌/).count(),0)
        assert.equal(await page.getByRole('button',{name:/发布|上架/}).count(),0)
        assert.equal(await page.getByRole('checkbox',{name:'A01',exact:true}).isChecked(),false)
        await page.getByLabel('每桌售价（元）').fill('500')
        await save.click()
        await page.getByRole('status').filter({hasText:'至少选择一桌'}).waitFor()
        assert.equal(await page.locator('output').textContent(),'[]')
        await page.getByRole('checkbox',{name:'A01',exact:true}).check()
        await page.getByRole('checkbox',{name:'A02',exact:true}).check()
        await page.getByText('购票须知 · 适用区域：室内 · A01、A02',{exact:true}).waitFor()
        await page.getByRole('checkbox',{name:'A02',exact:true}).uncheck()
        await page.getByText('购票须知 · 适用区域：室内 · A01',{exact:true}).waitFor()
        await save.click()
        await page.getByRole('status').filter({hasText:'票档草稿已保存'}).waitFor()
        assert.deepEqual(JSON.parse(await page.locator('output').textContent()).at(-1).draftTableIds,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
        await page.getByLabel('演出桌区').selectOption('vip')
        await page.getByRole('checkbox',{name:'V01',exact:true}).waitFor()
        assert.equal(await page.getByRole('checkbox',{name:'A01',exact:true}).count(),0)
        await page.getByLabel('演出桌区').selectOption('indoor')
        assert.equal(await page.getByRole('checkbox',{name:'A01',exact:true}).isChecked(),true)
        await page.getByRole('button',{name:'模拟当期名单调整'}).click()
        await page.getByRole('button',{name:'刷新票档'}).click()
        await page.getByRole('alert').filter({hasText:'原草稿有桌台已移出当期名单'}).waitFor()
        assert.equal(await page.getByRole('checkbox',{name:'A01',exact:true}).count(),0)
        await page.getByRole('checkbox',{name:'A02',exact:true}).check()
        await save.click()
        await page.getByRole('status').filter({hasText:'票档草稿已保存'}).waitFor()
        assert.deepEqual(JSON.parse(await page.locator('output').textContent()).at(-1).draftTableIds,
          ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
        await page.getByLabel('演出桌区').selectOption('empty')
        await page.getByText('本区尚无已核对的可选桌台。').waitFor()
        assert.equal(await page.getByRole('button',{name:/发布|上架/}).count(),0)
      }finally{await page.close()}
    }
  }finally{await browser?.close();await server.close()}
})
