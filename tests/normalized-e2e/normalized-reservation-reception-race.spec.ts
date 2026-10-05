import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

// Mount the real panel and request adapter. Every endpoint is an in-memory
// protocol fixture; no business service or external network is contacted.
const repo = resolve(import.meta.dirname, '../..')
let javascript: string
let css: string

test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: repo, loader: 'tsx', contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ReservationReceptionPanel} from './src/normalized-ui/staff-actions/ReservationReceptionPanel';
      import {ReservationReception} from './src/normalized-ui/staff-actions/reservation-reception';
      const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
      const permissions=['reservation.manage','table.open'];
      const reservation=n=>({id:id(n),publicId:'reservation-'+n,customerName:n===3?'预约 A':'预约 B',guestCount:2,status:'arrived',aggregateVersion:2,tableLocks:[],reservationSnapshot:{receptionProtocol:1}});
      const f=window.fixture={creationEnabled:true,admissionEnabled:window.initialAdmissionEnabled!==false,calls:[],owner:id(1),pendingCandidates:[],pendingOptions:[]};
      const candidate=n=>({protocol:1,reservationId:id(n),reservationVersion:2,reservationGuestCount:2,reservationStatus:'arrived',partialSeatingSupported:false,sessions:[{tableSessionId:id(n+10),tableId:id(n+20),tableCode:n===3?'A01':'B01',guestCount:2,locationVersion:0,businessDate:'2026-10-05',openedAt:'2026-10-05 12:00:00+00'}]});
      const request=async(path,init)=>{
        f.calls.push({path,method:init?.method??'GET',body:init?.body});
        if(path.includes('/by-public-id/'))return{data:{protocol:1,operation:'create',employeeId:id(1),requestKey:'reception-create-original',reservation:{...reservation(3),publicId:'reception-'+id(100),status:'confirmed',ownerEmployeeId:id(1),customerId:id(9),reservationSnapshot:{receptionProtocol:1,physicalTablesPreassigned:false}},maskedContact:'138****5678'},meta:{replayed:true}};
        if(path.endsWith('native-reservation-capabilities'))return{data:{admissionCreateV1:f.admissionEnabled,receptionSeatV1:true}};
        if(path.includes('/options?')){const query=new URL(path,'http://fixture').searchParams;return new Promise(resolve=>f.pendingOptions.push(()=>resolve({data:{protocol:1,creationEnabled:f.creationEnabled,arrivalAt:query.get('arrivalAt'),expectedEndAt:query.get('expectedEndAt'),policy:{version:1,maxAdvanceDays:36500,defaultDurationMinutes:120,arrivalGraceMinutes:10},capacity:{totalGuests:40,committedGuests:6},physicalTablesPreassigned:false}})))};
        if(path.endsWith('/table-sessions')){const n=path.includes(id(3))?3:4;return new Promise(resolve=>f.pendingCandidates.push(()=>resolve({data:candidate(n)})))};
        if(init?.method==='POST')throw Object.assign(Error('已记录测试提交，未写业务'),{status:409,code:'RESERVATION_CAPACITY_UNAVAILABLE',commitDisposition:'not_committed'});
        const n=path.endsWith(id(3))?3:4;return{data:{protocol:1,reservation:reservation(n),seating:null}};
      };
      const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
      if(window.initialPendingCreate)storage.setItem('mbox.reservation-reception.v1:create',JSON.stringify({version:1,kind:'create',employeeId:id(1),scope:'isolated-race-fixture',key:'reception-create-original',publicId:'reception-'+id(100),confirmed:false}));
      let sequence=100;const api=new ReservationReception(request,()=>f.owner,storage,'isolated-race-fixture',()=>id(++sequence));
      function App(){const[selected,setSelected]=useState(3),[allowed,setAllowed]=useState(true),[employee,setEmployee]=useState(id(1));return <>
        <button onClick={()=>setSelected(3)}>选择预约 A</button><button onClick={()=>setSelected(4)}>选择预约 B</button>
        <button onClick={()=>setAllowed(false)}>撤销当前权限</button><button onClick={()=>setAllowed(true)}>恢复当前权限</button>
        <button onClick={()=>{f.owner=id(2);setEmployee(id(2))}}>切换当前员工</button>
        <ReservationReceptionPanel api={api} employeeId={employee} permissions={allowed?permissions:[]} selected={reservation(selected)} onClose={()=>{}} onOpenTables={()=>{}} onChanged={async()=>{}}/>
      </>;}
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
  })
  javascript = result.outputFiles.find(file => file.path.endsWith('.js'))!.text
  css = result.outputFiles.find(file => file.path.endsWith('.css'))!.text
})

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.abort())
  await page.setContent('<html lang="zh-CN"><body><main id="root"></main></body></html>')
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: javascript })
  await expect(page.getByRole('heading', { name: '预约 A · 接待详情' })).toBeVisible()
})

