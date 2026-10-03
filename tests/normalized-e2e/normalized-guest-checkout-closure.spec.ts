import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
const fixtureFile = process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json'
async function setup(page:any,quantity:number){
  const f=JSON.parse(await readFile(fixtureFile,'utf8'))
  await page.goto(f.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await page.getByLabel('搜索菜单商品').fill(f.orderableProductName)
  for(let i=0;i<quantity;i++){
    await page.getByRole('button',{name:`${i===0?'加入':'增加'}${f.orderableProductName}`,exact:true}).click()
    await expect(page.locator('.menu-cart-summary-copy strong')).toContainText(`${i+1}`)
  }
  await page.getByRole('button',{name:'查看已选',exact:true}).click()
  return f
}
async function confirm(page:any){
  await page.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:/确认订单并微信支付/}).click()
  await page.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单',exact:true}).click()
}
test('product notes reach every committed portion in shared checkout',async({page})=>{
  const f=await setup(page,4)
  await page.getByLabel(`${f.orderableProductName}商品备注`).fill('本份少冰不加糖')
  let observed:any
  await page.route('**/api/guest/shared-cart/checkout',async route=>{
    const response=await route.fetch()
    observed={request:route.request().postDataJSON(),status:response.status(),response:await response.json()}
    await route.fulfill({response})
  })
  await confirm(page)
  await expect(page.getByRole('dialog',{name:'订单与支付状态'})).toBeVisible()
  expect(observed.status).toBe(201)
  expect(observed.request.lineNotes).toHaveLength(4)
  expect(observed.response.data.cart.items.every((x:any)=>x.note==='本份少冰不加糖')).toBe(true)
})
test('lost committed checkout response recovers after reload with an empty cart and the original key',async({page})=>{
  await setup(page,5)
  const calls:any[]=[]
  await page.route('**/api/guest/shared-cart/checkout',async route=>{
    const headers=route.request().headers(),body=route.request().postDataJSON()
    const response=await route.fetch(),json=await response.json()
    calls.push({key:headers['idempotency-key'],device:headers['x-mbox-guest-device'],body,status:response.status(),json})
    if(calls.length===1) await route.abort('failed')
    else await route.fulfill({response})
  })
  await confirm(page)
  await expect(page.getByTestId('guest-checkout-recovery')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('guest-checkout-recovery')).toBeVisible()
  await expect(page.getByRole('button',{name:'查看已选',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'恢复原订单',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'订单与支付状态'})).toBeVisible()
  expect(calls).toHaveLength(2)
  expect(calls[0].status).toBe(201)
  expect(calls[1].status).toBe(200)
  expect(calls[1].key).toBe(calls[0].key)
  expect(calls[1].device).toBe(calls[0].device)
  expect(calls[1].body).toEqual(calls[0].body)
  expect(calls[1].json.data.order.publicId).toBe(calls[0].json.data.order.publicId)
  await expect(page.getByTestId('guest-checkout-recovery')).toHaveCount(0)
})
test('portion splitting requires the same duplicate confirmation as an unsplit cart',async({page})=>{
  const f=JSON.parse(await readFile(fixtureFile,'utf8'))
  let device=''
  page.on('request',r=>{if(r.url().includes('/api/guest/menu/'))device=r.headers()['x-mbox-guest-device']||device})
  await page.goto(f.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expect.poll(()=>device).not.toBe('')
  const headers={'x-mbox-guest-device':device}
  const menu=await (await page.request.get('/api/guest/menu/products',{headers})).json()
  const product=menu.data.find((x:any)=>x.name!==f.orderableProductName && x.productKind==='single' && x.available && x.amountMinor>0)
  expect(product).toBeTruthy()
  let cart=(await (await page.request.get('/api/guest/shared-cart',{headers})).json()).data
  if(cart.lines.length){
    const clear=await page.request.post('/api/guest/shared-cart/clear',{headers:{...headers,'idempotency-key':'audit-clean-cart-'+Date.now()},data:{expectedGeneration:cart.generation,expectedVersion:cart.version}})
    expect(clear.status()).toBe(200);cart=(await clear.json()).data
  }
  let r=await page.request.post('/api/guest/shared-cart/lines',{headers:{...headers,'idempotency-key':'audit-split-add-'+Date.now()},data:{productId:product.productId,delta:3,expectedGeneration:cart.generation,expectedVersion:cart.version}})
  expect(r.status()).toBe(200);cart=(await r.json()).data
  const first=await page.request.post('/api/guest/shared-cart/checkout',{headers:{...headers,'idempotency-key':'audit-split-first-'+Date.now()},data:{expectedGeneration:cart.generation,expectedVersion:cart.version}})
  expect(first.status()).toBe(201)
  cart=(await (await page.request.get('/api/guest/shared-cart',{headers})).json()).data
  r=await page.request.post('/api/guest/shared-cart/lines',{headers:{...headers,'idempotency-key':'audit-split-add2-'+Date.now()},data:{productId:product.productId,delta:3,expectedGeneration:cart.generation,expectedVersion:cart.version}})
  expect(r.status()).toBe(200);cart=(await r.json()).data
  const body={expectedGeneration:cart.generation,expectedVersion:cart.version}
  const unsplit=await page.request.post('/api/guest/shared-cart/checkout',{headers:{...headers,'idempotency-key':'audit-unsplit-'+Date.now()},data:body})
  const unsplitJson=await unsplit.json()
  expect(unsplit.status()).toBe(409)
  expect(unsplitJson.error.code).toBe('GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED')
  const split=await page.request.post('/api/guest/shared-cart/checkout',{headers:{...headers,'idempotency-key':'audit-split-'+Date.now()},data:{...body,lineNotes:[{portionId:cart.lines[0].portionIds[0],note:'少冰'}]}})
  const splitJson=await split.json()
  expect(split.status()).toBe(409)
  expect(splitJson.error.code).toBe('GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED')
  expect(splitJson.error.details.conflictingOrderId).toBe(unsplitJson.error.details.conflictingOrderId)
  const confirmed=await page.request.post('/api/guest/shared-cart/checkout',{headers:{...headers,'idempotency-key':'closure-confirmed-'+Date.now()},data:{...body,confirmedDuplicateOrderId:splitJson.error.details.conflictingOrderId,lineNotes:[{portionId:cart.lines[0].portionIds[0],note:'少冰'}]}})
  expect(confirmed.status()).toBe(201)
  expect((await confirmed.json()).data.cart.items.reduce((n:number,x:any)=>n+x.quantity,0)).toBe(3)
})
