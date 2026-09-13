import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
for(const platform of ['miniprogram','alipay-miniprogram']){
 test(`${platform} waiting polls coalesce and an actual new scan bypasses the waiting flow`,async()=>{
  const source=await readFile(new URL(`../${platform}/utils/api.js`,import.meta.url),'utf8')
  const start=source.indexOf('async function loadGuestSession()'),end=source.indexOf('\nasync function publicRequest',start)
  let session={tableToken:'table-a',scanNonce:'scan-a',cartScope:''}
  const store=new Map([['mbox.table.connection.state',{status:'waiting_for_table',scanNonce:'scan-a'}]])
  const runtime={getStorageSync:key=>store.get(key),setStorageSync:(key,value)=>store.set(key,value),removeStorageSync:key=>store.delete(key)}
  const calls=[],connections=[];let finish
  const fn=vm.runInNewContext(source.slice(start,end)+';getGuestSession',{
   wx:runtime,runtime,getTableSession:()=>session,tableRequestScope:s=>s.tableToken+':'+s.scanNonce,
   ensureCustomerSession:async()=>{},deviceKey:()=> 'device',
   request:(path,options)=>{calls.push({path,options});return new Promise(resolve=>{finish=resolve})},
   rememberTableConnection:data=>connections.push(data),clearTableConnection:()=>{},
  })
  const first=fn(),second=fn()
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/guest/session/wait')
  finish({data:{status:'waiting_for_table'}});await Promise.all([first,second])
  assert.equal(connections.length,1)
  const ready=fn();finish({data:{status:'ready_for_scan'}})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls.at(-1).path,'/api/guest/session/scan')
  finish({data:{status:'active'}});await ready
  assert.equal(connections.at(-1).status,'active')
  session={tableToken:'table-b',scanNonce:'scan-b',cartScope:''}
  const moved=fn();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls.at(-1).path,'/api/guest/session/scan')
  assert.equal(calls.at(-1).options.data.tableQrToken,'table-b')
  finish({data:{status:'active'}});await moved
  assert.equal(store.get('mbox.connected.table.token'),'table-b')
 })
 test(`${platform} a wait result arriving after a new scan cannot bind the previous table`,async()=>{
  const source=await readFile(new URL(`../${platform}/utils/api.js`,import.meta.url),'utf8')
  const start=source.indexOf('async function loadGuestSession()'),end=source.indexOf('\nasync function publicRequest',start)
  let session={tableToken:'a',scanNonce:'a',cartScope:''},finish,connections=0
  const runtime={getStorageSync:key=>key==='mbox.table.connection.state'?{status:'waiting_for_table',scanNonce:'a'}:null}
  const fn=vm.runInNewContext(source.slice(start,end)+';getGuestSession',{
   wx:runtime,runtime,getTableSession:()=>session,tableRequestScope:s=>s.tableToken+':'+s.scanNonce,
   deviceKey:()=> 'device',request:()=>new Promise(resolve=>{finish=resolve}),
   rememberTableConnection:()=>{connections++},
  })
  const pending=fn();session={tableToken:'b',scanNonce:'b',cartScope:''}
  finish({data:{status:'ready_for_scan'}})
  await assert.rejects(pending,error=>error.code==='TABLE_SESSION_SCOPE_CHANGED')
  assert.equal(connections,0)
 })
 test(`${platform} invalid rescan never reinstates old credentials or cart`,async()=>{
  const source=await readFile(new URL(`../${platform}/utils/api.js`,import.meta.url),'utf8')
  const start=source.indexOf('async function loadGuestSession()'),end=source.indexOf('\nasync function ',start+10)
  const session={tableToken:'new-invalid-token',scanNonce:'new-scan',cartScope:''}
  const store=new Map([['mbox.table.scan.previous',{session:{tableToken:'old',cartScope:'old-scope'},cookie:'old-cookie'}]])
  const runtime={getStorageSync:key=>store.get(key),setStorageSync:(key,value)=>store.set(key,value),removeStorageSync:key=>store.delete(key)}
  let restores=0,connections=0,requests=0
  const fn=vm.runInNewContext(source.slice(start,end)+';loadGuestSession',{
    wx:runtime,runtime,getTableSession:()=>session,tableRequestScope:s=>s.tableToken+':'+s.scanNonce,
    ensureCustomerSession:async()=>{},deviceKey:()=> 'device',
    request:async()=>{requests++;throw Object.assign(new Error('invalid'),{code:'TABLE_QR_INVALID'})},
    restoreRejectedTableScan:()=>{restores++;return true},rememberTableConnection:()=>{connections++},clearTableConnection:()=>{},
  })
  await assert.rejects(fn(),error=>error.code==='TABLE_QR_INVALID'&&error.message.includes('同步未成功'))
  assert.equal(requests,1);assert.equal(restores,0);assert.equal(connections,0)
  assert.equal(session.cartScope,'');assert.equal(store.get('mbox.http.cookie.guest.v2'),undefined)
 })
}
