import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const dateModule = {exports:{}}
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/format.js', import.meta.url), 'utf8'), {module:dateModule,Date})

function harness(name: string) {
  let definition: any, owner = 'customer-a', loggedOut = false
  const pending = new Set<string>()
  const table: { tableToken?: string; scanNonce?: string; cartScope?: string } = {}
  const timers = new Map<number, () => void>(); let timerId = 0
  const api = { getGuestSession:vi.fn(async () => ({data:{status:"active",table:{code:"A01"}}})), recoverChannelClaim:vi.fn(async (_code:string)=>({claimId:'claim-a'})), recoverChannelCoupon:vi.fn(async (_id:string)=>({activationId:'active-a'})), getChannelStatement:vi.fn(async (_id:string)=>({statement:{id:_id},lines:[]})), respondChannelStatement:vi.fn(async (_id:string,_dispute:boolean,_reason:string)=>({})), getChannelWalletPage:vi.fn(async (_options?:unknown)=>({items:[] as any[],nextCursor:null as string|null})), getChannelHistory:vi.fn(async (_kind:string,_cursor?:string)=>({items:[] as any[],nextCursor:null as string|null})), getChannelOffer: vi.fn(async (_code: string) => ({ title: '餐后小聚', offer: {kind: 'credit', amountMinor: 1000}, minimumMinor:10000, useFrom:'2026-11-12T00:00:00Z', useUntil:'2026-11-13T00:00:00Z', claimedCount:0, unavailable:null })), getChannelWallet: vi.fn(async () => []), claimChannelCoupon: vi.fn(async (_code: string) => ({ claimId: 'claim-a' })),
    activateChannelCoupon: vi.fn(async (_id: string) => ({ activationId: 'active-a' })), getChannelPartner: vi.fn(async () => ({ promoter: { name: '店长' }, batches: [], visits: [] })),
    acceptChannelInvitation: vi.fn(async (_token: string) => ({})), getChannelPoster: vi.fn(async (_id: string) => ({ filename: 'poster.png', base64: 'PNG' })) }
  api.getChannelWalletPage.mockImplementation(async()=>({items:await api.getChannelWallet(),nextCursor:null}))
  const fs = { writeFile: vi.fn((o: any) => o.success()), unlink: vi.fn() }
  const wx = { navigateTo:vi.fn(), switchTab:vi.fn(), showModal:vi.fn((options:any)=>options.success?.({confirm:true})), scanCode: vi.fn(), env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => fs, saveImageToPhotosAlbum: vi.fn((o: any) => o.success()) }
  const auth = { ensureCustomerSession: vi.fn(async () => true), isMembershipLoggedOut: () => loggedOut }
  const gate = { redirectToMembershipLogin: vi.fn() }
  const app = {globalData: {channelOfferLaunch: null as any}}
  const entryModule = {exports:{}}
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/channel-entry.js', import.meta.url), 'utf8'), {module:entryModule})
  const dependencies: Record<string, unknown> = {
    '../../utils/format':dateModule.exports, '../../utils/auth':auth, '../../utils/membership-gate':gate, '../../utils/channel-entry':entryModule.exports,
    '../../utils/api': api, '../../utils/recoverable-command': { commandIdentityScope: () => owner, pendingGuestCommandMatches:(op:string,body:any)=>pending.has(owner+':'+op+':'+(body.claimId||body.code)) },
    '../../utils/customer-error': { customerErrorMessage: (e: any, fallback: string) => e.message || fallback }, '../../utils/session': { getTableSession: () => table },
  }
  vm.runInNewContext(readFileSync(new URL(`../../miniprogram/pages/${name}/index.js`, import.meta.url), 'utf8'), {
    require: (path: string) => { if (!(path in dependencies)) throw new Error(`Unexpected dependency ${path}`); return dependencies[path] },
    Page: (value: unknown) => { definition = value }, wx, getApp:()=>app, Date,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id: number) => timers.delete(id),
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(value: object) { Object.assign(this.data, value) } }
  async function openCoupon(id: string) {
    api.getChannelWallet.mockResolvedValueOnce([{id, status: 'available', offer: {kind: 'credit', amountMinor: 100}}] as never)
    await page.onShow()
    api.getChannelWalletPage.mockClear()
  }
  return { page, api, openCoupon, wx, fs, table, pending, auth, gate, app, timers, logout: () => {loggedOut=true}, changeOwner: () => { owner = 'customer-b' } }
}

