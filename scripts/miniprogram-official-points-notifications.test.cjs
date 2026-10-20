const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
function page(api){let result;vm.runInNewContext(fs.readFileSync('miniprogram/pages/profile-notifications/index.js','utf8'),{Page:p=>{result=p;p.setData=data=>Object.assign(p.data,data)},require:name=>name.includes('/api')?api:{customerErrorMessage:e=>e.message}});return result}
const baseline=()=>({getWechatNotificationAuthorizations:async()=>({authorizations:[]}),getWechatMemberServiceNotificationAuthorizations:async()=>({authorizations:[]})})
test('notification switch binding compiles as an expression and allows opt-out even when provider readiness is lost',()=>{
 const template=fs.readFileSync('miniprogram/pages/profile-notifications/index.wxml','utf8')
 const expression=template.match(/<switch\b[^>]*\bdisabled="\{\{([\s\S]*?)\}\}"/)?.[1]
 assert.ok(expression,'notification switch disabled binding must exist')
 const binding=new vm.Script(`(${expression})`)
 for(const saving of [false,true]) for(const enabled of [false,true]) for(const available of [false,true]) for(const linked of [false,true]){
  const actual=binding.runInNewContext({saving,official:{enabled,available,linked}})
  const canChange=!saving && (enabled || (available && linked))
  assert.equal(actual,!canChange,JSON.stringify({saving,enabled,available,linked}))
 }
})
test('native notification settings load real preference and submit explicit on/off without implicit authorization',async()=>{
 let enabled=false,calls=[];const p=page({...baseline(),getOfficialPointsNotifications:async()=>({available:true,linked:true,enabled,accountId:'official-test'}),setOfficialPointsNotifications:async input=>{calls.push(input);enabled=input.enabled}})
 await p.load();assert.equal(calls.length,0);assert.equal(p.data.official.enabled,false)
 await p.changeOfficial({detail:{value:true}});assert.equal(p.data.official.enabled,true)
 await p.changeOfficial({detail:{value:false}});assert.equal(p.data.official.enabled,false);assert.equal(calls.length,2);assert.equal(calls[0].accountId,'official-test')
})
test('a failed save reads authoritative state and retains a visible error',async()=>{
 const p=page({...baseline(),getOfficialPointsNotifications:async()=>({available:true,linked:true,enabled:false,accountId:'test'}),setOfficialPointsNotifications:async()=>{throw new Error('保存结果未知')}})
 await p.load();await p.changeOfficial({detail:{value:true}});assert.equal(p.data.official.enabled,false);assert.equal(p.data.error,'保存结果未知');assert.equal(p.data.saving,false)
})
test('late load cannot restore stale preferences after page hide',async()=>{
 let resolve;const p=page({...baseline(),getOfficialPointsNotifications:()=>new Promise(r=>{resolve=r})});const pending=p.load();p.onHide();resolve({enabled:true,accountId:'old-account'});await pending;assert.equal(p.data.official,null)
})
