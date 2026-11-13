import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function harness(name: string) {
  let definition: any, owner = 'customer-a', loggedOut = false
  const table: { tableToken?: string } = {}
  const api = { getChannelStatement:vi.fn(async (_id:string)=>({statement:{id:_id},lines:[]})), respondChannelStatement:vi.fn(async (_id:string,_dispute:boolean,_reason:string)=>({})), getChannelWalletPage:vi.fn(async (_options?:unknown)=>({items:[] as any[],nextCursor:null as string|null})), getChannelHistory:vi.fn(async (_kind:string,_cursor?:string)=>({items:[] as any[],nextCursor:null as string|null})), getChannelOffer: vi.fn(async (_code: string) => ({ title: '餐后小聚', offer: {kind: 'credit', amountMinor: 1000}, minimumMinor:10000, useFrom:'2026-11-12T00:00:00Z', useUntil:'2026-11-13T00:00:00Z', claimedCount:0, unavailable:null })), getChannelWallet: vi.fn(async () => []), claimChannelCoupon: vi.fn(async (_code: string) => ({ claimId: 'claim-a' })),
    activateChannelCoupon: vi.fn(async (_id: string) => ({ activationId: 'active-a' })), getChannelPartner: vi.fn(async () => ({ promoter: { name: '店长' }, batches: [], visits: [] })),
    acceptChannelInvitation: vi.fn(async (_token: string) => ({})), getChannelPoster: vi.fn(async (_id: string) => ({ filename: 'poster.png', base64: 'PNG' })) }
  api.getChannelWalletPage.mockImplementation(async()=>({items:await api.getChannelWallet(),nextCursor:null}))
  const fs = { writeFile: vi.fn((o: any) => o.success()), unlink: vi.fn() }
  const wx = { showModal:vi.fn((_options:any)=>{}), scanCode: vi.fn(), env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => fs, saveImageToPhotosAlbum: vi.fn((o: any) => o.success()) }
  const auth = { ensureCustomerSession: vi.fn(async () => true), isMembershipLoggedOut: () => loggedOut }
  const gate = { redirectToMembershipLogin: vi.fn() }
  const app = {globalData: {channelOfferLaunch: null as any}}
  const entryModule = {exports:{}}
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/channel-entry.js', import.meta.url), 'utf8'), {module:entryModule})
  const dependencies: Record<string, unknown> = {
    '../../utils/auth':auth, '../../utils/membership-gate':gate, '../../utils/channel-entry':entryModule.exports,
    '../../utils/api': api, '../../utils/recoverable-command': { commandIdentityScope: () => owner },
    '../../utils/customer-error': { customerErrorMessage: (e: any, fallback: string) => e.message || fallback }, '../../utils/session': { getTableSession: () => table },
  }
  vm.runInNewContext(readFileSync(new URL(`../../miniprogram/pages/${name}/index.js`, import.meta.url), 'utf8'), {
    require: (path: string) => { if (!(path in dependencies)) throw new Error(`Unexpected dependency ${path}`); return dependencies[path] },
    Page: (value: unknown) => { definition = value }, wx, getApp:()=>app,
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(value: object) { Object.assign(this.data, value) } }
  return { page, api, wx, fs, table, auth, gate, app, logout: () => {loggedOut=true}, changeOwner: () => { owner = 'customer-b' } }
}

describe('channel mini program identity and action boundaries', () => {
  it('opens a WeChat poster scene directly and claims with one tap without invoking in-app scanning',async()=>{
    const {page,api,wx,auth}=harness('channel-coupons')
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.onShow()
    expect(auth.ensureCustomerSession).toHaveBeenCalled();expect(page.data.offer.title).toBe('餐后小聚')
    expect(api.claimChannelCoupon).not.toHaveBeenCalled()
    await page.claim()
    expect(api.claimChannelCoupon).toHaveBeenCalledExactlyOnceWith('ABCDEFGH2345')
    expect(wx.scanCode).not.toHaveBeenCalled()
  })



  it.each([{allowStacking:false,visitDiscountCapMinor:null,text:'不允许叠加'}, {allowStacking:true,visitDiscountCapMinor:1234,text:'客组总优惠最高 ¥12.34'}, {allowStacking:true,visitDiscountCapMinor:null,text:'未设置客组总上限'}])('shows stacking policy consistently in landing and wallet: %j',async config=>{
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
    const { page, api } = harness('channel-coupons')
    await page.useCoupon({ currentTarget: { dataset: { id: 'claim' } } })
    expect(api.activateChannelCoupon).not.toHaveBeenCalled()
    expect(page.data.error).toContain('桌码')
  })
  it('submits only the personal coupon ID for activation, never a client-selected source or amount', async () => {
    const { page, api, table } = harness('channel-coupons'); table.tableToken = 'verified-in-server'
    await page.useCoupon({ currentTarget: { dataset: { id: 'claim' } } })
    expect(api.activateChannelCoupon).toHaveBeenCalledExactlyOnceWith('claim')
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
    const {page,api,table}=harness('channel-coupons');table.tableToken='verified'
    api.getChannelOffer.mockResolvedValue({title:'旧券',offer:{kind:'credit',amountMinor:1000},existingClaimId:'old',unavailable:'已领取',existingCoupon:{id:'old',status:'available',offer:{kind:'gift',productName:'替换赠品',quantity:1},eligibleProducts:[],minimumMinor:0}} as never)
    page.onLoad({scene:'CH_ABCDEFGH2345'});await page.load()
    expect(page.data.coupons).toEqual([]);expect(page.data.offer.existingCoupon.offerText).toContain('替换赠品')
    await page.useCoupon({currentTarget:{dataset:{id:page.data.offer.existingCoupon.id}}})
    expect(api.activateChannelCoupon).toHaveBeenCalledExactlyOnceWith('old');expect(api.claimChannelCoupon).not.toHaveBeenCalled()
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
  vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/checkout-coupons.js', import.meta.url), 'utf8'), { module, Date })
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
  it('clears member and point choices on channel pricing and clears channel pricing for points', async () => {
    const h = checkoutHarness(); h.page.data.pointsInput = '10'; h.page.data.couponSelections = [{ benefitId: 'member' }]
    h.quoteChannel.mockResolvedValue(h.quote()); await h.page.quoteCheckoutChannel()
    expect(h.page.data.pointsInput).toBe(''); expect(h.page.data.couponSelections).toEqual([])
    await h.page.openCheckoutPoints(); expect(h.page.data.couponQuote).toBeNull(); expect(h.page.data.pointsPickerOpen).toBe(true)
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
