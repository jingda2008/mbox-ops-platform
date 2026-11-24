import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

const source = readFileSync(new URL('../miniprogram/pages/channel-coupons/index.js', import.meta.url), 'utf8')
const {parseScanValue} = loadMiniModule(new URL('../miniprogram/utils/session.js', import.meta.url))
function couponFlow(options = {}) {
  let page
  let table = {}
  let owner = 'buyer'
  const calls = []
  const token = 'a'.repeat(32)
  const wx = {
    scanCode({success, fail}) {
      calls.push('scan')
      if (options.cancelScan) return fail({errMsg:'scanCode:fail cancel'})
      success({path:options.path ?? ('pages/order/index?scene='+token)})
    },
    showModal({content, success}) {
      calls.push(content)
      if (options.switchTable) table = {...table, cartScope:'next-visit'}
      if (options.switchOwner) owner = 'another-buyer'
      success({confirm:!options.cancelConfirm})
    },
  }
  const app = {refreshRuntime({query,forceTableScan}) {
    assert.equal(forceTableScan,true)
    table = {tableToken:query.token,scanNonce:'scanned'}
  }}
  const api = {async getGuestSession() {
    calls.push('verify')
    table = {...table,cartScope:'original-visit'}
    return {data:{status:options.waiting?'waiting_for_table':'active',table:{code:'A08'}}}
  }}
  vm.runInNewContext(source, {wx, getApp:()=>app, Page(v){page=v}, require(name) {
    if (name.endsWith('/api')) return api
    if (name.endsWith('/recoverable-command')) return {commandIdentityScope:()=>owner}
    if (name.endsWith('/session')) return {parseScanValue,getTableSession:()=>table}
    return {}
  }})
  Object.assign(page,{visible:true,walletOwner:owner,setData(patch){Object.assign(this.data,patch)},
    async write(action,id,valid){assert.ok(valid());calls.push([action,id])}})
  page.data.coupons=[{id:'first',status:'available'},{id:'second',status:'available',title:'我的柠檬水券'}]
  const use=()=>page.useCoupon({currentTarget:{dataset:{id:'second'}}})
  return {page,calls,use}
}

test('桌码经门店确认后，核对桌号，只绑定点选的那一张券',async()=>{
  const flow=couponFlow()
  await flow.use()
  assert.deepEqual(flow.calls,['scan','verify','我的柠檬水券 · A08 桌',['activate','second']])
})
for (const [label,options] of Object.entries({
  '取消扫码':{cancelScan:true},'扫描领券码':{path:'pages/channel-coupons/index?scene=CH_ABCDEFGH'},
  '门店未开台':{waiting:true},'取消用券':{cancelConfirm:true},'核对时已换桌':{switchTable:true},'核对时换会员':{switchOwner:true},
})) test(label+'时不绑定优惠券',async()=>{
  const flow=couponFlow(options)
  await flow.use()
  assert.equal(flow.calls.some(Array.isArray),false)
  assert.equal(flow.page.data.checkingTable,false)
  if (options.cancelConfirm) {
    await flow.use()
    assert.equal(flow.calls.filter(v=>v==='scan').length,2)
  }
})