describe('promotion claim visibility and wallet-to-order flow',()=>{
  const coupon=(id:string)=>({id,status:'available',title:'推广券',offer:{kind:'credit',amountMinor:1000}})
  it('makes claim the first prominent action before lengthy rule text',()=>{
    const markup=readFileSync(new URL('../../miniprogram/pages/channel-coupons/index.wxml',import.meta.url),'utf8')
    expect(markup.indexOf('bindtap="claim"')).toBeLessThan(markup.indexOf('领取：'))
    expect(markup).toContain('class="primary-button claim-primary" bindtap="claim"')
    expect(markup).toContain('立即领取优惠券')
  })
  it('shows the newly claimed coupon despite a previous expired filter and exposes My Coupons',async()=>{
    const {page,api,wx}=harness('channel-coupons');page.onLoad({code:'ABCDEFGH2345'});page.data.filterIndex=4;await page.onShow();await page.claim()
    expect(page.data.filterIndex).toBe(0);expect(api.getChannelWalletPage).toHaveBeenLastCalledWith({status:'all'});expect(page.data.notice).toContain('领取成功')
    page.openWallet();expect(wx.navigateTo).toHaveBeenCalledWith({url:'/pages/profile-coupons/index'})
  })
  it('finds exactly the selected later-page coupon without automatically claiming or activating',async()=>{
    const {page,api}=harness('channel-coupons');api.getChannelWalletPage.mockImplementation(async(options:any)=>options.cursor?{items:[coupon('chosen')],nextCursor:null}:{items:[coupon('first')],nextCursor:'next'})
    page.onLoad({code:'ABCDEFGH2345',claimId:'chosen',order:'1'});await page.onShow()
    expect(page.data.selectedCoupon.id).toBe('chosen');expect(api.activateChannelCoupon).not.toHaveBeenCalled();expect(api.claimChannelCoupon).not.toHaveBeenCalled();expect(api.getChannelWalletPage).toHaveBeenLastCalledWith({status:'all',code:'ABCDEFGH2345',cursor:'next'})
  })
  it('rejects a missing selection rather than substituting another coupon',async()=>{
    const {page,api}=harness('channel-coupons');api.getChannelWallet.mockResolvedValue([coupon('other')] as never);page.onLoad({code:'ABCDEFGH2345',claimId:'missing',order:'1'});await page.onShow();expect(page.data.selectedCoupon).toBe(null);expect(page.data.error).toContain('未查到所选');expect(api.activateChannelCoupon).not.toHaveBeenCalled()
  })
  it('rechecks an already bound coupon against the current table before continuing an interrupted order flow',async()=>{
    const {page,api,wx,table}=harness('channel-coupons');Object.assign(table,{tableToken:'table-a',cartScope:'visit-a',scanNonce:'scan-a'});api.getChannelWallet.mockResolvedValue([{...coupon('chosen'),status:'active'}] as never)
    page.onLoad({code:'ABCDEFGH2345',claimId:'chosen',order:'1'});await page.onShow();await page.useCoupon({currentTarget:{dataset:{id:'chosen'}}})
    expect(api.activateChannelCoupon).toHaveBeenCalledWith('chosen',false,expect.any(Function));expect(wx.switchTab).toHaveBeenCalledTimes(1);expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('does not jump into ordering when a delayed binding completes after hide and reentry',async()=>{
    const {page,api,wx,table}=harness('channel-coupons');Object.assign(table,{tableToken:'table-a',cartScope:'visit-a',scanNonce:'scan-a'});api.getChannelWallet.mockResolvedValue([coupon('chosen')] as never)
    page.onLoad({code:'ABCDEFGH2345',claimId:'chosen',order:'1'});await page.onShow();let finish!:()=>void
    api.activateChannelCoupon.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({activationId:'active-a'})}))
    const operation=page.useCoupon({currentTarget:{dataset:{id:'chosen'}}});await vi.waitFor(()=>expect(finish).toBeDefined());page.onHide();await page.onShow();finish();await operation
    expect(wx.switchTab).not.toHaveBeenCalled();expect(page.data.canGoToOrder).toBe(false)
  })
  for(const outcome of ['success','failure','account','table'])it('goes to order only after confirmed selected activation: '+outcome,async()=>{
    const {page,api,wx,table,changeOwner}=harness('channel-coupons');Object.assign(table,{tableToken:'table-a',cartScope:'visit-a',scanNonce:'scan-a'});api.getChannelWallet.mockResolvedValue([coupon('chosen')] as never)
    page.onLoad({code:'ABCDEFGH2345',claimId:'chosen',order:'1'});await page.onShow()
    api.activateChannelCoupon.mockImplementation(async()=>{if(outcome==='failure')throw Error('offline');if(outcome==='account')changeOwner();if(outcome==='table')table.cartScope='visit-b';return {activationId:'active-a'}})
    await page.useCoupon({currentTarget:{dataset:{id:'chosen'}}})
    expect(api.activateChannelCoupon).toHaveBeenCalledTimes(1);expect(wx.switchTab).toHaveBeenCalledTimes(outcome==='success'?1:0)
    if(outcome==='success'){expect(wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/order/index'}));table.cartScope='visit-b';page.goToOrder();expect(wx.switchTab).toHaveBeenCalledTimes(1)}
  })
})

describe('channel mini program identity and action boundaries', () => {
  it('summarizes all goods in both landing and wallet while legacy selected goods retain their names',async()=>{
    const {page,api}=harness('channel-coupons')
    const goods={offer:{kind:'credit',amountMinor:1000},eligibleProductScope:'all',eligibleProducts:[{id:'p',name:'不应展开的明细'}]}
    api.getChannelOffer.mockResolvedValue(goods as never)
    api.getChannelWallet.mockResolvedValue([{...goods,id:'all'},{...goods,id:'legacy',eligibleProductScope:undefined}] as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.onShow()
    expect(page.data.offer.productText).toBe('全部商品参与（本券生成时在售商品）')
    expect(page.data.coupons[0].productText).toBe(page.data.offer.productText)
    expect(page.data.coupons[1].productText).toBe('不应展开的明细')
  })
  it('refreshes a foreground wallet when a claim finishes after hide/show read an older snapshot', async () => {
    const {page,api}=harness('channel-coupons')
    let finish!: () => void
    api.claimChannelCoupon.mockImplementation(() => new Promise(resolve => {finish=()=>resolve({claimId:'late'})}))
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.onShow()
    const write=page.claim();page.onHide();await page.onShow()
    api.getChannelWallet.mockResolvedValue([{id:'late',status:'available',offer:{kind:'credit',amountMinor:1000}}] as never)
    finish();await write
    expect(page.data.coupons.map((c:any)=>c.id)).toEqual(['late'])
    expect(api.claimChannelCoupon).toHaveBeenCalledTimes(1)
    expect(page.data.notice).toBe('')
  })
  it('refreshes a stale expired coupon after the server rejects activation without silently retrying', async () => {
    const {page,api,table,openCoupon}=harness('channel-coupons');table.tableToken='table-a'
    table.cartScope='visit-a'; await openCoupon('expired')
    api.getChannelWallet.mockResolvedValue([{id:'expired',status:'expired',offer:{kind:'credit',amountMinor:1000}}] as never)
    api.activateChannelCoupon.mockRejectedValue(new Error('优惠已过期'))
    await page.useCoupon({currentTarget:{dataset:{id:'expired'}}})
    expect(page.data.coupons[0]?.status).toBe('expired')
    expect(page.data.error).toBe('优惠已过期')
    expect(api.activateChannelCoupon).toHaveBeenCalledTimes(1)
  })
  it('never presents an old-table activation as success on the newly scanned table', async () => {
    const {page,api,table,openCoupon}=harness('channel-coupons');table.tableToken='table-a';table.cartScope='visit-a';await openCoupon('coupon')
    let finish!:()=>void
    api.activateChannelCoupon.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({activationId:'old'})}))
    const write=page.useCoupon({currentTarget:{dataset:{id:'coupon'}}})
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    table.tableToken='table-b';table.cartScope='visit-b';finish();await write
    expect(page.data.notice).toBe('')
    expect(api.getChannelWalletPage).toHaveBeenCalledTimes(1)
    expect(api.activateChannelCoupon).toHaveBeenCalledTimes(1)
  })
  it('schedules a read at a validity boundary and removes it while hidden', async () => {
    const {page,api,timers}=harness('channel-coupons')
    api.getChannelWallet.mockResolvedValue([{id:'ending',status:'available',useUntil:new Date(Date.now()+1000).toISOString(),offer:{kind:'credit',amountMinor:1000}}] as never)
    await page.onShow();expect(timers.size).toBe(1)
    const refresh=[...timers.values()][0]!
    api.getChannelWallet.mockResolvedValue([{id:'ending',status:'expired',offer:{kind:'credit',amountMinor:1000}}] as never)
    await refresh();expect(page.data.coupons[0].status).toBe('expired')
    page.onHide();expect(timers.size).toBe(0)
  })
  it.each(['hidden','account'])('does not refresh or display a late write result after %s',async change=>{
    const {page,api,changeOwner}=harness('channel-coupons')
    let finish!:()=>void
    api.claimChannelCoupon.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({claimId:'old'})}))
    const write=page.write('claim','ABCDEFGH2345')
    if(change==='hidden')page.onHide();else changeOwner()
    finish();await write
    expect(api.getChannelWalletPage).not.toHaveBeenCalled()
    expect(page.data.notice).toBe('');expect(page.data.busy).toBe(false)
  })
  it('keeps an unknown write recoverable and performs only a read after a lost response',async()=>{
    const {page,api}=harness('channel-coupons')
    api.claimChannelCoupon.mockRejectedValue(new Error('网络中断，结果待核对'))
    api.getChannelWallet.mockResolvedValue([{id:'committed',status:'available',offer:{kind:'credit',amountMinor:1000}}] as never)
    await page.write('claim','ABCDEFGH2345')
    expect(page.data.coupons[0].id).toBe('committed');expect(page.data.error).toContain('待核对')
    expect(api.claimChannelCoupon).toHaveBeenCalledTimes(1)
  })
  it('does not expire active or fulfilled promises locally at their original use deadline',async()=>{
    const {page,api,timers}=harness('channel-coupons')
    api.getChannelWallet.mockResolvedValue(['active','fulfilled'].map(status=>({id:status,status,useUntil:new Date(Date.now()+1000).toISOString(),offer:{kind:'credit',amountMinor:1000}})) as never)
    await page.onShow();expect(timers.size).toBe(0)
    expect(page.data.coupons.map((c:any)=>c.status)).toEqual(['active','fulfilled'])
  })
  it('clears old-table success if the table changes during the post-write wallet refresh',async()=>{
    const {page,api,table,openCoupon}=harness('channel-coupons');table.tableToken='table-a';table.cartScope='visit-a';await openCoupon('coupon')
    let finish!:(value:never[])=>void
    api.getChannelWallet.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const write=page.useCoupon({currentTarget:{dataset:{id:'coupon'}}})
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    table.tableToken='table-b';table.cartScope='visit-b';finish([]);await write
    expect(page.data.notice).toBe('')
  })
  it.each(['active','fulfilled','expired','revoked'])('offers receipt recovery on a reopened %s coupon without reviving or issuing it',async status=>{
    const {page,api,pending}=harness('channel-coupons')
    pending.add('customer-a:channel.claim:ABCDEFGH2345');pending.add('customer-a:channel.activate:claim-a')
    api.getChannelOffer.mockResolvedValue({offer:{kind:'credit',amountMinor:1000},unavailable:'领取已满'} as never)
    api.getChannelWallet.mockResolvedValue([{id:'claim-a',status,offer:{kind:'credit',amountMinor:1000}}] as never)
    page.onLoad({code:'ABCDEFGH2345'});await page.onShow()
    expect(page.data.pendingClaim).toBe(true);expect(page.data.coupons[0].canRecover).toBe(true)
    await page.recoverClaim();await page.recoverCoupon({currentTarget:{dataset:{id:'claim-a'}}})
    expect(api.recoverChannelClaim).toHaveBeenCalledOnce();expect(api.recoverChannelCoupon).toHaveBeenCalledOnce()
    expect(api.claimChannelCoupon).not.toHaveBeenCalled();expect(api.activateChannelCoupon).not.toHaveBeenCalled()
    expect(page.data.coupons[0].status).toBe(status);expect(page.data.notice).toContain('优惠券状态')
  })
  it('opens a WeChat poster scene directly and claims with one tap without invoking in-app scanning',async()=>{
    const {page,api,wx,auth}=harness('channel-coupons')
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.onShow()
    expect(auth.ensureCustomerSession).toHaveBeenCalled();expect(page.data.offer.title).toBe('餐后小聚')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
    await page.claim()
    expect(api.claimChannelCoupon).toHaveBeenCalledExactlyOnceWith('ABCDEFGH2345')
    expect(wx.scanCode).not.toHaveBeenCalled()
  })



  it.each([{allowStacking:false,visitDiscountCapMinor:null,text:'不允许叠加'}, {allowStacking:true,visitDiscountCapMinor:1234,text:'本组顾客本次到店最多优惠 ¥12.34'}, {allowStacking:true,visitDiscountCapMinor:null,text:'本次到店无总额上限'}])('shows stacking policy consistently in landing and wallet: %j',async config=>{
    const {page,api}=harness('channel-coupons'),offer={kind:'credit',amountMinor:1000}
    api.getChannelOffer.mockResolvedValue({...config,title:'配置券',offer,unavailable:null} as never)
    api.getChannelWallet.mockResolvedValue([{...config,id:'policy-coupon',offer,status:'available'}] as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.load()
    expect(page.data.offer.stackingText).toContain(config.text);expect(page.data.coupons[0].stackingText).toContain(config.text)
  })
  it('displays 85-percent-payable coupon as 15-percent reduction in preview and member wallet',async()=>{
    const {page,api}=harness('channel-coupons')
    const offer={kind:'discount',discountBps:1500,maximumMinor:2000}
    api.getChannelOffer.mockResolvedValue({title:'八五折',offer,minimumMinor:10000,claimedCount:0,unavailable:null} as never)
    api.getChannelWallet.mockResolvedValue([{id:'discount-coupon',offer,status:'available'}] as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.load()
    expect(page.data.offer.offerText).toBe('优惠 15%，最多 ¥20.00')
    expect(page.data.coupons[0].offerText).toBe('优惠 15%，最多 ¥20.00')
  })
  it.each(['hide','account','manual-input'])('ignores a delayed native scan after %s changes the current operation',async change=>{
    const {page,api,wx,changeOwner}=harness('channel-coupons')
    page.data.code='ORIGINAL';page.scan()
    if(change==='hide')page.onHide()
    if(change==='account')changeOwner()
    if(change==='manual-input')page.inputCode({detail:{value:'NEWINPUT'}})
    const expected=page.data.code
    wx.scanCode.mock.calls[0]![0].success({result:'MBOX_CHANNEL_V1:ABCDEFGH23456789'})
    await Promise.resolve();await Promise.resolve()
    expect(page.data.code).toBe(expected)
    expect(api.getChannelOffer).not.toHaveBeenCalled()
  })
  it('leaves the current input intact when native scanning is cancelled',()=>{
    const {page,wx,api}=harness('channel-coupons');page.data.code='ABCDEFGH';page.scan()
    wx.scanCode.mock.calls[0]![0].fail({errMsg:'scanCode:fail cancel'})
    expect(page.data.code).toBe('ABCDEFGH');expect(page.data.error).toBe('')
    expect(api.getChannelOffer).not.toHaveBeenCalled()
  })
  it('ignores an older scanner failure after a newer scan starts',()=>{
    const {page,wx}=harness('channel-coupons');page.scan();page.scan()
    wx.scanCode.mock.calls[0]![0].fail({errMsg:'scanCode:fail camera'})
    expect(page.data.error).toBe('')
    wx.scanCode.mock.calls[1]![0].fail({errMsg:'scanCode:fail camera'})
    expect(page.data.error).toContain('未识别')
  })
  it('opens a QR scene without claiming or marking arrival automatically', () => {
    const { page, api } = harness('channel-coupons')
    page.onLoad({ scene: 'MBOX_CHANNEL_V1%3AABCDEFGH23456789' })
    expect(page.data.code).toBe('ABCDEFGH23456789')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
    expect(api.activateChannelCoupon).not.toHaveBeenCalled()
  })
  it('accepts image scanning and numbers but needs an explicit claim', () => {
    const { page, api, wx } = harness('channel-coupons')
    page.scan()
    const scan = wx.scanCode.mock.calls[0]![0] as any
    expect(scan.onlyFromCamera).toBe(false)
    scan.success({ result: 'MBOX_CHANNEL_V1:ABCD2345EFGH6789' })
    expect(page.data.code).toBe('ABCD2345EFGH6789')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('rejects using a personal coupon without a current table scan', async () => {
    const { page, api, wx, openCoupon } = harness('channel-coupons')
    await openCoupon('claim')
    wx.scanCode.mockImplementationOnce(options=>options.success({path:'pages/channel-coupons/index'}))
    await page.useCoupon({ currentTarget: { dataset: { id: 'claim' } } })
    expect(api.activateChannelCoupon).not.toHaveBeenCalled()
    expect(page.data.error).toContain('桌码')
  })
  it('submits only the personal coupon ID for activation, never a client-selected source or amount', async () => {
    const { page, api, table, openCoupon } = harness('channel-coupons'); table.tableToken = 'verified-in-server'; table.cartScope='visit-a'; await openCoupon('claim')
    await page.useCoupon({ currentTarget: { dataset: { id: 'claim' } } })
    expect(api.activateChannelCoupon).toHaveBeenCalledExactlyOnceWith('claim', false, expect.any(Function))
  })
  it('ignores a previous account wallet response', async () => {
    const { page, api, changeOwner } = harness('channel-coupons')
    let complete!: (value: never[]) => void
    api.getChannelWallet.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const load = page.load(); await vi.waitFor(() => expect(complete).toBeTypeOf('function')); changeOwner(); complete([]); await load
    expect(page.data.coupons).toEqual([])
    expect(page.data.notice).toBe('')
  })
  it('prevents double tap from issuing a second claim while the first result is unknown', async () => {
    const { page, api } = harness('channel-coupons'); page.data.code = 'ABCDEFGH'; page.data.offer = { unavailable: null }
    let complete!: (value: { claimId: string }) => void
    api.claimChannelCoupon.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const first = page.claim(); await page.claim(); expect(api.claimChannelCoupon).toHaveBeenCalledTimes(1)
    complete({ claimId: 'once' }); await first
    expect(page.data.busy).toBe(false)
  })
  it('loads the exact official scene and needs only one explicit claim tap', async () => {
    const {page,api}=harness('channel-coupons')
    page.onLoad({scene:'CH_ABCDEFGH2345'}); await page.load()
    expect(api.getChannelOffer).toHaveBeenCalledWith('ABCDEFGH2345')
    expect(page.data.offer.title).toBe('餐后小聚')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
    await page.claim(); expect(api.claimChannelCoupon).toHaveBeenCalledExactlyOnceWith('ABCDEFGH2345')
  })
  it('supports the official scan path and refuses a table-code path', async () => {
    const {page,wx,api}=harness('channel-coupons'); page.scan()
    const scan=wx.scanCode.mock.calls[0]![0] as any
    scan.success({path:'pages/channel-coupons/index?scene=CH_ABCDEFGH2345'})
    await Promise.resolve(); await Promise.resolve()
    expect(page.data.code).toBe('ABCDEFGH2345')
    page.scan()
    ;(wx.scanCode.mock.calls[1]![0] as any).success({path:'pages/order/index?scene=CH_ABCDEFGH2345'})
    expect(page.data.error).toContain('不是推荐优惠码')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('preserves the offer through explicit login without claiming or undoing logout', async () => {
    const {page,auth,gate,api,logout}=harness('channel-coupons'); logout()
    page.onLoad({scene:'CH_ABCDEFGH2345'}); await page.load(); await page.claim()
    expect(auth.ensureCustomerSession).not.toHaveBeenCalled()
    expect(gate.redirectToMembershipLogin).toHaveBeenCalledExactlyOnceWith('/pages/channel-coupons/index?code=ABCDEFGH2345')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('accepts cold-start identity initialization before reading the personal wallet', async () => {
    const {page,auth,changeOwner}=harness('channel-coupons')
    auth.ensureCustomerSession.mockImplementation(async()=>{changeOwner();return true})
    page.onLoad({scene:'CH_ABCDEFGH2345'}); await page.load()
    expect(page.data.offer.title).toBe('餐后小聚')
    expect(page.data.loading).toBe(false)
  })
  it('does not claim again on reopening an already claimed offer', async () => {
    const {page,api}=harness('channel-coupons')
    api.getChannelOffer.mockResolvedValue({offer:{kind:'credit',amountMinor:1000},existingClaimId:'mine',unavailable:'您已达到本批次领取上限'} as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'}); await page.load(); await page.load(); await page.claim()
    expect(page.data.offer.existingClaimId).toBe('mine')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('previews a manually entered code before allowing a claim', async () => {
    const {page,api}=harness('channel-coupons'); page.inputCode({detail:{value:'ABCDEFGH2345'}})
    await page.claim(); expect(api.claimChannelCoupon).not.toHaveBeenCalled()
    await page.claim(); expect(api.claimChannelCoupon).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed scenes and never starts an automatic claim', async () => {
    const {page,api}=harness('channel-coupons'); page.onLoad({scene:'%E0%A4%A'})
    expect(page.data.error).toContain('格式不正确'); expect(page.data.code).toBe('')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('ignores a result if the page closes during login initialization', async () => {
    const {page,api,auth}=harness('channel-coupons'); let complete!:()=>void
    auth.ensureCustomerSession.mockImplementation(()=>new Promise(resolve=>{complete=()=>resolve(true)}))
    page.onLoad({scene:'CH_ABCDEFGH2345'}); const pending=page.load(); page.onHide(); complete(); await pending
    expect(api.getChannelWallet).not.toHaveBeenCalled()
  })
  it('replaces an old offer on a new warm-launch scan, then consumes that launch only once', async () => {
    const {page,api,app}=harness('channel-coupons'); page.onLoad({scene:'CH_ABCDEFGH2345'}); await page.load()
    app.globalData.channelOfferLaunch={scene:'CH_ZYXWVUTS6789'}; await page.onShow()
    expect(page.data.code).toBe('ZYXWVUTS6789'); expect(app.globalData.channelOfferLaunch).toBeNull()
    expect(api.getChannelOffer).toHaveBeenLastCalledWith('ZYXWVUTS6789')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('keeps malformed launch feedback visible after the wallet has loaded', async () => {
    const {page}=harness('channel-coupons'); page.onLoad({scene:'%E0%A4%A'}); await page.load()
    expect(page.data.error).toContain('格式不正确')
  })
  it('keeps an older targeted coupon directly usable even when absent from the first wallet page',async()=>{
    const {page,api,table}=harness('channel-coupons');table.tableToken='verified';table.cartScope='visit-a'
    api.getChannelOffer.mockResolvedValue({title:'旧券',offer:{kind:'credit',amountMinor:1000},existingClaimId:'old',unavailable:'已领取',existingCoupon:{id:'old',status:'available',offer:{kind:'gift',productName:'替换赠品',quantity:1},eligibleProducts:[],minimumMinor:0}} as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.load()
    expect(page.data.coupons).toEqual([]);expect(page.data.offer.existingCoupon.offerText).toContain('替换赠品')
    await page.useCoupon({currentTarget:{dataset:{id:page.data.offer.existingCoupon.id}}})
    expect(api.activateChannelCoupon).toHaveBeenCalledExactlyOnceWith('old', false, expect.any(Function));expect(api.claimChannelCoupon).not.toHaveBeenCalled()
  })
  it('appends wallet pages without duplicates and keeps the cursor when a read fails',async()=>{
    const {page,api}=harness('channel-coupons'), item=(id:string)=>({id,offer:{kind:'credit',amountMinor:100}})
    api.getChannelWalletPage.mockResolvedValueOnce({items:[item('a')],nextCursor:'cursor-a'})
    await page.load();api.getChannelWalletPage.mockRejectedValueOnce(new Error('network'))
    await page.loadMore();expect(page.data.nextCursor).toBe('cursor-a');expect(page.data.coupons).toHaveLength(1)
    api.getChannelWalletPage.mockResolvedValueOnce({items:[item('a'),item('b')],nextCursor:null})
    await page.loadMore();expect(page.data.coupons.map((v:any)=>v.id)).toEqual(['a','b']);expect(page.data.nextCursor).toBeNull()
  })
  it('drops an old wallet page when the status filter changes mid-request',async()=>{
    const {page,api}=harness('channel-coupons');api.getChannelWalletPage.mockResolvedValueOnce({items:[],nextCursor:'cursor-a'})
    await page.load();let resolve!:(v:any)=>void
    api.getChannelWalletPage.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
    const pending=page.loadMore();await page.filterChanged({detail:{value:'1'}})
    resolve({items:[{id:'stale',offer:{kind:'credit',amountMinor:100}}],nextCursor:null});await pending
    expect(page.data.coupons).toEqual([]);expect(api.getChannelWalletPage).toHaveBeenLastCalledWith({status:'available'})
  })
  it('does not append another account’s wallet page after an account change',async()=>{
    const {page,api,changeOwner}=harness('channel-coupons');api.getChannelWalletPage.mockResolvedValueOnce({items:[],nextCursor:'cursor-a'})
    await page.load();let resolve!:(v:any)=>void
    api.getChannelWalletPage.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
    const pending=page.loadMore();changeOwner();resolve({items:[{id:'stale',offer:{kind:'credit',amountMinor:100}}],nextCursor:null});await pending
    expect(page.data.coupons).toEqual([])
  })
})

function checkoutHarness() {
  const module = { exports: {} as any }
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/checkout-coupons.js', import.meta.url), 'utf8'), { module, Date, require: (name: string) => { if (name === './format') return dateModule.exports; throw new Error(name) } })
  let owner = 'guest-a'
  const quoteChannel = vi.fn(), getPoints = vi.fn(async () => ({ availablePoints: 20, minorPerPoint: 100, allowCoupons: false }))
  const page = { data: { ...structuredClone(module.exports.initialCheckoutCoupons), cart: [], cartGeneration: 1, cartVersion: 2, checkoutConfirmVisible: true, busy: false },
    setData(value: object) { Object.assign(this.data, value) }, ...module.exports.checkoutCouponMethods({ quoteChannel, getPoints, money: String, scope: () => owner, errorMessage: (e: Error) => e.message }) }
  const quote = () => ({ id: 'q', sourceType: 'channel_quote', current: true, generation: 1, version: 2, currency: 'CNY', subtotalMinor: 1000, discountMinor: 100, payableMinor: 900, expiresAt: new Date(Date.now() + 60000).toISOString() })
  return { page, quoteChannel, quote, changeOwner: () => { owner = 'guest-b' } }
}
describe('channel checkout quote safety', () => {
  it('discards delayed channel prices after identity or cart changes', async () => {
    for (const changed of ['owner', 'cart']) {
      const h = checkoutHarness(); let finish!: (value: unknown) => void
      h.quoteChannel.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      const pending = h.page.quoteCheckoutChannel()
      if (changed === 'owner') h.changeOwner(); else { h.page.data.cartVersion++; h.page.invalidateCheckoutCoupons(false, true) }
      finish(h.quote()); await pending; expect(h.page.data.couponQuote).toBeNull()
    }
  })
  it('requires a fresh channel quote when it expires and permits an explicit full-price choice', async () => {
    const h = checkoutHarness(); h.quoteChannel.mockResolvedValue(h.quote()); await h.page.quoteCheckoutChannel()
    expect(h.page.couponCheckoutReady()).toBe(true)
    h.page.data.couponQuote.expiresAt = new Date(Date.now() - 1).toISOString()
    expect(h.page.couponCheckoutReady()).toBe(false)
    h.page.skipCheckoutCoupons(); expect(h.page.couponCheckoutReady()).toBe(true)
  })
  it('clears point selections on channel pricing and retains the channel quote while browsing points', async () => {
    const h = checkoutHarness(); h.page.data.pointsInput = '10'; h.page.data.couponSelections = [{ benefitId: 'member' }]
    h.quoteChannel.mockResolvedValue(h.quote()); await h.page.quoteCheckoutChannel()
    expect(h.page.data.pointsInput).toBe(''); expect(h.page.data.couponSelections).toEqual([])
    const channelQuote=h.page.data.couponQuote; await h.page.openCheckoutPoints(); expect(h.page.data.couponQuote).toEqual(channelQuote); expect(h.page.data.pointsPickerOpen).toBe(true)
  })
})


describe('channel login destination whitelist', () => {
  function gate() {
    const storage=new Map(), module={exports:{} as any}, wx={getStorageSync:(key:string)=>storage.get(key), setStorageSync:(key:string,value:unknown)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key),switchTab:vi.fn()}
    vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/membership-gate.js',import.meta.url),'utf8'),{module,wx,require:()=>({})})
    return module.exports
  }
  it('returns to the same coupon after login and consumes the destination once',()=>{
    const helper=gate(); helper.redirectToMembershipLogin('/pages/channel-coupons/index?code=ABCDEFGH2345')
    expect(helper.consumeMembershipLoginDestination()).toBe('/pages/channel-coupons/index?code=ABCDEFGH2345')
    expect(helper.consumeMembershipLoginDestination()).toBeNull()
  })
  it.each(['https://evil.invalid','/pages/order/index?tableToken=forged','/pages/channel-coupons/index?code=ABCDEFGH2345&customerId=other'])('rejects a forged login destination %s',destination=>{
    const helper=gate(); helper.redirectToMembershipLogin(destination); expect(helper.consumeMembershipLoginDestination()).toBeNull()
  })
})
