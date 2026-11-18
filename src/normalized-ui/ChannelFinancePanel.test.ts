import {createElement, useState} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {afterEach,expect,it,vi} from 'vitest'
import {ChannelFinancePanel} from './ChannelFinancePanel'
import {ChannelReportPanel} from './ChannelReportPanel'
import {StaffTodoPanel} from './StaffTodoPanel'
import type {StaffBootstrapView} from '../shared/normalized-contracts'
import type {StaffAuthView,NormalizedApiClient} from '../normalized-api'
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn()}))
vi.mock('./staff-view-state',()=>({useStaffViewState:(_key:string,value:unknown)=>[value,vi.fn()]}))
afterEach(()=>vi.clearAllMocks())
it('renders maturity, refresh, ledger and statement evidence in Beijing time without leaking raw UTC or null',()=>{
 let index=0
 const data={positions:[{visitId:'visit',promoterId:'promoter',basisMinor:16000,commissionMinor:1600,frozen:false,maturesAt:'2026-12-31 16:00:00.123456+00',checkedAt:'2026-12-31 15:59:59.999999+00'}],statements:[],ledger:[{id:'ledger',visitId:'visit',deltaMinor:-200,createdAt:'2026-02-29T00:00:00Z'}],accounts:[],balances:[],payouts:[],limit:500}
 const detail={statement:{id:'statement'},lines:[{createdAt:'2024-02-28 16:00:00+00',deltaMinor:1800}]}
 // Seed only the two nullable data slots; unrelated form state may be added before them.
 vi.mocked(useState).mockImplementation(initial=>[initial===null?(index++===0?data:detail):initial,vi.fn()] as never)
 const html=renderToStaticMarkup(createElement(ChannelFinancePanel,{api:{} as NormalizedApiClient,auth:{session:{id:'s'},permissions:['channel.settle']} as StaffAuthView,partners:[]}))
 expect(html).toContain('北京时间');expect(html).toContain('2027-01-01 00:00');expect(html).toContain('2026-12-31 23:59');expect(html).toContain('2024-02-29 00:00');expect(html).toContain('时间待核对');expect(html).not.toContain('+00')
})
it('shows report timestamps in Beijing time and keeps uncalculated rows explicit',()=>{
 let index=0
 vi.mocked(useState).mockImplementation(initial=>[index++===0?[{id:'a',checkedAt:'2026-12-31 16:00:00+00'},{id:'b',checkedAt:null}]:initial,vi.fn()] as never)
 const html=renderToStaticMarkup(createElement(ChannelReportPanel,{api:{} as NormalizedApiClient,sessionId:'s'}))
 expect(html).toContain('2027-01-01 00:00');expect(html).toContain('北京时间');expect(html).toContain('尚未核对');expect(html).not.toContain('+00')
})
it('uses the same Beijing date boundary for the authoritative refund todo count',()=>{
 let index=0
 vi.mocked(useState).mockImplementation(initial=>[index++===1?[{id:'refunds',label:'退款',count:{total:1,action:0,waiting:1,asOf:'2026-12-31 16:00:00+00'},error:false}]:initial,vi.fn()] as never)
 const bootstrap={staff:{id:'operator'},access:{permissions:['refund.approve']},navigation:[{code:'payments'}]} as StaffBootstrapView
 const html=renderToStaticMarkup(createElement(StaffTodoPanel,{api:{} as NormalizedApiClient,bootstrap}))
 expect(html).toContain('截至 2027-01-01 00:00（北京时间）');expect(html).toContain('等待处理 1 项');expect(html).not.toContain('+00')
})