async function releaseCandidates(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as unknown as { fixture: { pendingCandidates: Array<() => void> } }).fixture
    const resolve = fixture.pendingCandidates.shift()
    if (!resolve) throw Error('No pending candidate request')
    resolve()
  })
  await expect(page.getByRole('button', { name: '重新读取接待详情' })).toBeEnabled()
}
async function noStaleCandidates(page: Page) {
  await expect(page.getByRole('group', { name: '本组全部实际桌次' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认本组实际入座' })).toHaveCount(0)
}

test('discards late A candidates after selecting B, then submits only fresh B sessions', async ({ page }) => {
  await page.getByRole('button', { name: '读取可关联实际桌次' }).click()
  await page.getByRole('button', { name: '选择预约 B' }).click()
  await expect(page.getByRole('heading', { name: '预约 B · 接待详情' })).toBeVisible()
  await releaseCandidates(page)
  await noStaleCandidates(page)
  await page.getByRole('button', { name: '读取可关联实际桌次' }).click()
  await releaseCandidates(page)
  await page.getByLabel('B01 · 实际 2 人', { exact: true }).check()
  await expect(page.getByLabel('A01 · 实际 2 人', { exact: true })).toHaveCount(0)
  await page.getByLabel('实际接待核对说明', { exact: true }).fill('确认预约 B 的实际桌位')
  await page.getByLabel('本组全部桌位已安排完毕，已核对实际人数', { exact: true }).check()
  await page.getByRole('button', { name: '确认本组实际入座', exact: true }).click()
  await expect(page.getByText('已记录测试提交，未写业务', { exact: true })).toBeVisible()
  const posts = await page.evaluate(() => (window as unknown as { fixture: { calls: Array<{ method: string; path: string; body: string }> } }).fixture.calls.filter(call => call.method === 'POST'))
  expect(posts).toHaveLength(1)
  expect(posts[0].path).toContain('00000000-0000-4000-8000-000000000004/seat')
  expect(JSON.parse(posts[0].body).sessions).toEqual([{ tableSessionId: '00000000-0000-4000-8000-000000000014', expectedTableId: '00000000-0000-4000-8000-000000000024', expectedLocationVersion: 0, expectedGuestCount: 2 }])
})

test('A to B to A does not revive the earlier A read', async ({ page }) => {
  await page.getByRole('button', { name: '读取可关联实际桌次' }).click()
  await page.getByRole('button', { name: '选择预约 B' }).click()
  await expect(page.getByRole('heading', { name: '预约 B · 接待详情' })).toBeVisible()
  await page.getByRole('button', { name: '选择预约 A' }).click()
  await expect(page.getByRole('heading', { name: '预约 A · 接待详情' })).toBeVisible()
  await releaseCandidates(page)
  await noStaleCandidates(page)
})

test('permission removal and restoration invalidates the in-flight candidate read', async ({ page }) => {
  await page.getByRole('button', { name: '读取可关联实际桌次' }).click()
  await page.getByRole('button', { name: '撤销当前权限' }).click()
  await page.getByRole('button', { name: '恢复当前权限' }).click()
  await expect(page.getByRole('heading', { name: '预约 A · 接待详情' })).toBeVisible()
  await releaseCandidates(page)
  await noStaleCandidates(page)
})

test('an employee switch cannot republish the former employee candidates or error', async ({ page }) => {
  await page.getByRole('button', { name: '读取可关联实际桌次' }).click()
  await page.getByRole('button', { name: '切换当前员工' }).click()
  await releaseCandidates(page)
  await noStaleCandidates(page)
  await expect(page.getByText(/员工已切换/)).toHaveCount(0)
})

test('late capacity options cannot survive permission removal and restoration', async ({ page }) => {
  await page.getByRole('button', { name: '登记电话或员工代订', exact: true }).click()
  await page.getByLabel('到店日期（上海）', { exact: true }).fill('2099-10-05')
  await page.getByLabel('到店时间（上海）', { exact: true }).fill('18:00')
  await page.getByLabel('预计结束日期（上海）', { exact: true }).fill('2099-10-05')
  await page.getByLabel('预计结束时间（上海）', { exact: true }).fill('20:00')
  await page.getByRole('button', { name: '读取名额与规则', exact: true }).click()
  await page.getByRole('button', { name: '撤销当前权限' }).click()
  await page.getByRole('button', { name: '恢复当前权限' }).click()
  await page.evaluate(() => (window as unknown as { fixture: { pendingOptions: Array<() => void> } }).fixture.pendingOptions.shift()!())
  await expect(page.getByRole('button', { name: '登记电话或员工代订', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '登记电话或员工代订', exact: true }).click()
  await expect(page.getByText(/该时段总接待容量/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认登记名额', exact: true })).toBeDisabled()
})

for (const creationEnabled of [true, false, undefined]) {
  test(`only explicit creationEnabled=true permits a new registration: ${creationEnabled}`, async ({ page }) => {
    await page.evaluate(value => { (window as unknown as {fixture:{creationEnabled:boolean|undefined}}).fixture.creationEnabled=value }, creationEnabled)
    await page.getByRole('button', { name: '登记电话或员工代订', exact: true }).click()
    await page.getByLabel('到店日期（上海）', { exact: true }).fill('2099-10-05')
    await page.getByLabel('到店时间（上海）', { exact: true }).fill('18:00')
    await page.getByLabel('预计结束日期（上海）', { exact: true }).fill('2099-10-05')
    await page.getByLabel('预计结束时间（上海）', { exact: true }).fill('20:00')
    await page.getByRole('button', { name: '读取名额与规则', exact: true }).click()
    await page.evaluate(() => (window as unknown as { fixture: { pendingOptions: Array<() => void> } }).fixture.pendingOptions.shift()!())
    const submit=page.getByRole('button', { name:'确认登记名额',exact:true })
    if (creationEnabled===true) await expect(submit).toBeEnabled()
    else {await expect(submit).toBeDisabled();await expect(page.getByText('新预约登记暂未开放，仍可处理原预约及核对原请求。',{exact:true})).toBeVisible()}
    expect(await page.evaluate(()=>(window as unknown as {fixture:{calls:Array<{method:string}>}}).fixture.calls.filter(c=>c.method==='POST'))).toHaveLength(0)
  })
}

test('closed creation hides the form while existing reception remains usable at 200 percent',async({page})=>{
  await page.setContent('<html lang="zh-CN"><body><main id="root"></main></body></html>')
  await page.evaluate(()=>{(window as unknown as {initialAdmissionEnabled:boolean}).initialAdmissionEnabled=false})
  await page.addStyleTag({content:css+' body {zoom:2} '})
  await page.addScriptTag({content:javascript})
  await expect(page.getByText('新预约登记暂未开放，仍可处理原预约及核对原请求。',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'登记电话或员工代订',exact:true})).toHaveCount(0)
  await expect(page.getByRole('group',{name:'登记接待名额',exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'读取可关联实际桌次',exact:true}).click()
  await releaseCandidates(page)
  await expect(page.getByLabel('A01 · 实际 2 人',{exact:true})).toBeVisible()
  const layout=await page.locator('.staff-reception').evaluate(element=>({overflow:element.scrollWidth>element.clientWidth+1,buttons:[...element.querySelectorAll('button')].map(button=>button.getBoundingClientRect().height)}))
  expect(layout.overflow).toBe(false)
  expect(layout.buttons.every(height=>height>=44)).toBe(true)
})

test('closed creation retains the original pending recovery without options or a replacement POST',async({page})=>{
  await page.setContent('<html lang="zh-CN"><body><main id="root"></main></body></html>')
  await page.evaluate(()=>{Object.assign(window,{initialAdmissionEnabled:false,initialPendingCreate:true})})
  await page.addStyleTag({content:css})
  await page.addScriptTag({content:javascript})
  await expect(page.getByText('新预约登记暂未开放，仍可处理原预约及核对原请求。',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'核对原预约创建请求',exact:true}).click()
  await expect(page.getByText('预约已登记，尚未安排实际桌位',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'核对原预约创建请求',exact:true})).toHaveCount(0)
  const calls=await page.evaluate(()=>(window as unknown as {fixture:{calls:Array<{path:string;method:string}>}}).fixture.calls)
  expect(calls.filter(c=>c.path.includes('/by-public-id/')).map(c=>c.path)).toEqual(['/api/staff/reservation-receptions/by-public-id/reception-00000000-0000-4000-8000-000000000100?requestKey=reception-create-original'])
  expect(calls.some(c=>c.path.includes('/options?')||c.method==='POST')).toBe(false)
})
