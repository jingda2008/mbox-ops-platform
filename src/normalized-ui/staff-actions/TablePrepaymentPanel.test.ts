import {createElement,useState} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {afterEach,expect,it,vi} from 'vitest'
import {TablePrepaymentPanel} from './TablePrepaymentPanel'
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn()}))
afterEach(()=>vi.clearAllMocks())
it.each([
 {reviewer:undefined,allowed:false},
 {reviewer:{employeeId:'reviewer',canApproveRefund:true,refundApprovalLimits:{}},allowed:false},
 {reviewer:{employeeId:'reviewer',canApproveRefund:true,refundApprovalLimits:{CNY:1999}},allowed:false},
 {reviewer:{employeeId:'reviewer',canApproveRefund:true,refundApprovalLimits:{USD:9999}},allowed:false},
 {reviewer:{employeeId:'requester',canApproveRefund:true,refundApprovalLimits:{CNY:2000}},allowed:false},
 {reviewer:{employeeId:'reviewer',canApproveRefund:false,refundApprovalLimits:{CNY:2000}},allowed:false},
 {reviewer:{employeeId:'reviewer',canApproveRefund:true,refundApprovalLimits:{CNY:2000}},allowed:true},
])('matches live prepayment review eligibility: %j',({reviewer,allowed})=>{
 let index=0
 const data={minimumMinor:0,waiverMinor:0,qualifyingGoodsMinor:0,shortfallMinor:0,availableMinor:0,refundableBalanceMinor:0,message:'隔离预收款',receipts:[],refunds:[{id:'r',publicId:'R',paymentId:'p',status:'requested',amountMinor:'2000',currency:'CNY',requestedByEmployeeId:'requester'}],reviewer}
 vi.mocked(useState).mockImplementation(initial=>[index++===0?data:initial,vi.fn()] as never)
 const html=renderToStaticMarkup(createElement(TablePrepaymentPanel,{sessionId:'table',staffSessionId:'staff',permissions:['refund.approve']}))
 expect(html.includes('>复核通过</button>')).toBe(allowed)
 expect(html.includes('>复核拒绝</button>')).toBe(allowed)
 if(!allowed)expect(html).toContain('额度')
})
