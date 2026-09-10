import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const empty = () => ({ projects: [], cards: [], applications: [], activeMember: true })
const project = { id: 'fans', name: '五迷卡', version: 1, accepting_applications: true, available_until: '2026-10-01T00:00:00Z' }
const event = (id, action) => ({ currentTarget: { dataset: { id, action } } })
async function harness(platform, read, write = async () => ({}), readGifts = async () => ({items:[],nextCursor:null})) {
  let page, modal
  const runtime = { showModal(input) { modal = input }, switchTab() {} }
  vm.runInNewContext(await readFile(new URL('../' + platform + '/pages/profile-cards/index.js', import.meta.url), 'utf8'), {
    wx: runtime,
    Page(value) { page = value; page.setData = value => Object.assign(page.data, value) },
    require(name) {
      if (name.endsWith('/platform')) return runtime
      if (name.endsWith('/api')) return { getMemberCards: read, submitMemberCardAction: write, getMemberGiftJobs:readGifts }
      if (name.endsWith('/format')) return { dateInput: value => value }
      return { customerErrorMessage: (_, fallback) => fallback }
    },
  })
  return { page, modal: () => modal }
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(platform + ': gift progress failure does not clear cards or invent an empty successful gift history',async()=>{
    const {page}=await harness(platform,async()=>({...empty(),cards:[{id:'card',status:'active'}]}),undefined,async()=>{throw new Error('timeout')})
    await page.load();await page.loadGifts()
    assert.equal(page.data.cards.length,1);assert.equal(page.data.giftLoaded,false);assert.ok(page.data.giftError)
  })
  test(platform + ': gift history is paginated, retryable, deduplicated and stale responses ignored',async()=>{
    let calls=0,release
    const {page}=await harness(platform,empty,undefined,async cursor=>{
      calls++;if(calls===1)return{items:[{id:'a',status:'blocked'}],nextCursor:'next'}
      if(calls===2)throw new Error('network')
      if(calls===3)return{items:[{id:'a',status:'blocked'},{id:'b',status:'issued'}],nextCursor:null}
      return new Promise(resolve=>{release=resolve})
    })
    await page.loadGifts();assert.equal(page.data.giftJobs[0].stateText,'待员工核对补发')
    const more={currentTarget:{dataset:{more:true}}}
    await page.loadGifts(more);assert.equal(page.data.giftCursor,'next');assert.equal(page.data.giftJobs.length,1)
    await page.loadGifts(more);assert.equal(page.data.giftJobs.length,2);assert.equal(page.data.giftCursor,null)
    const pending=page.loadGifts();page.onHide();release({items:[{id:'stale',status:'issued'}],nextCursor:null});await pending
    assert.equal(page.data.giftJobs.length,0);assert.equal(page.data.giftLoaded,false)
  })
  test(platform + ': failed identity read stays unknown rather than claiming no membership or cards',async()=>{
    const {page}=await harness(platform,async()=>{throw new Error('service unavailable')})
    await page.load();assert.equal(page.data.loaded,false);assert.ok(page.data.error)
    const template=await readFile(new URL('../'+platform+'/pages/profile-cards/index.'+(platform==='miniprogram'?'wxml':'axml'),import.meta.url),'utf8')
    assert.match(template,/:elif="\{\{loaded\}\}"/)
    assert.match(template,/url="\/pages\/profile-contact\/index"/)
    assert.match(template,/url="\/pages\/profile-marketing\/index"/)
  })
  test(platform + ': pagination failure preserves rows and cursor, retry deduplicates', async () => {
    let count=0
    const {page}=await harness(platform,async cursors=>{
      if(!cursors)return {...empty(),cards:[{id:'first',status:'active',project_id:'fans'}],nextCursors:{cards:'next'}}
      count++;if(count===1)throw new Error('timeout')
      return {...empty(),cards:[{id:'first',status:'active',project_id:'fans'},{id:'second',status:'withdrawn',project_id:'old'}],nextCursors:{cards:null}}
    })
    await page.load()
    const more={currentTarget:{dataset:{kind:'cards'}}}
    await page.loadMore(more)
    assert.equal(page.data.cards.length,1);assert.equal(page.data.nextCursors.cards,'next');assert.ok(page.data.error)
    await page.loadMore(more)
    assert.equal(page.data.cards.length,2);assert.equal(page.data.nextCursors.cards,null);assert.equal(page.data.error,'')
  })
  test(platform + ': server pending and held flags prevent duplicate entry outside loaded history',async()=>{
    const {page}=await harness(platform,async()=>({...empty(),projects:[{...project,has_pending_application:true}]}))
    await page.load();page.openProject(event('fans'))
    assert.equal(page.data.selectedProject,null);assert.equal(page.data.projects[0].buttonText,'审核中')
  })
  test(platform + ': explicit terms acceptance only, no implicit marketing or grade mutation', async () => {
    const calls = []
    const { page } = await harness(platform, async () => ({ ...empty(), projects: [project] }), async (...args) => { calls.push(args) })
    await page.load(); page.openProject(event('fans'))
    assert.equal(page.data.acknowledged, false)
    await page.apply(); assert.equal(calls.length, 0)
    page.acknowledge({ detail: { value: ['agree'] } }); await page.apply()
    assert.equal(calls.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['apply', 'fans', { projectId: 'fans', acceptedProjectVersion: 1 }])
    assert.equal(page.data.acknowledged, false)
  })
  test(platform + ': pending, held and nonmembers cannot open a new application', async () => {
    for (const data of [
      { ...empty(), applications: [{ id: 'application', project_id: 'fans', status: 'pending' }] },
      { ...empty(), cards: [{ id: 'card', project_id: 'fans', status: 'suspended', expired: false }] },
      { ...empty(), activeMember: false },
    ]) {
      const { page } = await harness(platform, async () => ({ ...data, projects: [project] }))
      await page.load(); page.openProject(event('fans'))
      assert.equal(page.data.selectedProject, null)
    }
  })
  test(platform + ': unknown result allows explicit recovery without pretending success', async () => {
    const { page } = await harness(platform, async () => ({ ...empty(), projects: [project] }), async () => { throw new Error('timeout') })
    await page.load(); page.openProject(event('fans')); page.acknowledge({ detail: { value: ['agree'] } })
    await page.apply()
    assert.equal(page.data.busy, false); assert.match(page.data.error, /未确认/)
    assert.equal(page.data.message, '')
  })
  test(platform + ': hidden page ignores late reads and clears previous identity data', async () => {
    let resolve
    const { page } = await harness(platform, () => new Promise(r => { resolve = r }))
    const pending = page.load(); page.onHide(); resolve({ ...empty(), projects: [project] }); await pending
    assert.equal(page.data.projects.length, 0)
    page.data.cards = [{ id: 'old-account' }]
    const fresh = page.load(); assert.equal(page.data.cards.length, 0); resolve(empty()); await fresh
  })
  test(platform + ': old confirmation cannot withdraw after navigation', async () => {
    let calls = 0
    const { page, modal } = await harness(platform, async () => empty(), async () => { calls++ })
    await page.load()
    const pending = page.withdraw(event('card', 'withdraw-card'))
    page.onHide(); await page.load(); modal().success({ confirm: true }); await pending
    assert.equal(calls, 0)
  })
  test(platform + ': double tap during submission does not send a second command', async () => {
    let calls = 0, resolve
    const { page } = await harness(platform, async () => ({ ...empty(), projects: [project] }), () => { calls++; return new Promise(r => { resolve = r }) })
    await page.load(); page.openProject(event('fans')); page.acknowledge({ detail: { value: ['agree'] } })
    const first = page.apply(); await page.apply(); assert.equal(calls, 1)
    resolve({}); await first; assert.equal(page.data.busy, false)
  })
}
