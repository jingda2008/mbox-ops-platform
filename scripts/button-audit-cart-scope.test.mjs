import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

for(const platform of ['miniprogram','alipay-miniprogram']){
  async function fixture(){
    let page,modal,scope='table-A';const calls=[]
    const runtime={showModal:options=>{modal=options},showToast:()=>{}}
    const api={clearSharedCart:async(generation,version,key)=>{calls.push({scope,generation,version,key});return{lines:[]}}}
    vm.runInNewContext(await readFile(new URL(`../${platform}/pages/order/index.js`,import.meta.url),'utf8'),{
      Page:value=>{page=value},wx:runtime,
      require:path=>path.endsWith('/checkout-upgrade')?loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`,import.meta.url)):
        path.endsWith('/checkout-coupons')?loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`,import.meta.url)):
        path.endsWith('/api')?api:path.endsWith('/platform')?runtime:{randomId:()=> 'audit-clear-cart',sharedCartView:()=>[],customerErrorMessage:String},
    })
    const {createTableRequestGuard}=loadMiniModule(new URL(`../${platform}/utils/table-request-scope.js`,import.meta.url))
    const guard=createTableRequestGuard(()=>scope);guard.begin(scope)
    page.data=structuredClone(page.data);page.setData=value=>Object.assign(page.data,value)
    Object.assign(page.data,{cart:[{productId:'A-drink'}],cartGeneration:1,cartVersion:2,cartSyncing:false,clearingCart:false,busy:false,checkoutLocked:false,cartWritesFrozen:false})
    page.currentTableRequest=()=>guard.current();page.isCurrentTableRequest=value=>guard.isCurrent(value)
    page.ensureTableRequestGuard=()=>guard;page.updateCart=()=>{}
    return {page,calls,guard,respond:confirm=>modal.success({confirm}),switchTable:()=>{scope='table-B';guard.begin(scope)},rebase:()=>{scope='table-B';guard.rebase(guard.current(),scope)}}
  }
  test(`${platform}: clear-cart cancels an old confirmation after switching tables`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.switchTable()
    Object.assign(f.page.data,{cart:[{productId:'B-drink'}],cartGeneration:9,cartVersion:10})
    f.respond(true);await pending;assert.equal(f.calls.length,0)
  })
  test(`${platform}: in-place scope rebase cannot move a pending clear confirmation`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.rebase();f.respond(true);await pending;assert.equal(f.calls.length,0)
  })
  for(const field of ['cartGeneration','cartVersion'])test(`${platform}: ${field} change requires fresh clear confirmation`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.page.data[field]++;f.respond(true);await pending
    assert.equal(f.calls.length,0);assert.match(f.page.data.error,/未执行清空/)
  })
  for(const field of ['cartSyncing','clearingCart','busy','checkoutLocked','cartWritesFrozen'])test(`${platform}: ${field} starting during the modal prevents clear`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.page.data[field]=true;f.respond(true);await pending;assert.equal(f.calls.length,0)
  })
  test(`${platform}: normal clear sends the originally confirmed version and unlocks`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.respond(true);await pending
    assert.deepEqual(f.calls,[{scope:'table-A',generation:1,version:2,key:'audit-clear-cart'}]);assert.equal(f.page.data.clearingCart,false);assert.equal(f.page.data.cartSyncing,false)
  })
  test(`${platform}: cancelling or leaving the page sends no clear request`,async()=>{
    const f=await fixture(),pending=f.page.clearCart();f.respond(false);await pending;assert.equal(f.calls.length,0)
    const second=f.page.clearCart();f.guard.invalidate();f.respond(true);await second;assert.equal(f.calls.length,0)
  })
}
