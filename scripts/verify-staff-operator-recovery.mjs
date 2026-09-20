import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
const out = process.env.STAFF_RECOVERY_EVIDENCE_DIR ?? 'artifacts/staff-operator-recovery';
fs.mkdirSync(out, { recursive: true });
if (!process.env.NORMALIZED_E2E_FIXTURE_FILE)
    throw new Error('需要隔离测试 fixture，禁止使用生产门店');
const fixture = JSON.parse(fs.readFileSync(process.env.NORMALIZED_E2E_FIXTURE_FILE, 'utf8'));
const base = `http://localhost:${Number(process.env.NORMALIZED_E2E_PORT ?? 18894)}`;
if (new URL(fixture.staffUrl,base).origin !== base)
    throw new Error('fixture 必须与本机隔离服务对应');
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const checks = [];
let currentPage;
async function login(code = 'liyan', width = 390) { const context = await browser.newContext({ baseURL: base, permissions: ['camera'], viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' }); const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(10000); await page.goto('/'); await page.getByLabel('门店口令').fill(fixture.dailyCredential); await page.getByRole('button', { name: /验证设备/ }).click(); await page.getByLabel('员工账号').fill(code); await page.getByLabel('四位 PIN').fill(fixture.employeePin); await page.getByRole('button', { name: /进入工作台/ }).click(); await expect(page.getByTestId('normalized-workspace')).toBeVisible(); return { page, context }; }
async function scenario(name, fn) { const start = Date.now(); try {
    const evidence = await fn();
    checks.push({ name, result: 'passed', evidence, durationMs: Date.now() - start });
    console.log('PASS', name);
}
catch (e) {
    checks.push({ name, result: 'failed', error: e.message });
    console.log('FAIL', name, e.message.slice(0, 800));
    try {
        fs.writeFileSync(out + '/failure-' + checks.length + '.txt', await currentPage.locator('body').innerText());
        await currentPage.screenshot({ path: out + '/failure-' + checks.length + '.png', fullPage: true });
    }
    catch { }
} fs.writeFileSync(out + '/regression.json', JSON.stringify(checks, null, 2)); }
async function table(page) { await page.goto('/staff/live'); await page.getByRole('button', { name: /^W01 \d+人 · / }).click(); }
async function section(page, name) { const b = page.getByRole('navigation', { name: '客户运营工作' }).getByRole('button', { name, exact: true }); await b.click(); }
await scenario('OP-05 stale, offline and recovered home', async () => {
    const { page, context } = await login('tom');
    await page.route('**/api/staff/workspace', r => r.abort('failed'));
    await page.getByRole('button', { name: '刷新工作台' }).click();
    await expect(page.locator('.normalized-freshness')).toContainText('更新失败');
    await expect(page.locator('.normalized-freshness')).not.toContainText('连接正常');
    await context.setOffline(true);
    await expect(page.locator('.normalized-freshness')).toContainText('已离线');
    await context.setOffline(false);
    await page.unroute('**/api/staff/workspace');
    await page.getByRole('button', { name: '刷新工作台' }).click();
    await expect(page.locator('.normalized-freshness')).toContainText('连接正常');
    await page.screenshot({ path: out + '/home-recovered.png', fullPage: true });
    await context.close();
});
await scenario('OP-04 deep-link initialization failure and in-place retry', async () => {
    const { page, context } = await login('tom');
    await page.route('**/api/staff/workspace', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '隔离测试暂不可用' } }) }));
    await page.goto('/staff/live');
    await expect(page.getByRole('button', { name: '重新读取工作台' })).toBeVisible();
    await page.unroute('**/api/staff/workspace');
    await page.getByRole('button', { name: '重新读取工作台' }).click();
    await expect(page.locator('.staff-actions-panel')).toBeVisible();
    await context.close();
});
await scenario('OP-01 and OP-14 cash recovery and action notice survive refresh, reopen, employee switch and reload', async () => {
    const { page, context } = await login();
    await table(page);
    await page.getByRole('button', { name: '协助点单', exact: true }).click();
    const order = page.getByRole('dialog', { name: 'W01协助点单', exact: true });
    await order.getByLabel('搜索菜单商品').fill(fixture.orderableProductName);
    await order.getByRole('button', { name: '加入' + fixture.orderableProductName, exact: true }).click();
    await order.getByRole('button', { name: '查看已选', exact: true }).click();
    await order.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '核对无误，确认下单', exact: true }).click();
    const financialRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/operations' && response.ok());
    await order.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单', exact: true }).click();
    await financialRefresh;
    await expect(page.locator('.staff-actions-notice')).toContainText('订单已挂桌');
    await page.getByRole('button', { name: '本桌收款', exact: true }).click();
    let cash = page.getByRole('dialog', { name: 'W01本桌收款', exact: true });
    await cash.getByLabel('本次收款金额（元）').fill('1');
    let lose = true;
    const calls = [];
    await page.route('**/api/payments/manual', async (r) => { const response = await r.fetch(); calls.push({ status: response.status(), key: r.request().headers()['idempotency-key'], body: r.request().postDataJSON(), result: await response.json() }); if (lose) {
        lose = false;
        await r.abort('connectionfailed');
    }
    else
        await r.fulfill({ response }); });
    await cash.getByRole('button', { name: /现金已收/ }).click();
    await page.getByRole('button', { name: '确认已收到现金', exact: true }).click();
    await expect(cash.getByRole('alert')).toBeVisible();
    await cash.getByRole('button', { name: '关闭本桌收款' }).click();
    await page.getByRole('button', { name: '本桌收款', exact: true }).click();
    await expect(cash.getByRole('button', { name: '核对上次现金登记' })).toBeVisible();
    await cash.getByRole('button', { name: '关闭本桌收款' }).click();
    async function switchEmployee(code) {
        await page.getByRole('button', { name: '关闭桌台操作', exact: true }).click();
        await page.getByRole('button', { name: /切换账号/ }).click();
        await page.getByLabel('下一位员工账号').fill(code);
        await page.getByLabel('四位 PIN').fill(fixture.employeePin);
        await page.getByRole('button', { name: '验证并切换', exact: true }).click();
        await expect(page.getByTestId('normalized-workspace')).toBeVisible();
    }
    await switchEmployee('lengyanzhi');await table(page);
    await page.getByRole('button', { name: '本桌收款', exact: true }).click();
    await expect(cash.getByRole('region', { name: '上次现金登记待核对' })).toBeVisible();
    await expect(cash.getByRole('button', { name: '核对上次现金登记' })).toHaveCount(0);
    await cash.getByRole('button', { name: '关闭本桌收款' }).click();
    await switchEmployee('liyan');
    await page.goto('/staff/live');
    await page.reload();
    await page.getByRole('button', { name: /^W01 \d+人 · / }).click();
    await page.getByRole('button', { name: '本桌收款', exact: true }).click();
    await cash.getByRole('button', { name: '核对上次现金登记' }).click();
    await expect(cash).toBeHidden();
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[1].status).toBeLessThan(300);
    await page.getByRole('button', { name: '本桌收款', exact: true }).click();
    await cash.getByLabel('本次收款金额（元）').fill('1');
    await cash.getByRole('button', { name: /现金已收/ }).click();
    await page.getByRole('button', { name: '确认已收到现金', exact: true }).click();
    await expect(cash).toBeHidden();
    expect(calls).toHaveLength(3);
    expect(calls[2].key).not.toBe(calls[0].key);
    await context.close();
    return calls;
});
await scenario('OP-03 and OP-07 real observation parse/confirm retain new text and urgent state', async () => {
    const { page, context } = await login();
    await table(page);
    await page.getByRole('button', { name: '记录桌台情况', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'W01记录桌台情况', exact: true }), raw = sheet.getByLabel('一句话记录');
    let release, hit;
    const gate = new Promise(r => release = r), sent = new Promise(r => hit = r);
    const responses = [];
    await page.route('**/observations/parse', async (r) => { const response = await r.fetch(); responses.push({ status: response.status(), body: await response.json() }); hit(); await gate; await r.fulfill({ response }); });
    await raw.fill('客人说这杯太甜');
    await sheet.getByRole('button', { name: '识别并核对', exact: true }).click();
    await sent;
    await raw.fill('客人需要马上加一杯冰水');
    await sheet.getByRole('checkbox').check();
    release();
    await expect(sheet.getByRole('button', { name: '识别并核对', exact: true })).toBeEnabled();
    await expect(sheet.locator('.staff-observation-review')).toHaveCount(0);
    await page.unroute('**/observations/parse');
    expect(responses[0].status).toBeLessThan(300);
    await sheet.getByRole('button', { name: '识别并核对', exact: true }).click();
    await expect(sheet.locator('.staff-observation-review')).toBeVisible();
    await expect(sheet.getByRole('checkbox')).toBeChecked();
    let saveDone, saveHit;
    const saveGate = new Promise(r => saveDone = r), saveSent = new Promise(r => saveHit = r);
    await page.route('**/observations/*/confirm', async (r) => { const response = await r.fetch(); responses.push({ status: response.status(), body: await response.json() }); saveHit(); await saveGate; await r.fulfill({ response }); });
    await sheet.getByRole('button', { name: '确认保存', exact: true }).click();
    await saveSent;
    await raw.fill('保存期间新增的另一条记录');
    saveDone();
    await expect(sheet.getByRole('button', { name: '识别并核对', exact: true })).toBeEnabled();
    await expect(raw).toHaveValue('保存期间新增的另一条记录');
    expect(responses[1].status).toBeLessThan(300);
    await context.close();
    return responses;
});
await scenario('OP-03 recommendation draft executes a real transaction', async () => {
    const { page, context } = await login();
    await page.goto('/staff/customer-experience');
    await section(page, '推荐与升级规则');
    await page.getByRole('button', { name: /推荐规则与顾客开放/ }).click();
    await page.getByRole('button', { name: '新建推荐规则草稿', exact: true }).click();
    await page.locator('.recommendation-policy-draft textarea').nth(1).fill('隔离修复验证推荐规则');
    await page.getByRole('button', { name: '保存草稿，交由另一人审批', exact: true }).click();
    const wait = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/recommendation-policies'));
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    const response = await wait;
    expect(response.status()).toBeLessThan(300);
    const result = await response.json();
    await context.close();
    return result;
});
await scenario('OP-08 recommendations retry in original sheet', async () => {
    const { page, context } = await login();
    await table(page);
    let fail = true;
    await page.route('**/api/staff/customer-experience/recommendations?*', r => fail ? r.abort('failed') : r.continue());
    await page.locator('.staff-table-more > summary').click();
    await page.getByRole('button', { name: '查看/调整推荐', exact: true }).click();
    const retry = page.getByRole('button', { name: '重新读取本桌推荐' });
    await expect(retry).toBeVisible();
    fail = false;
    await retry.click();
    await expect(retry).toBeHidden();
    await context.close();
});
await scenario('OP-11 voucher confirmed receipt preserved when list fails; OP-12 stale lookup discarded', async () => {
    const { page, context } = await login('sanmu');
    await page.goto('/staff/payments');
    const panel = page.getByRole('region', { name: '团购核销', exact: true }), code = panel.getByPlaceholder('输入或扫描顾客出示的券码');
    let release, hit;
    const gate = new Promise(r => release = r), sent = new Promise(r => hit = r);
    await page.route('**/vouchers/prepare', async (r) => { const response = await r.fetch(); hit(); await gate; await r.fulfill({ response }); });
    await code.fill('FIX-OLD-' + Date.now());
    await panel.getByRole('button', { name: '查询券状态' }).click();
    await sent;
    const newCode = 'FIX-NEW-' + Date.now();
    await code.fill(newCode);
    release();
    await expect(panel.getByRole('button', { name: '查询券状态' })).toBeEnabled();
    await expect(panel.locator('.group-voucher-preview')).toHaveCount(0);
    await page.unroute('**/vouchers/prepare');
    await panel.getByRole('button', { name: '查询券状态' }).click();
    await expect(panel.locator('.group-voucher-preview')).toBeVisible();
    let fail = false;
    const calls = [];
    await page.route('**/api/commercial-ops/vouchers', r => fail ? r.abort('failed') : r.continue());
    await page.route('**/vouchers/redeem', async (r) => { const response = await r.fetch(); calls.push({ status: response.status(), body: await response.json(), submitted: r.request().postDataJSON() }); fail = response.ok(); await r.fulfill({ response }); });
    await panel.getByRole('button', { name: '确认核销', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认核销', exact: true }).click();
    await expect(panel.getByRole('button', { name: '重新读取核销记录' })).toBeVisible();
    await expect(panel.getByRole('status')).toContainText('已核销');
    await expect(panel).not.toContainText('本营业日还没有');
    expect(calls[0].submitted.voucherCode).toBe(newCode);
    fail = false;
    await panel.getByRole('button', { name: '重新读取核销记录' }).click();
    await expect(panel.getByRole('button', { name: '重新读取核销记录' })).toBeHidden();
    await context.close();
    return calls;
});
await scenario('OP-10 cross-page switch immediately invalidates old UI and server refuses old session binding', async () => {
    const { page, context } = await login();
    const previousAuth = (await (await page.request.get('/api/auth/session')).json()).data;
    const old = previousAuth.session.id;
    await table(page);
    const second = await context.newPage();
    await second.goto('/');
    await second.getByRole('button', { name: /切换账号/ }).click();
    await second.getByLabel('下一位员工账号').fill('lengyanzhi');
    await second.getByLabel('四位 PIN').fill(fixture.employeePin);
    await second.getByRole('button', { name: '验证并切换', exact: true }).click();
    await expect(second.locator('.normalized-identity h1')).toHaveText('冷言志');
    await expect(page.getByLabel('员工账号')).toBeVisible();
    const stale = await page.request.post('/api/auth/heartbeat', { headers: { 'x-mbox-staff-session-id': old } });
    expect(stale.status()).toBe(401);
    const staleWrite = await page.request.post('/api/table-management/sessions/open', { headers: { 'x-mbox-staff-session-id': old, 'idempotency-key': 'stale-actor-open-' + Date.now() }, data: { guestCount: 2 } });
    expect(staleWrite.status()).toBe(401);
    const oldEmployeeHeaders = { 'x-mbox-staff-employee-id': previousAuth.employee.id, 'idempotency-key': 'stale-after-sales-' + Date.now() };
    const staleAfterSales = await page.request.post('/api/commerce/item-after-sales/requests', { headers: oldEmployeeHeaders, data: { reason: '隔离检查旧员工身份应被拒绝' } });
    expect(staleAfterSales.status()).toBe(401);
    const staleKds = await page.request.post('/api/commerce/kds/11111111-1111-4111-8111-111111111111/remake', { headers: oldEmployeeHeaders, data: { reason: '隔离检查旧员工身份应被拒绝' } });
    expect(staleKds.status()).toBe(401);
    const staleFulfillment = await page.request.get('/api/commerce/fulfillment', { headers: { 'x-mbox-staff-session-id': old } });
    expect(staleFulfillment.status()).toBe(401);
    const current = await page.request.get('/api/auth/session');
    expect((await current.json()).data.employee.code).toBe('lengyanzhi');
    await context.close();
    return { oldSessionRejected: stale.status(), oldWriteRejected: staleWrite.status(), oldAfterSalesRejected: staleAfterSales.status(), oldKdsRejected: staleKds.status(), oldFulfillmentRejected: staleFulfillment.status() };
});
await scenario('OP-13 activity lost receipt survives reload with original attempt, allowing a genuine same-name new draft', async () => {
    const { page, context } = await login('liyan');
    await page.goto('/staff/customer-experience');
    const panel = page.getByRole('region', { name: '活动报名运营工作台' });
    await panel.getByRole('button', { name: '打开工作台' }).click();
    await panel.getByRole('button', { name: '新建活动草稿' }).click();
    const title = '二轮操作审计活动回执' + Date.now();
    await panel.getByLabel('活动名称', { exact: true }).fill(title);
    await panel.getByLabel('列表摘要', { exact: true }).fill('仅隔离测试，不对真实顾客发布');
    await panel.getByLabel('修改原因', { exact: true }).fill('隔离审计核对草稿重试');
    await panel.getByLabel('活动详情', { exact: true }).fill('这是隔离本地环境专用的活动草稿，核对回执后重试逻辑');
    await panel.getByLabel('安全要求（每行一项）', { exact: true }).fill('遵守现场安排，不对真实顾客开放');
    await panel.getByLabel('费用包含（每行一项）', { exact: true }).fill('免费参加测试活动');
    await panel.getByLabel('参与条件（每行一项）', { exact: true }).fill('仅限本地测试人员');
    await panel.getByLabel('联系与集合说明', { exact: true }).fill('门店测试场景集合，不发送消息');
    let lose = true;
    const attempts = [];
    await page.route('**/api/staff/activity-operations', async (route) => { if (route.request().method() !== 'POST')
        return route.continue(); const response = await route.fetch(); attempts.push({ status: response.status(), body: await response.json(), key: route.request().headers()['idempotency-key'] ?? route.request().headers()['x-idempotency-key'] }); if (lose && response.ok()) {
        lose = false;
        await route.abort('connectionfailed');
    }
    else
        await route.fulfill({ response }); });
    await panel.getByRole('button', { name: '建立草稿并读回', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('网络连接失败');
    const afterLost = await panel.getByRole('status').innerText();
    await panel.locator('.activity-operations-detail').screenshot({ path: out + '/r2-activity-lost-reply.png' });
    await page.reload();
    await panel.getByRole('button', { name: '打开工作台' }).click();
    await panel.getByRole('button', { name: '新建活动草稿' }).click();
    await expect(panel.getByLabel('活动名称', { exact: true })).toHaveValue(title);
    await expect(panel.getByLabel('活动名称', { exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '核对上次建立结果', exact: true }).click();
    await expect(panel.locator('.activity-operations-list > button').filter({ hasText: title })).toHaveCount(1);
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1].key).toBe(attempts[0].key);
    const authoritative = await (await page.request.get(base + '/api/staff/activity-operations')).json();
    expect(authoritative.data.filter(x => x.title === title)).toHaveLength(1);
    await panel.getByRole('button', { name: '新建活动草稿' }).click();
    await expect(panel.getByLabel('活动名称', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('活动名称', { exact: true })).toBeEnabled();
    for (const [label,value] of [
        ['活动名称',title],['列表摘要','同名但独立的新活动'],['修改原因','验证真正新操作不被合并'],
        ['活动详情','这是第二份独立草稿，标题可以相同，操作编号不同'],['安全要求（每行一项）','仅隔离测试'],
        ['联系与集合说明','本地测试门店集合'],
    ]) await panel.getByLabel(label,{exact:true}).fill(value);
    await panel.getByRole('button',{name:'建立草稿并读回',exact:true}).click();
    await expect(panel.locator('.activity-operations-list > button').filter({hasText:title})).toHaveCount(2);
    expect(attempts).toHaveLength(3);expect(attempts[2].key).not.toBe(attempts[0].key);
    await context.close();
    return attempts;
});
await scenario('OP-02 known custody success cannot be submitted again; OP-06 detail drafts isolated', async () => {
    const { page, context } = await login('liyan');
    await page.goto('/staff/member-management');
    const custody = page.locator('section.bottle-custody-panel').filter({ has: page.getByRole('heading', { name: '会员存酒', exact: true }) });
    await expect(custody).toBeVisible();
    await custody.getByText('存酒配置与品类', { exact: true }).click();
    await custody.getByLabel('启用新存酒', { exact: true }).check();
    await custody.getByRole('button', { name: '保存存酒规则', exact: true }).click();
    await expect(custody.getByRole('status')).toContainText('存酒配置已保存');
    await custody.getByLabel('品类编号', { exact: true }).fill('FIX_CUSTODY');
    await custody.getByLabel('品类名称', { exact: true }).fill('修复核对样品');
    await custody.getByRole('button', { name: '保存品类', exact: true }).click();
    await expect(custody.getByRole('status')).toContainText('品类已保存');
    await custody.getByText('录入新存酒', { exact: true }).click();
    const entry = custody.locator('details').filter({ has: page.getByText('录入新存酒', { exact: true }) });
    await entry.getByLabel('会员号', { exact: true }).fill('MBX-CARD320');
    await entry.getByLabel('酒名', { exact: true }).fill('修复核对样品');
    await entry.getByRole('combobox', { name: '品类', exact: true }).selectOption({ label: '修复核对样品 · 20天' });
    await entry.getByLabel('存酒联系手机号', { exact: true }).fill('13800012345');
    await entry.getByRole('button', { name: '打开摄像头拍照', exact: true }).click();
    await expect(entry.getByRole('button', { name: '拍摄并使用', exact: true })).toBeEnabled();
    await entry.getByRole('button', { name: '拍摄并使用', exact: true }).click();
    await expect(entry.getByAltText('本次存酒照片预览，保存后添加时间水印')).toBeVisible();
    let failList = false;
    const calls = [];
    await page.route('**/api/staff/bottle-custody?*', route => { if (failList) {
        failList = false;
        return route.abort('connectionfailed');
    } return route.continue(); });
    await page.route('**/api/staff/bottle-custody', async (route) => { if (route.request().method() !== 'POST')
        return route.continue(); const response = await route.fetch(); const data = await response.json(); calls.push({ key: route.request().headers()['idempotency-key'], status: response.status(), order: data.data?.order ?? data.order ?? null }); if (calls.length === 1 && response.status() < 300)
        failList = true; return route.fulfill({ response }); });
    await entry.getByRole('button', { name: '登记存酒', exact: true }).click();
    await expect(custody.getByRole('button', { name: '刷新已保存的记录' })).toBeVisible();
    await expect(custody.getByRole('status')).toContainText('存酒已登记');
    await expect(entry.getByRole('button', { name: '登记存酒', exact: true })).toBeDisabled();
    await expect(entry.getByLabel('酒名', { exact: true })).toHaveValue('');
    await expect(entry.getByAltText('本次存酒照片预览，保存后添加时间水印')).toHaveCount(0);
    await custody.getByRole('button', { name: '刷新已保存的记录' }).click();
    await expect(custody.getByRole('button', { name: '刷新已保存的记录' })).toBeHidden();
    expect(calls).toHaveLength(1);
    // Create a genuinely different custody using fresh evidence for detail-switch control.
    await entry.getByLabel('酒名', { exact: true }).fill('第二张独立存酒');
    await entry.getByLabel('存酒联系手机号', { exact: true }).fill('13800012345');
    await entry.getByRole('button', { name: '打开摄像头拍照', exact: true }).click();
    await expect(entry.getByRole('button', { name: '拍摄并使用', exact: true })).toBeEnabled();
    await entry.getByRole('button', { name: '拍摄并使用', exact: true }).click();
    await entry.getByRole('button', { name: '登记存酒', exact: true }).click();
    await expect(custody.getByRole('status')).toContainText('存酒已登记');
    const rows = custody.locator('.custody-orders > button');
    await expect(rows).toHaveCount(2);
    const detail = custody.locator('.custody-detail');
    await rows.first().click();
    await expect(detail.locator('h4')).toHaveText(await rows.first().locator('small').first().innerText());
    await detail.getByText('调整到期时间', { exact: true }).click();
    await detail.getByLabel('新到期时间（北京时间）', { exact: true }).fill('2026-12-01T20:00');
    await detail.getByLabel('原因', { exact: true }).fill('第一单未保存内容');
    await rows.nth(1).click();
    await expect(detail.locator('h4')).toHaveText(await rows.nth(1).locator('small').first().innerText());
    await detail.getByText('调整到期时间', { exact: true }).click();
    await expect(detail.getByLabel('新到期时间（北京时间）', { exact: true })).toHaveValue('');
    await expect(detail.getByLabel('原因', { exact: true })).toHaveValue('');
    await context.close();
    return calls;
});
await scenario('OP-09 stale transfer rejected after another employee moves same session', async () => {
    const first = await login('liyan');
    const second = await login('lengyanzhi');
    const a = first.page, b = second.page;
    await a.goto('/staff/live');
    await a.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click();
    const free = a.locator('.staff-table-tile:not(.is-open)').first();
    const sourceCode = await free.locator('strong').innerText();
    await free.click();
    await a.getByLabel('实际到店人数').fill('2');
    let rwait = a.waitForResponse(r => r.url().endsWith('/sessions/open'));
    await a.getByRole('button', { name: '确认开台', exact: true }).click();
    const opened = await (await rwait).json();
    await a.locator('.staff-table-more > summary').click();
    await expect(a.getByRole('button', { name: '转桌', exact: true })).toBeVisible();
    await b.goto('/staff/live');
    await b.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click();
    await b.locator('.staff-table-tile').filter({ has: b.locator('strong', { hasText: new RegExp('^' + sourceCode + '$') }) }).click();
    await b.locator('.staff-table-more > summary').click();
    await Promise.all([a.getByRole('button', { name: '转桌', exact: true }).click(), b.getByRole('button', { name: '转桌', exact: true }).click()]);
    const at = a.locator('.staff-transfer-targets > div > button').nth(0), bt = b.locator('.staff-transfer-targets > div > button').nth(1);
    const targetA = await at.evaluate(e => e.childNodes[0].textContent), targetB = await bt.evaluate(e => e.childNodes[0].textContent);
    await Promise.all([at.click(), bt.click()]);
    const seenByB = await b.getByRole('dialog', { name: sourceCode + '桌台操作' }).innerText();
    const began = Date.now();
    rwait = a.waitForResponse(r => r.url().endsWith('/transfer') && r.request().method() === 'POST');
    await a.getByRole('button', { name: '确认转桌', exact: true }).click();
    const ra = await rwait;
    const firstMove = { status: ra.status(), body: await ra.json() };
    currentPage = b;
    const bBefore = await b.getByRole('dialog').innerText();
    rwait = b.waitForResponse(r => r.url().endsWith('/transfer') && r.request().method() === 'POST');
    await b.getByRole('button', { name: '确认转桌', exact: true }).click();
    const rb = await rwait;
    const secondMove = { status: rb.status(), body: await rb.json(), submitted: rb.request().postDataJSON() };
    expect(firstMove.status).toBeLessThan(300);
    expect(secondMove.status).toBe(409);
    await expect(b.locator('.staff-actions-notice')).toContainText('位置');
    await first.context.close();
    await second.context.close();
    return { firstMove, secondMove };
});
await scenario('UX ordinary staff 320px access, grouped navigation and named rule references', async () => {
    const { page, context } = await login('tom', 320);
    const pages = [];
    for (const route of ['/staff/live', '/staff/tasks', '/staff/fulfillment', '/staff/reservations']) {
        await page.goto(route);
        await expect(page.locator('.staff-actions-panel')).toBeVisible();
        const dims = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
        expect(dims.scroll).toBeLessThanOrEqual(dims.viewport + 1);
        pages.push({ route, ...dims });
    }
    await page.goto('/staff/settings');
    await expect(page.getByText('当前账号没有这个页面的有效权限。', { exact: false })).toBeVisible();
    await context.close();
    const manager = await login();
    const response = await manager.page.request.get('/api/staff/loyalty/configuration-center/references');
    expect(response.status()).toBe(200);
    const data = (await response.json()).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every(item => Object.keys(item).sort().join(',') === 'id,kind,name,status')).toBe(true);
    await manager.context.close();
    return pages;
});
await browser.close();
console.log(JSON.stringify(checks.map(({ name, result }) => ({ name, result })), null, 2));
if (checks.some(item => item.result === 'failed'))
    process.exitCode = 1;
