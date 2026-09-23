import {describe,expect,it} from 'vitest'
import {readFileSync} from 'node:fs'
import {fulfillmentNeedsPhoneAttention} from './staff-notice-controller'

describe('shared pickup phone integration',()=>{
  it('does not interrupt servers for each newly ready shared pickup wave',()=>{
    expect(fulfillmentNeedsPhoneAttention({readyForDelivery:true,canPrepare:false,canRemake:false},true)).toBe(false)
  })
  it('preserves legacy personal delivery reminders while shared pickup is disabled',()=>{
    expect(fulfillmentNeedsPhoneAttention({readyForDelivery:true},false)).toBe(true)
  })
  it('preserves attention for new unfinished production',()=>{
    expect(fulfillmentNeedsPhoneAttention({readyForDelivery:false,canPrepare:true},true)).toBe(true)
  })
  it('does not suppress unfinished portions for a worker who can still prepare a partial batch',()=>{
    expect(fulfillmentNeedsPhoneAttention({readyForDelivery:true,canPrepare:true},true)).toBe(true)
  })
  it('preserves remake exception attention',()=>{
    expect(fulfillmentNeedsPhoneAttention({readyForDelivery:true,canRemake:true},true)).toBe(true)
  })
  it('uses the same interruption policy in both integrated and standalone phone notice paths',()=>{
    const panel=readFileSync(new URL('./StaffActionsPanel.tsx',import.meta.url),'utf8'),notice=readFileSync(new URL('./StaffReadyNotice.tsx',import.meta.url),'utf8')
    expect(panel.match(/fulfillmentNeedsPhoneAttention\(item,threeScreenEnabled\)/g)).toHaveLength(2)
    expect(notice).toMatch(/fulfillmentNeedsPhoneAttention\(\{readyForDelivery:true\},\(?queue\.actor\.threeScreenWorkflowEnabled===true/)
    expect(notice).toContain('queue.actor.sharedPickupActive===true')
    expect(panel).not.toContain('请立即进入“出品”查看制作与配送')
    expect(notice).toContain('取餐屏确认取走后自动同步')
  })
  it('makes one-time device setup reachable by configuration-only administrators',()=>{
    const panel=readFileSync(new URL('./StaffActionsPanel.tsx',import.meta.url),'utf8')
    expect(panel).toContain("(permissions.includes('kds.deliver')||permissions.includes('staff.access.configure'))&&<button")
  })
})
