import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

for(const platform of ['miniprogram','alipay-miniprogram']){
  async function fixture(){
    let page;const calls=[]
    const api={replaceSharedCartBundleSelection:async(...args)=>{calls.push(args);return{lines:[]}}}
    vm.runInNewContext(await readFile(new URL(`../${platform}/pages/order/index.js`,import.meta.url),'utf8'),{
      Page:value=>{page=value},require:path=>path.endsWith('/checkout-upgrade')?loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`,import.meta.url)):path.endsWith('/checkout-coupons')?loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`,import.meta.url)):path.endsWith('/api')?api:{
        randomId:()=> 'test-portion-operation',money:String,customerErrorMessage:()=> '请刷新购物车',
      },
    })
    page.data=structuredClone(page.data)
    page.setData=value=>Object.assign(page.data,value)
    const scope={};page.currentTableRequest=()=>({scope});page.isCurrentTableRequest=()=>true
    page.ensureTableRequestGuard=()=>({beginWrite:()=>({}),isCurrentWrite:()=>true,finishWrite:()=>true})
    page.updateCart=()=>{};page.refreshSharedCart=async()=>{}
    page.data.products=[{productId:'bundle',productKind:'bundle',bundleChoiceGroups:[{
      id:'group',selectionCount:1,options:[{productId:'drink',name:'鸡尾酒',available:true}],
    }]}]
    page.data.cart=[{productId:'bundle',portionIds:['first','second'],bundleSelections:[
      {groups:[{groupId:'group',productIds:['drink']}]},
      {groups:[{groupId:'group',productIds:['drink']}]},
    ]}]
    Object.assign(page.data,{cartGeneration:3,cartVersion:7,cartSyncing:false,checkoutLocked:false,cartWritesFrozen:false})
    return{page,calls,api}
  }
  test(`${platform}: editing binds the original portion and cart version across remote refresh`,async()=>{
    const {page,calls}=await fixture()
    page.editBundleUnitSelection({currentTarget:{dataset:{id:'bundle',index:1}}})
    assert.equal(page.data.detailEditPortionId,'second')
    page.data.cartVersion=9;page.data.cartGeneration=4
    page.data.cart[0].portionIds=['first','replacement']
    assert.equal(await page.replaceBundleUnitSelection('bundle',1,{groups:[]}),true)
    assert.deepEqual(calls[0].slice(3),[3,7,'test-portion-operation','second'])
  })
  test(`${platform}: version conflict refreshes without pretending selection was saved`,async()=>{
    const {page,api}=await fixture();let refreshed=0
    page.editBundleUnitSelection({currentTarget:{dataset:{id:'bundle',index:0}}})
    api.replaceSharedCartBundleSelection=async()=>{throw new Error('conflict')}
    // The page destructures its API, so emulate rejection through a fresh VM.
    let def
    vm.runInNewContext(await readFile(new URL(`../${platform}/pages/order/index.js`,import.meta.url),'utf8'),{
      Page:value=>{def=value},require:path=>path.endsWith('/checkout-upgrade')?loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`,import.meta.url)):path.endsWith('/checkout-coupons')?loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`,import.meta.url)):path.endsWith('/api')?api:{randomId:()=> 'test-operation',customerErrorMessage:()=> '请刷新购物车'},
    })
    page.refreshSharedCart=async()=>{refreshed++}
    assert.equal(await def.replaceBundleUnitSelection.call(page,'bundle',0,{groups:[]}),false)
    assert.equal(refreshed,1);assert.equal(page.data.cartSyncing,false)
    assert.equal(page.data.detailEditPortionId,'first')
  })
}
