import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it,vi} from 'vitest'
import {ActivityRefundReviewActions} from './ActivityRefundReviewActions'
const render=(canUseCashier:boolean,blockedReason:string|null,busy=false)=>renderToStaticMarkup(createElement(ActivityRefundReviewActions,{registrationPublicId:'活动 A/1',canUseCashier,blockedReason,busy,onDecision:vi.fn()}))
it('keeps an authorized activity-only reviewer on the existing activity page',()=>{
 const html=render(false,null);expect(html).toContain('收银复核通过');expect(html).toContain('驳回');expect(html).not.toContain('/staff/payments')
 expect(render(false,null,true)).toContain('disabled')
})
it.each(['本人不可审核','复核额度不足','复核额度尚未读取'])('does not expose decisions when blocked: %s',reason=>{
 const html=render(false,reason);expect(html).toContain(reason);expect(html).not.toContain('<button');expect(html).not.toContain('href')
})
it('offers the cashier link only when the actor can access activity cashier records',()=>{
 const html=render(true,null);expect(html).toContain('/staff/payments?query=%E6%B4%BB%E5%8A%A8%20A%2F1');expect(html).not.toContain('<button')
})
