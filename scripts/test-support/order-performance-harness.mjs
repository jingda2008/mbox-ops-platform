import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export function deferred() { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b});return {promise,resolve,reject} }
export function createOrderPage({ platform='miniprogram', baseline=false, delays={}, overrides={}, menuCount=180, alipayPaymentEnabled=true }={}) {
  const root=resolve(platform), baselineRoot=resolve('artifacts/order-performance-20260914/baseline',platform)
  const state={ session:{tableCode:'A01',tableToken:'test-qr-a',scanNonce:'scan-a',cartScope:'test-cart-scope-a'}, storage:new Map(), cart:{generation:1,version:0,totalAmountMinor:0,lines:[]}, calls:[], timings:{}, timers:new Set() }
  const menu=Array.from({length:menuCount},(_,i)=>({productId:`p-${i}`,name:i===menuCount-1?'最后一款可搜索商品':`商品${i}`,productKind:'single',amountMinor:800,currency:'CNY',available:true,categoryCode:i%2?'beer':'snack',categoryName:i%2?'啤酒':'小食',imageUrl:`/menu/test-${i}.jpg`}))
  const response=(name,value)=>{state.calls.push(name);return sleep(delays[name] ?? delays.optional ?? 0).then(()=>typeof value==='function'?value():value)}
  const api={
    getGuestSession:()=>response('identity',()=>({data:{status:'active',cartProtocolVersion:2,table:{code:state.session.tableCode,displayName:state.session.tableCode}}})),
    getMenu:()=>response('menu',menu), getPublicMenu:()=>response('menu',menu),
    getSharedCart:()=>response('cart',state.cart),getTableOrders:()=>response('orders',[]),
    getTodayPerformances:()=>response('performance',null),getCustomerBenefits:()=>response('benefits',[]),
    getMiniBootstrap:()=>response('membership',{membershipTerms:null}),
    getWechatNotificationPrompt:()=>response('notification',{available:false,presentation:[]}),
    getAlipayNotificationPrompt:()=>response('notification',{available:false,presentation:[]}),
    getServiceRequests:()=>response('service',[]),
    getRecommendationConfiguration:()=>response('recommendation',{inputConfiguration:{version:1,questions:[]}}),
    recommendExperience:()=>response('recommendation',{recommendations:[]}),recordRecommendationEvent:async()=>{},
    adjustSharedCart:async(productId,delta)=>{await response('add',null);const product=menu.find(x=>x.productId===productId);state.cart={generation:1,version:state.cart.version+1,totalAmountMinor:800,lines:[{productId,name:product.name,quantity:1,unitPriceMinor:800,subtotalAmountMinor:800,available:true,portionIds:[]}]};return state.cart},
    checkoutSharedCart:async()=>{await response('submit',null);return {data:{order:{publicId:'test-order'},settlement:{payableAmountMinor:800},payment:null,sharedCart:{generation:2,version:0,totalAmountMinor:0,lines:[]}}}},
    ...overrides,
  }
  const runtime={getStorageSync:k=>state.storage.get(k),setStorageSync:(k,v)=>state.storage.set(k,v),removeStorageSync:k=>state.storage.delete(k),
    showToast:()=>{},showModal:()=>{},getSystemInfoSync:()=>({windowWidth:390}),getWindowInfo:()=>({windowWidth:390}),
    requestSubscribeMessage:({success})=>success?.({}),hideLoading:()=>{},showLoading:()=>{},navigateTo:()=>{}}
  const cache=new Map();let definition
  const timer=(fn,ms)=>{const id=setTimeout(()=>{state.timers.delete(id);fn()},ms);state.timers.add(id);return id}
  const readModule=file=>{
    if(cache.has(file))return cache.get(file).exports
    const module={exports:{}};cache.set(file,module)
    const context={module,exports:module.exports,Page:d=>{definition=d},wx:runtime,Date,Map,Set,Promise,
      setTimeout:timer,clearTimeout:id=>{state.timers.delete(id);clearTimeout(id)},getApp:()=>({globalData:{}}),
      require(spec){
        const target=resolve(dirname(file),spec)+(spec.endsWith('.js')?'':'.js')
        if(spec.endsWith('/api')||spec==='./api')return api
        if(spec.endsWith('/platform'))return runtime
        if(spec.endsWith('/config/index')||spec==='../config/index')return {getRuntimeConfig:()=>({apiBaseUrl:'https://menu.example.test',isDevelopment:false,mode:'production',wechatIdentityEnabled:false,alipayPaymentEnabled})}
        if(spec.endsWith('/session')||spec==='./session')return {getTableSession:()=>state.session,tableSessionCacheScope:()=>`${state.session.tableToken}:${state.session.cartScope}`}
        if(spec.endsWith('/public-share'))return {enablePublicShareMenu:()=>{},publicSharePayload:v=>v,publicTimelinePayload:v=>v}
        if(/\/(wechat|alipay)-subscription$/.test(spec))return {
          requestWechatSubscription:async()=>({outcomes:[]}),requestAlipaySubscription:async()=>({outcomes:[]}),
          extractPromptPresentation:v=>v?.presentation||[],mergeWechatNotificationPromptOptions:()=>[],mergeAlipayNotificationPromptOptions:()=>[]}
        return readModule(target)
      }}
    let sourceFile=file
    if(baseline && file===resolve(root,'pages/order/index.js'))sourceFile=resolve(baselineRoot,'pages/order/index.js')
    if(baseline && file===resolve(root,'utils/media.js'))sourceFile=resolve(baselineRoot,'utils/media.js')
    const source = readFileSync(sourceFile,'utf8').replace(/export\s*\{([^}]*)\}/g, 'module.exports = {$1}')
    vm.runInNewContext(source,context,{filename:file})
    return module.exports
  }
  readModule(resolve(root,'pages/order/index.js'))
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data))})
  page.setData=(patch,callback)=>{Object.assign(page.data,patch);if(patch.loading===false && page.data.products.length && state.timings.menu===undefined)state.timings.menu=Date.now();if(patch.orderReady===true)state.timings.ready=Date.now();callback?.()}
  // Background polling is a different test surface; retain real filtering, cart, scoped guards and mutations.
  page.startSharedCartPolling=()=>{};page.startServicePolling=()=>{};page.ensureInitialRecommendations=()=>{}
  page.handlePaymentAction=async()=>{}
  return {page,state,api,menu,dispose:()=>{for(const id of state.timers)clearTimeout(id);page.invalidateTableRequests()}}
}
