import { expect, test, type Page } from '@playwright/test'
const dashboard = () => ({accountRef:'fixture-account-a',promoter:{canConfirmStatement:true},balance:{accruedMinor:'900',paidMinor:'400',balanceMinor:'500'},batches:[{id:'batch-a',offerCode:'ABCDEFGH2345',acceptingClaims:true,claims:2,arrivals:1,rule:{title:'餐后小聚',claimFrom:'2026-11-13T00:00:00Z',claimUntil:'2026-11-14T00:00:00Z',offer:{kind:'discount',discountBps:1500,maximumMinor:2000}}}],visits:[{visitNumber:'ANON0001',date:'2026-11-13',arrived:true,closed:false,qualifiedConsumptionMinor:'9000',accruedCommissionMinor:null}],statements:[{id:'statement-a',amountMinor:'900',paidMinor:'400',createdAt:'2026-11-13T00:00:00Z',status:'pending'}],nextCursors:{batches:null,visits:null,statements:'cursor-old'}})
async function setup(page:Page) {
 let authenticated=true,confirmed=false,dropNext=false,otherAccount=false
 const writes:{key:string|undefined;recovery:string|undefined;body:unknown}[]=[],posters:string[]=[]
 await page.route('**/cooperation/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/api/')[1]
  if(path==='login'){authenticated=true;return route.fulfill({json:{data:{authenticated:true}}})}
  if(path==='logout'){authenticated=false;return route.fulfill({json:{data:{authenticated:false}}})}
  if(!authenticated)return route.fulfill({status:401,json:{error:{code:'NOT_AUTHORIZED'}}})
  if(path==='partner'){const data=dashboard();if(otherAccount)data.accountRef='fixture-account-b';return route.fulfill({json:{data}})}
  if(path?.startsWith('poster/')){posters.push(path);return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')})}
  if(path==='history')return route.fulfill({json:{data:[{id:'old-statement',createdAt:'2026-11-12T00:00:00Z',amountMinor:'100',paidMinor:'0',status:'confirmed'}],meta:{nextCursor:null}}})
  if(path?.startsWith('statement/'))return route.fulfill({json:{data:{statement:{id:'statement-a',sourceStatementId:null,amountMinor:'900',status:confirmed?'confirmed':'pending'},lines:[{visitNumber:'ANON0001',date:'2026-11-13',basisMinor:'9000',deltaMinor:'900'}]}}})
  if(path==='statement-response'){
   writes.push({key:request.headers()['idempotency-key'],recovery:request.headers()['x-channel-recovery'],body:request.postDataJSON()});confirmed=true
   if(dropNext){dropNext=false;return route.abort('connectionreset')}
   return route.fulfill({json:{data:{id:'statement-a'},meta:{replayed:request.headers()['x-channel-recovery']==='1'}}})
  }
  return route.fulfill({status:404,json:{error:{message:'not found'}}})
 })
 return {writes,posters,drop:()=>{dropNext=true},expire:()=>{authenticated=false},switch:()=>{otherAccount=true}}
}
test('official cooperation page shows anonymous totals, correct discount, poster download and older settlement summaries',async({page})=>{
 const h=await setup(page);const navigation=await page.goto('/cooperation/');expect(navigation?.headers()['cache-control']).toContain('no-store')
 await expect(page.locator('#dashboard')).toBeVisible();await expect(page.locator('#batches')).toContainText('8.5 折')
 await expect(page.locator('#visits')).toContainText('待核对');await expect(page.locator('#balance')).toContainText('¥5.00')
 await page.getByRole('button',{name:'更多结算单'}).click();await expect(page.locator('#statements')).toContainText('¥1.00');await expect(page.locator('#balance')).toContainText('¥5.00');expect(h.writes).toHaveLength(0)
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载专属推广图'}).click();await download;expect(h.posters).toEqual(['poster/batch-a']);await expect(page.locator('#poster-image')).toBeVisible();await page.getByRole('button',{name:'关闭图片'}).click();await expect(page.locator('#poster-preview')).toBeHidden()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:'artifacts/normalized-browser/cooperation-mobile.png',fullPage:true})
 await page.setViewportSize({width:1440,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:'artifacts/normalized-browser/cooperation-desktop.png',fullPage:true})
})
test('lost settlement response survives reload and recovers the same key without duplicate command',async({page})=>{
 const h=await setup(page);await page.goto('/cooperation/');await page.getByRole('button',{name:'查看汇总'}).click();h.drop()
 await page.getByRole('button',{name:'确认汇总金额'}).click();await expect(page.locator('#pending')).toBeVisible();expect(h.writes).toHaveLength(1)
 await page.reload();await expect(page.locator('#pending')).toBeVisible();await page.getByRole('button',{name:'恢复原操作'}).click()
 await expect(page.locator('#message')).toContainText('已保存');expect(h.writes).toHaveLength(2);expect(h.writes[1]?.key).toBe(h.writes[0]?.key);expect(h.writes[1]?.recovery).toBe('1');expect(h.writes[1]?.body).toEqual(h.writes[0]?.body)
 await expect(page.locator('#pending')).toBeHidden();await expect(page.getByRole('button',{name:'确认汇总金额'})).toBeHidden()
})
test('account expiration clears displayed private records and account switching cannot recover another account command',async({page})=>{
 const h=await setup(page);await page.goto('/cooperation/');await page.getByRole('button',{name:'查看汇总'}).click();h.drop();await page.getByRole('button',{name:'确认汇总金额'}).click();await expect(page.locator('#pending')).toBeVisible()
 h.expire();await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.locator('#auth')).toBeVisible();await expect(page.locator('#visits')).toBeEmpty();await expect(page.locator('#detail-body')).toBeEmpty()
 h.switch();await page.getByLabel('账号',{exact:true}).fill('partner-b');await page.getByLabel('密码',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#dashboard')).toBeVisible();await expect(page.locator('#pending')).toBeHidden();expect(h.writes).toHaveLength(1)
})
test('invitation stays out of requests and browser history; activation response loss offers login recovery',async({page})=>{
 const calls:string[]=[];await page.route('**/cooperation/api/**',async route=>{calls.push(new URL(route.request().url()).pathname);await route.abort('connectionreset')})
 await page.goto('/cooperation/#invite='+'A'.repeat(43));await expect(page).toHaveURL(/\/cooperation\/$/);await expect(page.locator('#auth-title')).toHaveText('开通／重置合作账号');expect(calls).toEqual([])
 await page.getByLabel('账号',{exact:true}).fill('partner-a');await page.getByLabel('密码',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'保存账号并登录'}).click();await expect(page.locator('#message')).toContainText('返回登录');await page.getByRole('button',{name:'已开通，返回登录'}).click();await expect(page.locator('#auth-title')).toHaveText('合作账号登录');expect(calls).toEqual(['/cooperation/api/activate'])
})
