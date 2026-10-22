import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'
export function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b }); return {promise,resolve,reject} }
export const tick = () => new Promise(resolve => setImmediate(resolve))
export function pageFixture(name, overrides = {}) {
  let page
  const root = resolve('miniprogram'), cache = new Map(), calls = [], storage = new Map(), timers = []
  const state = { session: {tableCode:'W01',tableToken:'table-one',cartScope:'session-one'}, calls,storage,timers }
  const api = new Proxy(overrides, {get(target,key) { return key in target ? target[key] : async()=>{throw Error('Unexpected API '+String(key))} }})
  const wx = {
    getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),
    showToast:o=>calls.push(['toast',o]),showModal:o=>{calls.push(['modal',o]);o.success?.({confirm:true})},
    navigateTo:o=>calls.push(['navigate',o]),navigateBack:o=>calls.push(['back',o]),switchTab:o=>calls.push(['tab',o]),
    showShareMenu(){},stopPullDownRefresh(){},getWindowInfo:()=>({windowWidth:390,windowHeight:844}),
  }
  function load(file) {
    if(cache.has(file)) return cache.get(file).exports
    const module={exports:{}};cache.set(file,module)
    vm.runInNewContext(readFileSync(file,'utf8'),{module,exports:module.exports,Page:p=>{page=p},wx,Date,Intl,console,
      getApp:()=>({globalData:{}}),getCurrentPages:()=>[page],
      setTimeout:callback=>{timers.push(callback);return timers.length},clearTimeout:id=>{timers[id-1]=null},
      setInterval:()=>0,clearInterval:()=>{},
      require:specifier=>{
        const target=resolve(dirname(file),specifier+'.js')
        if(target===resolve(root,'utils/api.js'))return api
        if(target===resolve(root,'config/index.js'))return {getRuntimeConfig:()=>({isDevelopment:false,apiBaseUrl:'https://mbox.shmbox.com'})}
        if(target===resolve(root,'utils/session.js'))return {getTableSession:()=>state.session,tableSessionCacheScope:()=>JSON.stringify(state.session)}
        return load(target)
      },
    },{filename:file})
    return module.exports
  }
  load(resolve(root,'pages',name,'index.js'))
  page.data=structuredClone(page.data)
  page.setData=(patch,callback)=>{Object.assign(page.data,patch);callback?.()}
  return {page,api,state,wx,load}
}
