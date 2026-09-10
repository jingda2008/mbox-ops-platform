import {readFile} from 'node:fs/promises'
import {expect,test,type Page} from '@playwright/test'
for(const width of [320,360])test(`marketing independent approvals, queue and refusal at ${width}px`,async({page,browser},testInfo)=>{
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  test.skip(!fixture.memberCardFixture,'Requires isolated fixture; no external marketing')
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  async function login(target:Page,employee:string){await target.goto(fixture.staffUrl);await target.getByLabel('门店口令').fill(fixture.dailyCredential);await target.getByRole('button',{name:/验证设备/}).click();await target.getByLabel('员工账号').fill(employee);await target.getByLabel('四位 PIN').fill(fixture.employeePin);await target.getByRole('button',{name:/进入工作台/}).click();await expect(target.getByTestId('normalized-workspace')).toBeVisible();await target.goto('/staff/member-management')}
  await page.setViewportSize({width,height:800});await login(page,fixture.employeeCode)
  const panel=page.getByRole('region',{name:'营销联系管理'}),code=`BROWSER_NOTICE_${width}_${Date.now()}`
  await panel.getByLabel('营销操作原因',{exact:true}).fill('隔离营销管理验收')
  await panel.getByText('新增告知版本',{exact:true}).click()
  await panel.getByLabel('规则编号',{exact:true}).fill(code)
  for(const [label,value] of [['实际经营主体','隔离测试运营主体'],['主体联系与客服','测试客服入口'],['营销用途与范围','门店活动，仅用于隔离测试'],['所用资料类型','本人验证手机号'],['停止联系方法','在联系偏好随时停止营销，不影响会员权益']])await panel.getByLabel(label!,{exact:true}).fill(value!)
  const local=(date:Date)=>new Date(date.getTime()+8*3600000).toISOString().slice(0,16)
  await panel.getByLabel('告知开始（北京时间）').fill(local(new Date(Date.now()-3600000)));await panel.getByLabel('告知截止（北京时间）').fill(local(new Date(Date.now()+86400000)))
  for(const [label,value] of [['每次同意最长','7'],['每人每日最多','1'],['每人每月最多','4']])await panel.getByLabel(label!,{exact:true}).fill(value!)
  await panel.getByLabel('允许联系开始',{exact:true}).fill('10:00');await panel.getByLabel('允许联系结束',{exact:true}).fill('20:00')
  await panel.getByRole('checkbox',{name:'短信',exact:true}).check();await panel.getByRole('checkbox',{name:'周一',exact:true}).check()
  await panel.getByRole('button',{name:'保存告知草稿',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'确认记录',exact:true}).click()
  const draft=panel.locator('article').filter({hasText:code});await expect(draft).toContainText('待审核');await expect(draft.getByRole('button',{name:'审核通过',exact:true})).toHaveCount(0)
  await draft.screenshot({path:testInfo.outputPath('marketing-notice-review.png')})
  for(const [employee,action] of [['hugu','审核通过'],['chenfangyu','发布告知']] as const){
    const context=await browser.newContext({viewport:{width,height:800}})
    try{const reviewer=await context.newPage();await login(reviewer,employee);const management=reviewer.getByRole('region',{name:'营销联系管理'});await management.getByLabel('营销操作原因',{exact:true}).fill('不同授权人员核对告知');await management.getByRole('button',{name:'读取告知版本',exact:true}).click();await management.locator('article').filter({hasText:code}).getByRole('button',{name:action,exact:true}).click();await reviewer.getByRole('alertdialog').getByRole('button',{name:'确认记录',exact:true}).click();await expect(management.getByRole('status')).toContainText('操作已记录')}
    finally{await context.close()}
  }
  await panel.getByRole('button',{name:'读取告知版本',exact:true}).click();await expect(draft).toContainText('已发布')
  await panel.getByText('客户联系任务与拒绝记录',{exact:true}).click()
  await panel.getByLabel('会员号或客户编号',{exact:true}).fill(`MBX-CARD${width}`);await panel.getByRole('button',{name:'查找客户',exact:true}).click();await panel.getByRole('button',{name:`MBX-CARD${width}`,exact:true}).click()
  await panel.getByRole('combobox',{name:'本人已同意的告知版本',exact:true}).selectOption({label:'BROWSER_MARKETING · 第1版'})
  const campaign=`browser-${width}-${Date.now()}`
  await panel.getByLabel('唯一活动批次',{exact:true}).fill(campaign);await panel.getByLabel('具体活动内容',{exact:true}).fill('隔离活动内容，不向真实客户发送');await panel.getByLabel('任务截止（北京时间）').fill(local(new Date(Date.now()+3600000)))
  await panel.getByRole('button',{name:'建立待核验任务',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'确认记录',exact:true}).click()
  const job=panel.locator('article').filter({hasText:campaign});await expect(job).toContainText('等待核验')
  await panel.getByRole('combobox',{name:'查找用途',exact:true}).selectOption('refusal');await panel.getByRole('button',{name:'查找客户',exact:true}).click();await panel.getByRole('button',{name:`MBX-CARD${width}`,exact:true}).click()
  await panel.getByRole('button',{name:'记录拒绝全部营销',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'确认记录',exact:true}).click();await expect(job).toContainText('已取消')
  await panel.getByRole('combobox',{name:'查找用途',exact:true}).selectOption('audit');await panel.getByRole('button',{name:'查找客户',exact:true}).click();await panel.getByRole('button',{name:`MBX-CARD${width}`,exact:true}).click()
  await panel.getByRole('button',{name:'读取许可历史',exact:true}).click()
  const history=panel.getByRole('region',{name:'本人许可历史'});await expect(history.getByText('停止全部营销',{exact:true})).toBeVisible();await expect(history.getByText('本人同意',{exact:true})).toBeVisible()
  await history.getByText('BROWSER_MARKETING 第1版原告知',{exact:true}).click()
  await expect(history.getByText(/数据范围：/)).toBeVisible()
  const size=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}));expect(size.content).toBeLessThanOrEqual(size.viewport+1);expect(errors).toEqual([])
})
