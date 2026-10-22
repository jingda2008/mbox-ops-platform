import {afterEach,describe,it,expect,vi} from 'vitest'
import {HardwareRepository} from './hardware-repository.js'
import {PrintTicketSourceRepository} from './print-ticket-source.js'
import type {ScopedTransaction} from './transaction-runner.js'
const scope={tenantId:'10000000-0000-4000-8000-000000000001',storeId:'20000000-0000-4000-8000-000000000001'}
afterEach(()=>vi.restoreAllMocks())
describe('活动纸票与原制作来源',()=>{
 it('同一套餐不同岗位保留同号、不同制作编号和原选择；迟生成票明示已做数量',async()=>{
  const captured:Parameters<HardwareRepository['materializeFromOutbox']>[0][]=[]
  vi.spyOn(HardwareRepository.prototype,'materializeFromOutbox').mockImplementation(async input=>{captured.push(input);return []})
  const ids=['40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002']
  for(const [index,lineId] of ids.entries()){
   const tx={scope,query:vi.fn(async()=>({rowCount:1,rows:[{number:36,business_date:'2026-10-22',location:'A区',name:index?'果汁':'牛肉',quantity:2,station_code:index?'bar':'kitchen',created_at:'2026-10-22T10:00:00Z',public_id:'original-registration',title:'晚餐活动',package_name:'五人套餐',status:'active',held:false,started_quantity:1,ready_quantity:1,taken_quantity:0,note:'不放香菜',selection_label:'主菜：牛肉',remake_reason:null}]}))} as unknown as ScopedTransaction
   await new PrintTicketSourceRepository(tx).materializeActivityProduction('50000000-0000-4000-8000-000000000001',lineId)
   expect(tx.query).toHaveBeenCalledTimes(1)
  }
  expect(captured.map(x=>x.stationCode)).toEqual(['kitchen','bar'])
  expect(captured.map(x=>x.printSnapshot?.ticketReference)).toEqual(ids)
  for(const input of captured){
   expect(input.printSnapshot).toMatchObject({tableCode:'餐号 36',lines:[{quantity:2}]})
   expect(JSON.stringify(input.printSnapshot)).toContain('主菜：牛肉')
   expect(JSON.stringify(input.printSnapshot)).toContain('制单时已开做 1')
   expect(JSON.stringify(input.printSnapshot)).toContain('补打只核对，不追加制作')
  }
 })
})
