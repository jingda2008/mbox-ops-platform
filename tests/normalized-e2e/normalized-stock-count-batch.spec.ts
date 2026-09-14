import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
import type {StockCountReview} from '../../src/shared/inventory-stock-count'

function count(id:string,stale=false,canReview=true):StockCountReview {
  return {id,publicId:`batch-${id}`,status:'submitted',createdByEmployeeId:'counter',createdByName:'盘点同事',submittedAt:'2026-09-14T11:35:54Z',decidedAt:null,decidedByName:null,decisionReason:null,note:null,canReview,
    lines:[{inventoryItemId:id,itemName:`商品${id}`,baseUnit:'ml',categoryCode:'spirits.gin',packageVolumeMl:'750',systemQuantity:'100',countedQuantity:'200',varianceQuantity:'100',currentQuantity:stale?'150':'100',stale,reason:null}]}
}
async function open(page:Page,counts:StockCountReview[],second:StockCountReview[]=[]){
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.route('**/api/inventory/stock-counts?**',route=>{
    const url=new URL(route.request().url()),pageNumber=Number(url.searchParams.get('page'))
    return route.fulfill({json:{data:{counts:(pageNumber?second:counts).filter(c=>url.searchParams.get('status')==='processed'?c.status!=='submitted':c.status==='submitted'),canApprove:true,page:pageNumber,hasMore:pageNumber===0&&second.length>0}}})
  })
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('hugu')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/inventory')
  return page.getByRole('region',{name:'盘点复核',exact:true})
}

test('batch approvals exclude self and stale counts, retain each conflict and continue other counts',async({page})=>{
  const counts=[count('one'),count('race'),count('three'),count('old',true),count('self',false,false)]
  const calls:string[]=[]
  await page.route('**/api/inventory/stock-counts/*/approve',async route=>{
    const id=route.request().url().split('/').at(-2)!
    calls.push(id)
    if(id==='race')return route.fulfill({status:409,json:{error:{code:'INVENTORY_CONFLICT',message:'盘点后库存已变动'}}})
    counts.find(c=>c.id===id)!.status='approved'
    return route.fulfill({json:{data:{id,status:'approved'}}})
  })
  await page.setViewportSize({width:375,height:812})
  const panel=await open(page,counts)
  await expect(panel.getByRole('article',{name:'盘点 batch-self'}).getByRole('checkbox')).toHaveCount(0)
  await panel.getByLabel('全选当前页可复核单据').check()
  await expect(panel).toContainText('已选 4 张')
  await expect(panel.getByRole('button',{name:'批量通过',exact:true})).toBeDisabled()
  await panel.getByRole('button',{name:'选中可通过'}).click()
  await expect(panel).toContainText('已选 3 张')
  await panel.getByRole('button',{name:'批量通过',exact:true}).click()
  await page.getByRole('alertdialog',{name:'批量核对盘点'}).getByRole('button',{name:'确认批量通过'}).click()
  await expect(panel).toContainText('本批3张：2张已通过，1张未完成')
  expect(calls).toEqual(['one','race','three'])
  const results=panel.getByRole('region',{name:'本批审核结果'})
  await expect(results).toContainText('商品race');await expect(results).toContainText('盘点后库存已变动')
  await expect(panel.getByRole('article',{name:'盘点 batch-race'})).toBeVisible()
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})

test('stale counts can be returned together with one reason and ambiguous retries retain original keys',async({page})=>{
  const counts=[count('old1',true),count('old2',true),count('self',true,false)]
  const calls:Array<{id:string;key:string;body:string|null}>=[]
  await page.route('**/api/inventory/stock-counts/*/reject',async route=>{
    const id=route.request().url().split('/').at(-2)!
    calls.push({id,key:route.request().headers()['idempotency-key'],body:route.request().postData()})
    if(id==='old2'&&calls.filter(c=>c.id===id).length===1)return route.abort('failed')
    counts.find(c=>c.id===id)!.status='rejected'
    return route.fulfill({json:{data:{id,status:'rejected'}}})
  })
  const panel=await open(page,counts)
  await panel.getByRole('button',{name:'选中需重盘'}).click()
  await panel.getByRole('button',{name:'批量退回',exact:true}).click()
  await expect(panel).toContainText('至少2字的批量退回原因');expect(calls).toHaveLength(0)
  await panel.getByLabel('批量退回原因').fill('库存已变化，请重新清点')
  const reject=async()=>{
    await panel.getByRole('button',{name:'批量退回',exact:true}).click()
    await page.getByRole('alertdialog',{name:'批量退回盘点'}).getByRole('button',{name:'确认批量退回'}).click()
  }
  await reject()
  await expect(panel).toContainText('本批2张：1张已退回，1张未完成')
  await panel.getByRole('button',{name:'选中需重盘'}).click();await reject()
  await expect(panel).toContainText('本批1张：1张已退回，0张未完成')
  expect(calls.map(c=>c.id)).toEqual(['old1','old2','old2'])
  expect(calls[2]).toEqual(calls[1])
  expect(JSON.parse(calls[0].body!)).toEqual({reason:'库存已变化，请重新清点'})
})

test('batch selection never carries unseen counts across pages or a refreshed view',async({page})=>{
  const panel=await open(page,[count('page1')],[count('page2')])
  await panel.getByLabel('全选当前页可复核单据').check();await expect(panel).toContainText('已选 1 张')
  await panel.getByRole('button',{name:'下一页'}).click()
  await expect(panel.getByRole('article',{name:'盘点 batch-page2'})).toBeVisible()
  await expect(panel).toContainText('已选 0 张')
  await panel.getByLabel('全选当前页可复核单据').check()
  await panel.getByRole('button',{name:'刷新盘点'}).click()
  await expect(panel).toContainText('已选 0 张')
  await expect(panel.getByRole('button',{name:'批量通过',exact:true})).toBeDisabled()
})
