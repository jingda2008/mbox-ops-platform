import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
const root = new URL('../miniprogram/', import.meta.url)
function utility(name) {
  const module = {exports:{}}
  vm.runInNewContext(readFileSync(new URL('utils/'+name+'.js',root),'utf8'),{module,require:()=>utility('format')})
  return module.exports
}
const order = {id:'one',public_id:'20260916-235900-100001-1',item_name:'测试酒',unit:'瓶',remaining_quantity:'0.500000',original_quantity:'1.000000',status:'stored',expires_at:'2020-01-01 12:00:00+08',stored_at:'2026-09-16 12:00:00+08'}
const detail = () => ({order:{...order,declared_value_minor:0,extra_field_snapshot:[{key:'seal',label:'封口状态'}],extra_fields:{seal:'完好'}},deposits:[{id:'photo',phone:'+8613800012345',quantity:'0.500000',watermark:'M-BOX'}],collections:[],events:[]})
function harness(kind,api,runtime={}) {
  let page;const files=new Set();let preview
  const wx={env:{USER_DATA_PATH:'/test'},getFileSystemManager:()=>({writeFile(o){files.add(o.filePath);o.success()},unlink(o){files.delete(o.filePath)}}),previewImage(o){preview=o},stopPullDownRefresh(){},...runtime}
  vm.runInNewContext(readFileSync(new URL('pages/'+kind+'/index.js',root),'utf8'),{wx,Page(p){page=p;p.setData=d=>Object.assign(p.data,d)},require(name){return name.endsWith('/api')?api:name.endsWith('/custody')?utility('custody'):{customerErrorMessage:(_e,f)=>f}}})
  return {page,files,preview:()=>preview}
}
test('quantities, Beijing time, expiry and historical extra fields preserve business meaning',()=>{
  const data=utility('custody').presentDetail(detail())
  assert.equal(data.order.remainingText,'0.5');assert.equal(data.order.originalText,'1')
  assert.equal(data.order.storedText,'2026-09-16 12:00');assert.equal(data.order.statusText,'已到期 · 待门店处理')
  assert.equal(data.order.valueText,'¥0.00');assert.equal(data.order.extraRows[0].value,'完好')
  assert.equal(data.deposits[0].phone,'+8613800012345')
})
test('list pagination failure is retryable without losing rows; retries deduplicate',async()=>{
  let calls=0
  const {page}=harness('profile-bottles',{async getCustomerBottles(cursor){if(!cursor)return {items:[order],nextCursor:'next'};if(++calls===1)throw Error('offline');return {items:[order,{...order,id:'two'}],nextCursor:null}}})
  await page.onShow();await page.loadMore();assert.equal(page.data.items.length,1);assert.equal(page.data.nextCursor,'next');assert.ok(page.data.error)
  await page.retry();assert.equal(page.data.items.length,2);assert.equal(page.data.error,'')
})
test('failed first read is not an empty successful list; hidden-page replies are discarded',async()=>{
  let resolve
  const {page}=harness('profile-bottles',{getCustomerBottles:()=>Promise.reject(Error('offline'))})
  await page.load();assert.equal(page.data.loaded,false);assert.ok(page.data.error)
  const pending=harness('profile-bottles',{getCustomerBottles:()=>new Promise(r=>{resolve=r})}).page
  const work=pending.load();pending.onHide();resolve({items:[order]});await work
  assert.equal(pending.data.items.length,0);assert.equal(pending.data.loaded,false)
})
test('photo failures preserve full detail and allow retry and native preview; unload clears temporary photos',async()=>{
  let calls=0
  const h=harness('profile-bottle-detail',{getCustomerBottle:async()=>detail(),getCustomerBottlePhoto:async()=>{if(++calls===1)throw Error('offline');return {base64:'image'}}})
  h.page.onLoad({id:'one'});await h.page.onShow()
  assert.equal(h.page.data.loaded,true);assert.equal(h.page.data.deposits[0].phone,'+8613800012345');assert.ok(h.page.data.deposits[0].photoError)
  await h.page.loadPhoto('photo');assert.equal(h.files.size,1)
  h.page.photoAction({currentTarget:{dataset:{id:'photo'}}});assert.ok(h.preview().current)
  h.page.onHide();assert.equal(h.files.size,1);h.page.onShow();assert.equal(calls,2)
  h.page.onUnload();assert.equal(h.files.size,0);assert.equal(h.page.data.order,null)
})
test('late photos cannot restore another session data or persist new files',async()=>{
  let resolve
  const h=harness('profile-bottle-detail',{getCustomerBottle:async()=>detail(),getCustomerBottlePhoto:()=>new Promise(r=>{resolve=r})})
  h.page.onLoad({id:'one'});const work=h.page.load();await new Promise(r=>setImmediate(r));h.page.onHide()
  resolve({base64:'old-image'});await work;assert.equal(h.files.size,0);assert.equal(h.page.data.order,null)
})
