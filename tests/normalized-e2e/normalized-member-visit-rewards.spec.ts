import { readFile } from 'node:fs/promises'
import { expect,test,type Page } from '@playwright/test'
async function login(page:Page,employee='liyan'){
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  test.skip(!fixture.memberVisitRewardFixture,'Requires opt-in isolated reward fixture')
  await page.goto(fixture.staffUrl);await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(employee);await page.getByLabel('四位 PIN').fill(fixture.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}
async function management(page:Page){
  await page.goto('/staff/member-management#work=member-rules')
  const panel=page.getByRole('region',{name:'累计签到奖励',exact:true}),toggle=page.getByRole('button',{name:/会员经营配置中心/})
  await expect(toggle).toBeVisible()
  if(!await panel.isVisible())await toggle.click()
  await expect(panel).toBeVisible()
  return panel
}
async function confirm(page:Page){await page.getByRole('alertdialog').getByRole('button',{name:'确认执行',exact:true}).click()}
async function visit(page:Page,member:string){
  await page.goto('/staff/tasks');await page.getByLabel('输入会员号或核销码').fill(member);await page.getByRole('button',{name:'查询活动与权益',exact:true}).click()
  await page.getByRole('group',{name:'选择签到方式'}).getByRole('button',{name:'仅到店签到',exact:true}).click()
  const panel=page.getByRole('region',{name:'仅到店签到',exact:true});await panel.getByRole('button',{name:'确认到店签到',exact:true}).click()
  await expect(panel).toContainText('待审批 1 轮');return panel
}
test('configurable attendance rewards require individual or daily batch approval and survive a lost reply',async({page,browser,baseURL},testInfo)=>{
  test.setTimeout(90000)
  await page.setViewportSize({width:390,height:844});await login(page,'chenfangyu')
  let panel=await management(page)
  await page.getByRole('button',{name:'读取活动',exact:true}).click()
  await panel.getByText('配置签到次数与赠品',{exact:true}).click()
  await panel.getByLabel('签到赠品活动',{exact:true}).selectOption({label:'测试累计签到赠品 · 测试发券小食 · 每轮 1 份'})
  await expect(panel.getByLabel('每累计签到次数')).toHaveValue('3')
  await panel.getByLabel('每累计签到次数').fill('1');await panel.getByLabel('签到奖励操作原因').fill('隔离浏览器启用配置')
  await panel.getByRole('button',{name:'启用签到奖励'}).click();await confirm(page)
  await expect(panel.getByRole('status')).toContainText('操作已记录')
  const scan=await browser.newPage({baseURL,viewport:{width:390,height:844}}),review=await browser.newPage({baseURL,viewport:{width:390,height:844}})
  try {
  await login(scan,'liyan');await login(review,'hugu')
  for(const member of ['MBX-REWARD-A','MBX-REWARD-B','MBX-REWARD-C'])await visit(scan,member)
  panel=await management(review);await panel.getByRole('button',{name:'读取签到奖励',exact:true}).click()
  await expect(panel.locator('article')).toHaveCount(3)
  const first=panel.locator('article').filter({hasText:'MBX-REWARD-A'})
  await panel.getByLabel('签到奖励操作原因').fill('隔离单独审批确认')
  let lost=false
  await review.route('**/api/staff/member-visit-rewards',async route=>{
    if(route.request().method()!=='POST'||route.request().postDataJSON().action!=='approve'||lost)return route.continue()
    lost=true;const committed=await route.fetch();expect(committed.status()).toBe(200);await route.abort('failed')
  })
  await first.getByRole('button',{name:'单独批准并发券',exact:true}).click();await confirm(review)
  await expect(panel.getByRole('status')).toBeVisible()
  await panel.getByRole('button',{name:'读取签到奖励',exact:true}).click();await expect(panel.locator('article')).toHaveCount(2)
  const dateText=await panel.getByText(/当前营业日：/).textContent(),day=dateText!.match(/\d{4}-\d{2}-\d{2}/)![0]
  await panel.getByLabel('达标营业日（留空看全部）').fill(day)
  await panel.getByRole('button',{name:'读取签到奖励',exact:true}).click();await expect(panel.locator('article')).toHaveCount(2)
  await panel.getByRole('button',{name:'选择已读取的待审批（最多50条）'}).click()
  await panel.getByRole('button',{name:'批量批准并发券（2）'}).click();await confirm(review)
  await expect(panel.getByRole('status')).toContainText('已发到会员券包')
  await panel.getByRole('combobox',{name:'审批状态',exact:true}).selectOption('issued');await panel.getByRole('button',{name:'读取签到奖励',exact:true}).click()
  await expect(panel.locator('article')).toHaveCount(3);await expect(panel.locator('article').first()).toContainText('已核销 0 份')
  await panel.screenshot({path:testInfo.outputPath('attendance-reward-approved-mobile.png')})
  expect(await review.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1)
  await scan.goto('/staff/tasks');await scan.getByLabel('输入会员号或核销码').fill('MBX-REWARD-A');await scan.getByRole('button',{name:'查询活动与权益',exact:true}).click()
  await scan.getByRole('group',{name:'选择签到方式'}).getByRole('button',{name:'仅到店签到',exact:true}).click()
  await expect(scan.getByRole('region',{name:'会员活动与权益查询'})).toContainText('测试累计签到赠品')
  const visits=scan.getByRole('region',{name:'仅到店签到',exact:true});await expect(visits).toContainText('已发券 1 轮')
  await visits.getByRole('button',{name:'撤回误签到'}).click();await scan.getByRole('alertdialog').getByRole('button',{name:'确认撤回',exact:true}).click()
  await visits.getByRole('button',{name:'确认到店签到',exact:true}).click();await expect(visits).toContainText('待审批 0 轮，已发券 1 轮')
  panel=await management(review);await panel.getByRole('combobox',{name:'审批状态',exact:true}).selectOption('issued');await panel.getByRole('button',{name:'读取签到奖励',exact:true}).click()
  await expect(panel.locator('article').filter({hasText:'MBX-REWARD-A'}).getByRole('alert')).toContainText('原计次不能再次领奖')
  } finally {await scan.close();await review.close()}
})
