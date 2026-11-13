import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
// Interactive component acceptance with isolated API fixtures. No bank/API writes.
const fixture = `
import React from 'react';import{createRoot}from'react-dom/client';
import{ChannelActivationPanel}from'/src/normalized-ui/staff-actions/ChannelActivationPanel.tsx';
import{ChannelFinancePanel}from'/src/normalized-ui/ChannelFinancePanel.tsx';
import{ChannelOperationsPanel}from'/src/normalized-ui/ChannelOperationsPanel.tsx';
const partner={id:'partner',name:'川菜餐厅',promoterId:'promoter',promoterName:'川菜店长'};
const finance={positions:[{visitId:'visit',promoterId:'promoter',basisMinor:'7000',commissionMinor:'700',frozen:true,reasons:['退款待核实'],checkedAt:'2026-11-12'}],statements:[{id:'statement',promoterId:'promoter',amountMinor:'900',paidMinor:'0',status:'confirmed'},{id:'statement-b',promoterId:'promoter',amountMinor:'100',paidMinor:'0',status:'confirmed'}],ledger:[],payouts:[{id:'payout',amountMinor:'400',status:'unknown'}],accounts:[{id:'account',subject:'川菜公司',reference:'资料001',verifiedAt:'2026-11-12'}],balances:[{promoterId:'promoter',accruedMinor:'700',paidMinor:'900',balanceMinor:'-200'}],limit:500};
window.calls=[];window.statementResolvers={};window.financeResolvers=[];const api={getEndpoint:async(path)=>{
 if(window.deferFinance&&path.endsWith('/finance'))return new Promise((resolve,reject)=>window.financeResolvers.push(balance=>balance==='error'?reject(Error('旧刷新失败')):resolve({data:{...finance,balances:[{...finance.balances[0],balanceMinor:balance}]}})));
 if(window.deferStatements&&path.includes('/statement/'))return new Promise(resolve=>{const id=path.split('/').at(-1);window.statementResolvers[id]=()=>resolve({data:{statement:{id},lines:[{visitId:'visit',deltaMinor:'100',evidence:{evidence:[{orderId:id,paid:1000,refunded:0,basis:1000}]}}]}})});
 return{data:path.includes('/statement/')?{statement:{id:'statement'},lines:[{visitId:'visit',deltaMinor:'900',createdAt:'2026-11-12',evidence:{evidence:[{orderId:'order-original',paid:9000,refunded:2000,basis:7000}]}}]}:finance}
},postEndpoint:async(path,body,options)=>{window.calls.push({path,body,options});if(window.failNextWrite){window.failNextWrite=false;throw Error('网络中断，结果未知')};return{data:{id:'record'}}}};
const auth={session:{id:'isolated-channel-ui'},permissions:['channel.view','channel.manage','channel.correct','channel.settle']};
const data={partners:[partner],campaigns:[{id:'campaign',title:'餐后小聚'}],batches:[{id:'batch',offerCode:'ABCD1234'}],products:[{id:'gift',name:'薯条'}],claims:[{id:'claim',title:'餐后小聚券',status:'active'}],employees:[{id:'staff',name:'跟进员工'}],continuity:[],limits:null};
window.activationCalls=[];let bound=false;
window.giftCalls=[];window.tableResolvers=[];
function giftRows(used){return {customers:[{id:'customer-a',label:'顾客甲'}],activations:['one','two'].map(id=>({id,claimId:id,title:'赠品'+id,sourceLabel:'川菜店',status:used==='2000'?'fulfilled':'active',arrivalConfirmed:true,offer:{kind:'gift',productId:id,quantity:1},giftOrderId:used==='2000'?'order-'+id:null,allowStacking:true,visitDiscountCapMinor:2500,usedDiscountMinor:used}))}}

window.fetch=async(path,options={})=>{
 if(window.deferScopeRead&&path.endsWith('/channel/table/write-new'))return new Promise(resolve=>{window.finishScopeRead=()=>resolve({ok:true,json:async()=>({data:{customers:[],activations:[{id:'new-scope',claimId:'new-scope',title:'新桌状态',sourceLabel:'川菜店',status:'active',arrivalConfirmed:true,offer:{kind:'credit',amountMinor:100},allowStacking:true,usedDiscountMinor:'1234',visitDiscountCapMinor:2000}]}})})});

 if(path.endsWith('/channel/fulfill-gift')){const body=JSON.parse(options.body);window.giftCalls.push({body,key:options.headers.get('idempotency-key'),recovery:options.headers.get('x-channel-recovery')});if(window.loseGiftResponse){window.loseGiftResponse=false;throw Error('赠品写入后响应丢失')};return {ok:true,json:async()=>({data:{orderId:'order-'+body.claimId}})}};
 if(window.giftMode&&path.includes('/channel/table/')){if(window.deferTable)return new Promise((resolve,reject)=>window.tableResolvers.push(value=>value==='error'?reject(Error('旧状态读取断网')):resolve({ok:true,json:async()=>({data:giftRows(value)})})));return {ok:true,json:async()=>({data:giftRows(window.giftUsed??'0')})}};

 if(path.includes('/channel/table/'))return{ok:true,json:async()=>({data:{customers:[{id:'customer-a',label:'顾客甲'},{id:'customer-b',label:'顾客乙'}],activations:bound&&path.endsWith('/table')?[{id:'active',claimId:'claim',title:'测试券',sourceLabel:'川菜店',status:'active',arrivalConfirmed:true,offer:{kind:'credit',amountMinor:100}}]:[]}})};
 if(path.endsWith('/channel/preview')&&window.deferPreview)return new Promise(resolve=>{window.finishPreview=()=>resolve({ok:true,json:async()=>({data:{rule:{title:'过时预览',perCustomerClaims:1,perVisitUses:1,minimumMinor:0,useUntil:'2026-11-13T12:00:00Z',offer:{kind:'credit',amountMinor:100}},claims:[],hasMoreClaims:false}})})});
 if(path.endsWith('/channel/preview'))return{ok:true,json:async()=>({data:{rule:{title:'测试券',perCustomerClaims:1,perVisitUses:1,minimumMinor:0,useUntil:'2026-11-13T12:00:00Z',offer:{kind:'credit',amountMinor:100}},claims:[],hasMoreClaims:false}})};
 if(path.endsWith('/channel/activate')){window.activationCalls.push({body:JSON.parse(options.body),key:options.headers.get('idempotency-key')});if(window.deferActivation)return new Promise(resolve=>{window.finishActivation=()=>resolve({ok:true,json:async()=>({data:{claimId:'old-claim',activationId:'old-active',visitId:'old-visit'}})})});if(window.activationCalls.length===1)return{ok:false,status:403,json:async()=>({error:{code:'OWNERSHIP',message:'顾客已离开原桌',commitDisposition:'not_committed'}})};bound=true;return{ok:true,json:async()=>({data:{claimId:'claim',activationId:'active',visitId:'visit'}})}};
 throw Error('Unexpected fixture fetch '+path)
};
function ActivationFixture(){const[session,setSession]=React.useState('table');window.changeActivationSession=setSession;return <ChannelActivationPanel sessionId={session} staffSessionId="staff-fixture"/>}
createRoot(document.getElementById('root')).render(<><h1>本地渠道操作测试 · 数据为隔离样例</h1><ChannelFinancePanel api={api} auth={auth} partners={[partner]}/><ChannelOperationsPanel api={api} auth={auth} data={data} onRefresh={async()=>{}}/><ActivationFixture/></>);
`;
const server = await createServer({configFile:false,root:resolve(import.meta.dirname,'..'),server:{host:'127.0.0.1',port:0},plugins:[react(),{name:'isolated-channel-fixture',resolveId(id){if(id==='/__channel-fixture.tsx')return id},load(id){if(id==='/__channel-fixture.tsx')return fixture},configureServer(s){s.middlewares.use('/__channel-fixture',async(req,res,next)=>{if(req.originalUrl!=='/__channel-fixture')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__channel-fixture','<html><body><div id="root"></div><script type="module" src="/__channel-fixture.tsx"></script></body></html>'))})}}]});
let browser;
try {
 await server.listen();const port=server.httpServer.address().port;browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/__channel-fixture`);await page.getByText('渠道财务 · 退款计佣、对账及付款登记',{exact:true}).click();
 await page.getByText('未付余额',{exact:false}).waitFor();assert.match(await page.locator('body').innerText(),/¥-2.00/);
 await page.getByRole('button',{name:'核对原消费和退款明细'}).first().click();await page.getByText('原订单 order-original',{exact:false}).waitFor();assert.match(await page.locator('body').innerText(),/退款 ¥20.00/);
 const financeForm=page.locator('form').first();await financeForm.getByLabel('办理事项').selectOption('start-payment');await financeForm.getByLabel('金额（元）').fill('4.00');await financeForm.getByLabel('银行流水或查账凭据编号（全店唯一）').fill('bank-fixture-0001');await financeForm.getByLabel('办理依据').fill('隔离样例核验');await financeForm.getByRole('button',{name:'确认办理并留痕'}).click();await page.getByText('已保存并核对最新记录；付款登记不会发起银行转账。').waitFor();
 let calls=await page.evaluate(()=>window.calls);assert.equal(calls.length,1);assert.equal(calls[0].body.amountMinor,400);assert.equal(calls[0].body.action,'start-payment');assert.match(calls[0].options.idempotencyKey,/^channel-/);
 await financeForm.getByLabel('办理事项').selectOption('confirm-payment');await financeForm.getByLabel('核实结果').selectOption('false');await financeForm.getByLabel('银行流水或查账凭据编号（全店唯一）').fill('bank-failed-0001');await financeForm.getByRole('button',{name:'确认办理并留痕'}).click();await page.waitForFunction(()=>window.calls.length===2);calls=await page.evaluate(()=>window.calls);assert.equal(calls[1].body.success,false);
 const summaries=await page.locator('summary').all();await summaries[1].click();const opsForm=page.locator('form').nth(1);await opsForm.getByRole('combobox').first().selectOption('replace-gift');await opsForm.locator('input[name="quantity"]').fill('1');await opsForm.locator('input[name="consent"]').fill('顾客同意换薯条');await opsForm.locator('input[name="reason"]').fill('原赠品缺货');await opsForm.getByRole('button').click();await page.waitForFunction(()=>window.calls.length===3);calls=await page.evaluate(()=>window.calls);assert.equal(calls[2].body.action,'replace-gift');assert.equal(calls[2].body.consent,'顾客同意换薯条');assert.equal(calls[2].body.productId,'gift');assert.equal(calls[2].body.quantity,1);
 await financeForm.getByLabel('办理事项').selectOption('reissue-account');await financeForm.getByLabel('已核实账户').selectOption('account');await financeForm.getByRole('button',{name:'确认办理并留痕'}).click();await page.waitForFunction(()=>window.calls.length===4);calls=await page.evaluate(()=>window.calls);assert.equal(calls[3].body.action,'reissue-account');assert.equal(calls[3].body.accountId,'account');assert.equal(calls[3].body.id,'statement');
 await page.getByText('渠道优惠 · 核验绑定本桌',{exact:true}).click();
 const activation=page.locator('details').filter({has:page.getByText('渠道优惠 · 核验绑定本桌',{exact:true})});
 await activation.getByLabel('推广图上的优惠号码',{exact:true}).fill('ABCDEFGH2345');
 await activation.locator('select').first().selectOption('customer-a');
 await activation.getByRole('button',{name:'查看优惠与顾客已有券'}).click();await activation.getByRole('button',{name:'确认顾客与本桌并绑定'}).click();
 await activation.getByRole('alert').filter({hasText:'顾客已离开原桌'}).waitFor();
 assert.equal(await activation.getByRole('button',{name:'恢复上次绑定并核对'}).count(),0);
 assert.equal(await activation.locator('select').first().isEnabled(),true);
 await activation.locator('select').first().selectOption('customer-b');
 await activation.getByRole('button',{name:'查看优惠与顾客已有券'}).click();await activation.getByRole('button',{name:'确认顾客与本桌并绑定'}).click();
 await activation.getByRole('status').filter({hasText:'本次消费已绑定'}).waitFor();
 const attempts=await page.evaluate(()=>window.activationCalls);assert.equal(attempts.length,2);assert.notEqual(attempts[0].key,attempts[1].key);assert.equal(attempts[1].body.customerId,'customer-b');
 await page.evaluate(()=>{window.deferPreview=true;window.changeActivationSession('preview-old')});
 await page.waitForFunction(()=>document.querySelector('input[maxlength="100"]').value==='');
 await activation.getByLabel('推广图上的优惠号码',{exact:true}).fill('ABCDEFGH2345');await activation.locator('select').first().selectOption('customer-a');
 await activation.getByRole('button',{name:'查看优惠与顾客已有券'}).click();await page.waitForFunction(()=>typeof window.finishPreview==='function');
 await page.evaluate(()=>window.changeActivationSession('preview-new'));
 await page.waitForFunction(()=>document.querySelector('input[maxlength="100"]').value==='');
 await page.evaluate(()=>{window.deferPreview=false;window.finishPreview()});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.waitForFunction(()=>!document.body.innerText.includes('过时预览'));
 assert.equal(await activation.getByRole('button',{name:'确认顾客与本桌并绑定'}).count(),0);
 await activation.getByLabel('推广图上的优惠号码',{exact:true}).fill('ABCDEFGH2345');await activation.locator('select').first().selectOption('customer-a');
 await activation.getByRole('button',{name:'查看优惠与顾客已有券'}).click();
 await page.evaluate(()=>{window.deferActivation=true});await activation.getByRole('button',{name:'确认顾客与本桌并绑定'}).click();await page.waitForFunction(()=>typeof window.finishActivation==='function');
 await page.evaluate(()=>{window.deferScopeRead=true;window.changeActivationSession('write-new')});
 await page.waitForFunction(()=>document.querySelector('input[maxlength="100"]').value==='');
 await page.evaluate(()=>window.finishActivation());
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.waitForFunction(()=>typeof window.finishScopeRead==='function');await page.evaluate(()=>{window.deferScopeRead=false;window.finishScopeRead()});
 await activation.getByText('已占用优惠 ¥12.34',{exact:false}).waitFor();
 await page.waitForFunction(()=>!document.body.innerText.includes('本次消费已绑定。券号'));
 assert.equal(await activation.getByRole('status').count(),0);assert.equal(await activation.getByRole('button',{name:'恢复上次绑定并核对'}).count(),0);
 const last=await page.evaluate(()=>window.activationCalls.at(-1));assert.equal(last.body.tableSessionId,'preview-new');
 await financeForm.getByLabel('办理事项').selectOption('reconcile');await page.evaluate(()=>{window.failNextWrite=true});
 await financeForm.getByRole('button',{name:'确认办理并留痕'}).click();await page.getByRole('button',{name:'恢复原财务操作'}).waitFor();
 const initial=await page.evaluate(()=>window.calls.at(-1));assert.equal(initial.options.channelRecovery,false);
 await page.getByRole('button',{name:'恢复原财务操作'}).click();await page.waitForFunction(()=>window.calls.at(-1).options.channelRecovery===true);
 const recovered=await page.evaluate(()=>window.calls.at(-1));assert.equal(recovered.options.idempotencyKey,initial.options.idempotencyKey);
 await page.waitForFunction(()=>!document.body.innerText.includes('恢复原财务操作'));
 await page.evaluate(()=>{window.deferFinance=true});
 await page.getByRole('button',{name:'刷新核算记录'}).click();await page.getByRole('button',{name:'刷新核算记录'}).click();await page.waitForFunction(()=>window.financeResolvers.length===2);
 await page.evaluate(()=>window.financeResolvers[1]('777'));await page.getByText('未付余额 ¥7.77',{exact:false}).waitFor();
 await page.evaluate(()=>{window.deferFinance=false;window.financeResolvers[0]('111')});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByText('未付余额 ¥7.77',{exact:false}).count(),1);
 await page.evaluate(()=>{window.financeResolvers=[];window.deferFinance=true});
 await page.getByRole('button',{name:'刷新核算记录'}).click();await page.getByRole('button',{name:'刷新核算记录'}).click();await page.waitForFunction(()=>window.financeResolvers.length===2);
 await page.evaluate(()=>window.financeResolvers[1]('777'));await page.getByText('未付余额 ¥7.77',{exact:false}).waitFor();
 await page.evaluate(()=>{window.deferFinance=false;window.financeResolvers[0]('error')});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByText('旧刷新失败',{exact:true}).count(),0);
 await page.evaluate(()=>{window.deferStatements=true});const details=page.getByRole('button',{name:'核对原消费和退款明细'});
 await details.nth(0).click();await details.nth(1).click();await page.waitForFunction(()=>Object.keys(window.statementResolvers).length===2);
 await page.evaluate(()=>window.statementResolvers['statement-b']());await page.getByText('原订单 statement-b',{exact:false}).waitFor();
 await page.evaluate(()=>window.statementResolvers.statement());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByText('原订单 statement-b',{exact:false}).count(),1);

 for(const olderResponse of ['1000','error']){
  await page.evaluate(mode=>{window.giftMode=true;window.giftUsed='0';window.giftCalls=[];window.tableResolvers=[];window.changeActivationSession('gift-'+mode)},olderResponse);
  await activation.getByText('本次客组：允许叠加 · 已占用优惠 ¥0.00 · 总上限 ¥25.00',{exact:false}).waitFor();
  await page.evaluate(()=>{window.deferTable=true});
  await activation.getByRole('button',{name:'核对门槛并下赠品单',exact:true}).nth(0).click();await page.waitForFunction(()=>window.tableResolvers.length===1);
  await activation.getByRole('button',{name:'核对门槛并下赠品单',exact:true}).nth(1).click();await page.waitForFunction(()=>window.tableResolvers.length===2);
  await page.evaluate(()=>window.tableResolvers[1]('2000'));
  await activation.getByText('本次客组：允许叠加 · 已占用优惠 ¥20.00 · 总上限 ¥25.00',{exact:false}).waitFor();
  await page.evaluate(value=>window.tableResolvers[0](value),olderResponse);
  await activation.getByRole('button',{name:'恢复原操作',exact:true}).waitFor();
  assert.equal(await activation.getByText('已占用优惠 ¥20.00',{exact:false}).count(),1);
  await page.evaluate(()=>{window.deferTable=false;window.giftUsed='2000'});
  await activation.getByRole('button',{name:'恢复原操作',exact:true}).click();
  await page.waitForFunction(()=>!document.body.innerText.includes('恢复原操作'));
  const giftCalls=await page.evaluate(()=>window.giftCalls);
  assert.equal(giftCalls.length,2); // Known result: recover performs only the missing readback, no repeated write.
 }

 await page.evaluate(()=>{window.giftUsed='0';window.changeActivationSession('gift-offline');window.loseGiftResponse=true;window.giftCalls=[]});
 await activation.getByText('已占用优惠 ¥0.00',{exact:false}).waitFor();
 await activation.getByRole('button',{name:'核对门槛并下赠品单',exact:true}).nth(0).click();
 await activation.getByRole('button',{name:'恢复原操作',exact:true}).waitFor();
 const lostGift=await page.evaluate(()=>window.giftCalls[0]);
 await page.reload();await page.getByText('渠道优惠 · 核验绑定本桌',{exact:true}).click();
 await page.evaluate(()=>{window.giftMode=true;window.giftUsed='2000';window.changeActivationSession('gift-offline')});
 await activation.getByRole('button',{name:'恢复原操作',exact:true}).click();
 await page.waitForFunction(()=>window.giftCalls.length===1&&!document.body.innerText.includes('恢复原操作'));
 const recoveredGift=await page.evaluate(()=>window.giftCalls[0]);
 assert.equal(recoveredGift.key,lostGift.key);assert.equal(recoveredGift.recovery,'1');assert.deepEqual(recoveredGift.body,lostGift.body);
 assert.deepEqual(errors,[]);const folder=process.env.CHANNEL_UI_EVIDENCE_DIR??'/tmp/channel-ui-evidence';await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,'channel-finance-operations.png'),fullPage:true});console.log(JSON.stringify({passed:27,checks:['late old-table binding cannot invalidate new-table pending read','lost gift response survives browser reload','unknown gift recovery uses original key and receipt-only mode','overlapping gift refresh keeps newest group cap','stale read failure cannot revert cap','superseded gift read retains pending receipt','known gift receipt recovery performs no second write','negative balance','original sale and refund detail','partial payout minor units','durable idempotency key','explicit failed payment','gift replacement consent and quantity','new-account tail statement references original','no browser errors','first uncommitted staff error unlocks input','corrected customer binds successfully','new deliberate key only after confirmed rollback','table switch clears inputs','old preview cannot bind new table','late binding result cannot update new table','in-flight write retains original table payload','finance recovery preserves original key','finance recovery requests receipt-only mode','last selected finance statement wins out-of-order responses','last finance refresh wins out-of-order balances','stale refresh failure cannot override current state'],boundary:'Isolated UI API fixtures; not native device, real transfer, or production acceptance'}));
}finally{await browser?.close();await server.close()}
