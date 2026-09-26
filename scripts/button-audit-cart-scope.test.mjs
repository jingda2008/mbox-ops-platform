import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

for(const platform of ['miniprogram','alipay-miniprogram']){
  test(`AUDIT ${platform}: clear-cart confirmation follows a changed table scope`,async()=>{
    let page,modal,active={scope:'table-A'},sent=null
    const runtime={showModal:options=>{modal=options},showToast:()=>{}}
    const api={clearSharedCart:async(generation,version)=>{
      sent={scope:active.scope,generation,version};return{lines:[]}
    }}
    vm.runInNewContext(await readFile(new URL(`../${platform}/pages/order/index.js`,import.meta.url),'utf8'),{
      Page:value=>{page=value},wx:runtime,
      require:path=>path.endsWith('/checkout-upgrade')?loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`,import.meta.url)):
        path.endsWith('/checkout-coupons')?loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`,import.meta.url)):
        path.endsWith('/api')?api:path.endsWith('/platform')?runtime:{randomId:()=> 'audit-clear-cart',sharedCartView:()=>[],customerErrorMessage:String},
    })
    page.data=structuredClone(page.data);page.setData=value=>Object.assign(page.data,value)
    Object.assign(page.data,{cart:[{productId:'A-drink'}],cartGeneration:1,cartVersion:2,cartSyncing:false,clearingCart:false,checkoutLocked:false,cartWritesFrozen:false})
    page.currentTableRequest=()=>active;page.isCurrentTableRequest=value=>value===active
    page.ensureTableRequestGuard=()=>({beginWrite:()=>({}),isCurrentWrite:()=>true,finishWrite:()=>true})
    page.updateCart=()=>{}
    const pending=page.clearCart()
    assert.ok(modal)
    active={scope:'table-B'}
    Object.assign(page.data,{cart:[{productId:'B-drink'}],cartGeneration:9,cartVersion:10})
    modal.success({confirm:true})
    await pending
    // Reproduction succeeds only if the old confirmation incorrectly targets B.
    assert.deepEqual(sent,{scope:'table-B',generation:9,version:10})
  })
}
