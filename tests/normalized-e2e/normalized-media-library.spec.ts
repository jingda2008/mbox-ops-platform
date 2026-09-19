import {readFile} from 'node:fs/promises'
import {randomBytes,randomUUID} from 'node:crypto'
import {expect,test} from '@playwright/test'
import sharp from 'sharp'

test('员工图库按用途分页、选中不重载、权限缓存及正常网和弱网图片对照',async({page,context},testInfo)=>{
  test.setTimeout(150_000)
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('liyan')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const images:string[]=[]
  for(let index=0;index<15;index++){
    const bytes=await sharp(randomBytes(400*400*3),{raw:{width:400,height:400,channels:3}}).jpeg({quality:70}).toBuffer()
    const response=await context.request.post('/api/staff/media-assets',{headers:{'idempotency-key':'media-browser-'+randomUUID()},data:{
      purpose:index<13?'community_activity':'home_content',fileName:`audit-image-${index}.jpg`,mimeType:'image/jpeg',base64:bytes.toString('base64'),
    }})
    expect(response.status(),await response.text()).toBe(201)
    if(index<12)images.push((await response.json()).data.staffUrl)
  }
  const lists:string[]=[]
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/staff/media-assets'&&request.method()==='GET')lists.push(url.search)})
  await page.goto('/staff/customer-experience')
  const activity=page.getByRole('region',{name:'活动报名运营工作台'})
  await activity.getByRole('button',{name:'打开工作台'}).click()
  await activity.getByRole('button',{name:'新建活动草稿'}).click()
  const picker=activity.locator('.media-asset-picker').first()
  await picker.getByRole('button',{name:/上传/}).click()
  await expect(picker.locator('.media-asset-grid > button')).toHaveCount(12)
  expect(lists).toEqual(['?purpose=community_activity&limit=12'])
  const image=picker.locator('.media-asset-grid img').first()
  expect(await image.getAttribute('src')).toContain('?size=thumbnail')
  expect(await image.getAttribute('loading')).toBe('lazy')
  await picker.locator('.media-asset-grid > button').first().click()
  await expect(picker.getByAltText('已选图片预览')).toBeVisible()
  expect(lists).toHaveLength(1)
  await picker.getByRole('button',{name:'加载更多图片'}).click()
  await expect.poll(()=>picker.locator('.media-asset-grid > button').count()).toBeGreaterThan(12)
  expect(lists[1]).toContain('before=MA')
  expect(await picker.locator('.media-asset-grid').innerText()).not.toMatch(/audit-image-1[34]\.jpg/)
  await testInfo.attach('media-picker',{body:await picker.screenshot(),contentType:'image/png'})

  // Compare identical assets and browser with cache disabled. These local
  // measurements do not claim production/store-device latency acceptance.
  const cdp=await context.newCDPSession(page)
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true})
  const measurements=[]
  for(const [network,latency,throughput] of [['normal',0,-1],['weak',120,180*1024]] as const){
    await cdp.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:throughput,uploadThroughput:throughput})
    for(const variant of ['original','thumbnail'] as const){
      const value=await page.evaluate(async({images,variant})=>{
        const start=performance.now();let bytes=0
        for(let i=0;i<images.length;i+=4){
          const sizes=await Promise.all(images.slice(i,i+4).map(async path=>{
            const response=await fetch(path+(variant==='thumbnail'?'?size=thumbnail':''),{cache:'reload'})
            if(!response.ok)throw new Error(`image HTTP ${response.status}`)
            return(await response.arrayBuffer()).byteLength
          }))
          bytes+=sizes.reduce((total,size)=>total+size,0)
        }
        return{milliseconds:performance.now()-start,bytes,count:images.length}
      },{images,variant})
      measurements.push({network,variant,...value})
    }
  }
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})
  await testInfo.attach('same-assets-network-comparison',{body:JSON.stringify({scope:'isolated local database and Chromium; not field acceptance',measurements},null,2),contentType:'application/json'})
  for(const network of ['normal','weak']){
    const before=measurements.find(value=>value.network===network&&value.variant==='original')!
    const after=measurements.find(value=>value.network===network&&value.variant==='thumbnail')!
    expect(after.bytes).toBeLessThan(before.bytes*0.75)
    expect(after.count).toBe(before.count)
  }
  for(const variant of ['original','thumbnail'])expect(measurements.find(value=>value.network==='normal'&&value.variant===variant)!.bytes)
    .toBe(measurements.find(value=>value.network==='weak'&&value.variant===variant)!.bytes)
  const cached=await context.request.get(images[0]!+'?size=thumbnail')
  const etag=cached.headers().etag!
  expect((await context.request.get(images[0]!+'?size=thumbnail',{headers:{'if-none-match':etag}})).status()).toBe(304)
  await context.clearCookies()
  expect((await context.request.get(images[0]!+'?size=thumbnail',{headers:{'if-none-match':etag}})).status()).toBe(401)
})
