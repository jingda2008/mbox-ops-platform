import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
const notice={id:'notice',code:'MBOX',version:1,rule:{operatorName:'测试主体',channels:['wechat','sms','phone'],purposes:['own_activities','mbox_joint_activities'],weekdays:[1,2,3],contactStartMinute:600,contactEndMinute:1200}}
const data=()=>({revision:'none',notices:[notice],channels:[{channel:'wechat',ready:false},{channel:'sms',ready:false},{channel:'phone',ready:false}],decisions:[]})
async function harness(platform,read=async()=>data(),write=async()=>({})){
  let page
  vm.runInNewContext(await readFile(new URL('../'+platform+'/pages/profile-marketing/index.js',import.meta.url),'utf8'),{Page(value){page=value;page.setData=value=>Object.assign(page.data,value)},require(name){return name.endsWith('/api')?{getMarketingPreferences:read,updateMarketingPreferences:write}:{customerErrorMessage:(_,fallback)=>fallback}}})
  return page
}
for(const platform of ['miniprogram','alipay-miniprogram']){
  test(platform+': contact support stays independent and page routes are unique',async()=>{
    const app=JSON.parse(await readFile(new URL('../'+platform+'/app.json',import.meta.url),'utf8'))
    assert.equal(new Set(app.pages).size,app.pages.length)
    assert.ok(app.pages.includes('pages/profile-contact/index'));assert.ok(app.pages.includes('pages/profile-marketing/index'))
    const support=await readFile(new URL('../'+platform+'/pages/profile-contact/index.js',import.meta.url),'utf8')
    assert.match(support,/callStore\(\)/);assert.match(support,/openCustomerService\(\)/);assert.doesNotMatch(support,/updateMarketingPreferences/)
    const profile=await readFile(new URL('../'+platform+'/pages/profile/index.js',import.meta.url),'utf8')
    assert.match(profile,/openMarketingPreferences\(\)\s*\{\s*(?:wx|runtime)\.navigateTo/)
  })
  test(platform+': default unselected and explicit scoped choices without platform authorization calls',async()=>{
    const calls=[],page=await harness(platform,undefined,async(...args)=>{calls.push(args)})
    await page.load();page.openNotice({currentTarget:{dataset:{id:'notice'}}})
    await page.submit();assert.equal(calls.length,0);assert.equal(page.data.acknowledged,false)
    page.chooseChannels({detail:{value:['sms']}});await page.submit();assert.equal(calls.length,0)
    page.acknowledge({detail:{value:['agree']}});await page.submit()
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['choices',{noticeId:'notice',expectedRevision:'none',choices:[{channel:'sms',purpose:'own_activities',decision:'granted'}]}]])
    assert.equal(page.data.channels[1].capabilityText,'渠道尚未开通，不代表已能发送')
  })
  test(platform+': joint activities need a separate choice and reopening resets native checkbox state',async()=>{
    let body;const page=await harness(platform,undefined,async(_action,input)=>{body=input})
    await page.load();page.openNotice({currentTarget:{dataset:{id:'notice'}}});page.chooseChannels({detail:{value:['wechat','forged']}});page.chooseJoint({detail:{value:['joint']}});page.acknowledge({detail:{value:['agree']}})
    assert.equal(page.data.selectedNotice.channelOptions[0].checked,true)
    await page.submit();assert.equal(body.choices.length,2);assert.ok(body.choices.every(c=>c.channel==='wechat'))
    page.openNotice({currentTarget:{dataset:{id:'notice'}}});assert.equal(page.data.canSubmit,false);assert.ok(page.data.selectedNotice.channelOptions.every(c=>!c.checked))
  })
  test(platform+': stop-all works after failed preference read and sends no notice or contact identity',async()=>{
    const calls=[],page=await harness(platform,async()=>{throw new Error('read failed')},async(...args)=>{calls.push(args)})
    await page.load();assert.equal(page.data.loaded,false);await page.stopAll()
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['stop-all',{}]])
    assert.match(page.data.message,/已停止全部/);assert.ok(page.data.error)
  })
  test(platform+': late initial read cannot overwrite an in-flight stop-all or re-enable actions',async()=>{
    let readResolve,writeResolve
    const page=await harness(platform,()=>new Promise(resolve=>{readResolve=resolve}),()=>new Promise(resolve=>{writeResolve=resolve}))
    const first=page.load(),stop=page.stopAll();readResolve(data());await first;assert.equal(page.data.busy,true)
    page.onHide();writeResolve({});await stop;assert.equal(page.data.message,'')
  })
  test(platform+': unknown write is retryable and double taps cannot submit a second command',async()=>{
    let reject,calls=0;const page=await harness(platform,undefined,()=>{calls++;return new Promise((_resolve,fail)=>{reject=fail})})
    await page.load();const first=page.stopAll();await page.stopAll();assert.equal(calls,1)
    reject(new Error('unknown'));await first;assert.equal(page.data.busy,false);assert.equal(page.data.message,'');assert.ok(page.data.error)
  })
}
