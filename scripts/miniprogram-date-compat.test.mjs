import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { loadMiniModule } from './load-miniprogram-test-module.mjs'
const root = new URL('../miniprogram/', import.meta.url)
const formatUrl = new URL('utils/format.js', root)
const formatSource = readFileSync(formatUrl, 'utf8')
const format = loadMiniModule(formatUrl)
const stamp = '2026-12-31T16:00:00.123Z'
const equivalent = ['2026-12-31 16:00:00.123456+00', '2026-12-31 16:00:00.123+0000', '2026-12-31T16:00:00.123Z', '2027-01-01 00:00:00.123+08', '2027-01-01T00:00:00.123+08:00', '2026-12-31T11:00:00.123-05:00']
for (const input of equivalent) test('Postgres/ISO same instant and Beijing year: '+input, () => {
  assert.equal(format.parseInstant(input), Date.parse(stamp))
  assert.equal(format.beijingDateTime(input), '2027-01-01 00:00')
  assert.equal(format.dateTime(input), '01-01 00:00')
})
for (const input of [null, undefined, '', '   ', false, {}, '2026-11-15 19:00:00', '2026-11-15T19:00:00', '2026-11-15', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-10T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+08:60', 'infinity', '1760000000000']) test('invalid or ambiguous instant fails closed: '+JSON.stringify(input), () => {
  assert.ok(Number.isNaN(format.parseInstant(input)))
  assert.equal(format.beijingDateTime(input, '待核对'), '待核对')
})
test('calendar dates remain dates; missing values never become 1970', () => {
  assert.equal(format.beijingDate('2024-02-29'), '2024-02-29')
  assert.equal(format.beijingDate('2026-02-29'), '--')
  assert.equal(format.beijingDateTime(0), '1970-01-01 08:00')
  assert.equal(format.beijingDateTime(null), '--')
})
test('Beijing midnight and leap day boundaries', () => {
  for (const [input, expected] of [['2026-11-15T15:59:59.999Z','2026-11-15 23:59'],['2026-11-15T16:00:00Z','2026-11-16 00:00'],['2024-02-28T16:00:00Z','2024-02-29 00:00'],['2024-02-29T16:00:00Z','2024-03-01 00:00']]) assert.equal(format.beijingDateTime(input),expected)
})
test('native parser only receives strict ISO with millisecond precision, without Intl', () => {
  class StrictDate extends Date {
    static parse(input) { assert.match(input,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/); return Date.parse(input) }
    constructor(...args) { assert.notEqual(typeof args[0],'string'); super(...args) }
  }
  const module={exports:{}}
  vm.runInNewContext(formatSource,{module,Date:StrictDate,Intl:undefined})
  for (const input of equivalent) assert.equal(module.exports.beijingDateTime(input),'2027-01-01 00:00')
  assert.equal(module.exports.beijingDateTime('not-a-time'),'--')
})
for (const TZ of ['UTC','Asia/Shanghai','America/Los_Angeles']) test('display independent of device timezone '+TZ, () => {
  const code=`import {loadMiniModule} from './scripts/load-miniprogram-test-module.mjs';const f=loadMiniModule(new URL('./miniprogram/utils/format.js',import.meta.url));console.log(JSON.stringify([f.dateTime('${stamp}'),f.beijingDate('${stamp}'),f.parseInstant('2027-01-01 00:00:00.123+08')]))`
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('..',import.meta.url),env:{...process.env,TZ},encoding:'utf8'}))
  assert.deepEqual(result,['01-01 00:00','2027-01-01',Date.parse(stamp)])
})
// Expose local presentation functions only in this isolated test VM; no source copying.
function pageFunctions(path,names) {
 const module={exports:{}}
 vm.runInNewContext(readFileSync(new URL(path,root),'utf8')+'\nmodule.exports={'+names.join(',')+'}',{module,Page(){},Component(){},wx:{},require:name=>name.endsWith('/format')?format:{}})
 return module.exports
}
test('channel offer, existing coupon and wallet use the same Beijing validity', () => {
 const {present}=pageFunctions('pages/channel-coupons/index.js',['present'])
 const result=present({status:'available',useFrom:'2026-12-31 15:59:00+00',useUntil:'2026-12-31 16:00:00.123456+00',claimFrom:'2026-12-30T16:00:00Z',claimUntil:'2026-12-31T15:59:00Z',offer:{kind:'credit',amountMinor:1000},minimumMinor:0})
 assert.equal(result.timeText,'2026-12-31 23:59 至 2027-01-01 00:00')
 assert.equal(result.claimTimeText,'2026-12-31 00:00 至 2026-12-31 23:59')
 assert.match(present({...result,useUntil:null}).timeText,/待核对$/)
})
test('member wallet invalid end is not unlimited; explicit null retains no-fixed-end meaning', () => {
 const {present}=pageFunctions('pages/profile-coupons/index.js',['present'])
 const row={validFrom:stamp,validUntil:'bad',quantityAvailable:1,display:{}}
 for (const validUntil of ['bad','',undefined]) assert.match(present({...row,validUntil}).validText,/截止时间待核对/)
 assert.doesNotMatch(present(row).validText,/无固定截止/)
 assert.match(present({...row,validUntil:null}).validText,/无固定截止日期/)
 const {benefitView}=pageFunctions('pages/profile/index.js',['benefitView'])
 for(const validUntil of ['bad','',undefined])assert.equal(benefitView({validUntil}).validText,'有效期待核对')
 assert.equal(benefitView({validUntil:null}).validText,'长期有效')
})
test('points expiry, card, marketing and privacy presenters share Beijing time', () => {
 const points=pageFunctions('pages/points/index.js',['shortDate','ledgerMeta'])
 assert.equal(points.shortDate(equivalent[0]),'2027-01-01 00:00')
 assert.match(points.ledgerMeta({expiresAt:stamp}),/有效至 2027-01-01/)
 for (const [path,name] of [['pages/profile-cards/index.js','time'],['pages/profile-marketing/index.js','localTime'],['pages/privacy/index.js','formatPolicyTime']]) assert.equal(pageFunctions(path,[name])[name](equivalent[0]),'2027-01-01 00:00')
})
test('activity visibility and approved identity are inclusive at start, exclusive at end', () => {
 const activities=loadMiniModule(new URL('utils/activity-display.js',root))
 const {activeIdentities}=pageFunctions('components/member-identities/index.js',['activeIdentities'])
 const from='2026-12-31 15:59:00+00',until='2027-01-01 00:00:00+08'
 const start=Date.parse('2026-12-31T15:59:00Z'),end=Date.parse('2026-12-31T16:00:00Z')
 const card={id:'c',name:'演示卡',status:'active',expired:false,valid_from:from,valid_until:until}
 for (const [now,valid] of [[start-1,false],[start,true],[end-1,true],[end,false],[end+1,false]]) assert.equal(activeIdentities([card],now).length,valid?1:0)
 assert.equal(activeIdentities([{...card,valid_until:'bad'}],start).length,0)
 assert.match(activities.activityTimeText({startsAt:from,endsAt:until},start),/^进行中/)
 assert.equal(activities.currentActivities([{endsAt:until,status:'published'}],end-1).length,1)
 assert.equal(activities.currentActivities([{endsAt:until,status:'published'}],end).length,0)
})
test('coupon quote cannot pass at or after exact expiry, including PG microseconds', () => {
 const expiry=Date.parse('2026-12-31T16:00:00.123Z')
 for (const delta of [-1,0,1]) {
  class ClockDate extends Date { static now(){return expiry+delta} }
  const utils=loadMiniModule(new URL('utils/checkout-coupons.js',root)),module={exports:{}}
  vm.runInNewContext(readFileSync(new URL('utils/checkout-coupons.js',root),'utf8'),{module,Date:ClockDate,require:()=>format})
  const page={data:{...utils.initialCheckoutCoupons,cart:[],cartGeneration:1,cartVersion:2,couponQuote:{sourceType:'channel_quote',current:true,generation:1,version:2,expiresAt:equivalent[0]}},setData(v){Object.assign(this.data,v)},...module.exports.checkoutCouponMethods({})}
  assert.equal(page.couponCheckoutReady(),delta<0)
  if(delta>=0){assert.equal(page.data.couponQuote,null);assert.equal(page.data.couponNeedsReview,true)}
 }
})
test('no page reintroduces raw native string parsing; HTTP cookie grammar is separate', () => {
 function scan(url){for(const f of readdirSync(url,{withFileTypes:true})){const child=new URL(f.name+(f.isDirectory()?'/':''),url);if(f.isDirectory())scan(child);else if(f.name.endsWith('.js')&&!child.pathname.endsWith('/utils/format.js')){const source=readFileSync(child,'utf8');if(child.pathname.endsWith('/utils/request.js'))assert.equal((source.match(/Date\.parse\(/g)||[]).length,1);else assert.doesNotMatch(source,/Date\.parse\(/);assert.doesNotMatch(source,/new Date\((?:value|item\.|card\.|dateInput\()/)}}}
 scan(root)
})
