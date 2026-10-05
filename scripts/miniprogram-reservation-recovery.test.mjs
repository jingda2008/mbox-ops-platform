import assert from 'node:assert/strict'
import test from 'node:test'
import { liveMiniHarness } from './miniprogram-live-contract-harness.mjs'

const input = { customerName: '测试顾客', contact: 'test-contact', partySize: 2, scheduledAt: '2026-10-10T12:00:00.000Z', seatPreference: 'quiet_chat', note: '靠窗', reservationPolicyVersion: 1, preferredScheduleId: null }
function fixture(platform, options = {}) {
  const rows = new Map(), keys = new Map(); let createCount = 0
  const controls = { loseFirstResponse: true, commitFirst: true, getFailure: false, reject: null, profileFailure: false, beforePost: null }
  const h = liveMiniHarness(platform, async (call, context) => {
    if (call.path === '/api/public/mini/customer/profile') return controls.profileFailure ? { status: 503, data: { error: { code: 'HTTP_ERROR', message: '读取失败' } } } : { data: { data: { publicId: context.state.customerPublicId } } }
    if (call.path === '/api/public/reservations/mine') return { data: { data: { reservations: [...rows.values()] } } }
    if (call.path === '/api/public/reservation/availability') return { data: { data: { acceptingReservations: true, depositRule: { policyVersion: 1 } } } }
    if (call.path.startsWith('/api/public/reservations/') && call.method === 'GET') {
      if (controls.getFailure) return { status: 503, data: { error: { code: 'HTTP_ERROR', message: '读取失败' } } }
      const record = rows.get(decodeURIComponent(call.path.split('/').pop()))
      return record ? { data: { data: record } } : { status: 404, data: { error: { code: 'RESERVATION_NOT_FOUND', message: '找不到原预约' } } }
    }
    if (call.path === '/api/public/reservations' && call.method === 'POST') {
      createCount++; await controls.beforePost?.()
      if (controls.reject) return { status: 409, data: { error: { code: controls.reject, message: '预约规则已经变化' } } }
      const key = call.headers['idempotency-key']
      const result = keys.get(key) || { ...structuredClone(call.data), status: 'pending' }
      if (createCount !== 1 || controls.commitFirst) { keys.set(key, result); rows.set(result.publicId, result) }
      if (createCount === 1 && controls.loseFirstResponse) return { networkError: true }
      return { status: keys.has(key) ? 200 : 201, data: { data: result } }
    }
    return { data: { data: {} } }
  }, options)
  function reservationPage() {
    const p = h.page('reservations', ['completeReservationSubmit', 'recoverReservation', 'reservationSubmissionFailed', 'submitReservation', 'startNewReservation'])
    p.data = { submitting: false, reservationRecoveryReady: true, pendingReservation: null, customerName: input.customerName, contact: input.contact,
      partySize: input.partySize, occasionOptions: [{ code: '', name: '普通到店' }], occasionIndex: 0, occasionNote: input.note,
      performances: [], seatOptions: [{ code: input.seatPreference }], seatIndex: 0 }
    p.arrivalAt = () => input.scheduledAt
    p.preloadWechatSubscriptionPresentationOptions = p.preloadAlipaySubscriptionPresentationOptions = async () => []
    p.loadData = async () => { p.reloads = (p.reloads || 0) + 1; p.data.pendingReservation = await h.api.getPendingCustomerReservation() }
    return p
  }
  return { ...h, controls, rows, keys, reservationPage, posts: () => h.calls.filter(c => c.path === '/api/public/reservations' && c.method === 'POST'), attempts: () => [...h.storage.entries()].filter(([key]) => key.startsWith('mbox.reservation.submission.v1:')) }
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: real request/API/page retains committed reservation after lost response and reopens original`, async () => {
    const f = fixture(platform), p = f.reservationPage()
    await p.completeReservationSubmit()
    assert.equal(f.rows.size, 1); assert.equal(p.data.showForm, false); assert.ok(p.data.pendingReservation)
    assert.equal(f.attempts().length, 1)
    const saved = f.attempts()[0][1]
    assert.equal(saved.payload.contact, input.contact); assert.equal(saved.payload.guestCount, 2)
    assert.ok(saved.scope.includes('customer-a')); assert.ok(saved.scope.includes('audit-store'))
    p.data.customerName = '另外一位'; await p.completeReservationSubmit()
    assert.equal(f.posts().length, 1); assert.equal(f.rows.size, 1); assert.equal(f.attempts().length, 0)
    assert.match(p.data.success, /找回原预约/)
  })
  test(`${platform}: fresh JS runtime restores same payload and key when first transport never committed`, async () => {
    const f = fixture(platform); f.controls.commitFirst = false
    await assert.rejects(f.api.createCustomerReservation(input))
    const original = f.posts()[0]
    const reloaded = fixture(platform, { storage: f.storage }); reloaded.controls.loseFirstResponse = false
    const pending = await reloaded.api.getPendingCustomerReservation(); assert.equal(pending.publicId, original.data.publicId)
    const result = await reloaded.api.recoverCustomerReservation()
    assert.equal(result.publicId, original.data.publicId)
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.posts()[0].data)), JSON.parse(JSON.stringify(original.data)))
    assert.equal(reloaded.posts()[0].headers['idempotency-key'], original.headers['idempotency-key'])
  })
  test(`${platform}: changed form cannot overwrite an unknown original request`, async () => {
    const f = fixture(platform); await assert.rejects(f.api.createCustomerReservation(input))
    const saved = JSON.stringify(f.attempts())
    await assert.rejects(f.api.createCustomerReservation({ ...input, partySize: 3 }), e => e.code === 'RESERVATION_SUBMISSION_PENDING')
    assert.equal(JSON.stringify(f.attempts()), saved); assert.equal(f.posts().length, 1)
  })
  test(`${platform}: failed readback preserves unknown request and never creates another`, async () => {
    const f = fixture(platform); await assert.rejects(f.api.createCustomerReservation(input)); f.controls.getFailure = true
    await assert.rejects(f.api.recoverCustomerReservation()); assert.equal(f.posts().length, 1); assert.equal(f.attempts().length, 1)
  })
  test(`${platform}: identity and store switches never expose or replay another scope's original`, async () => {
    const f = fixture(platform); await assert.rejects(f.api.createCustomerReservation(input))
    f.state.customerPublicId = 'customer-b'; f.storage.set('mbox.http.cookie.reservation.v2', 'mbox_reservation_session=customer-b')
    assert.equal(await f.api.getPendingCustomerReservation(), null); assert.equal(await f.api.recoverCustomerReservation(), null)
    f.state.customerPublicId = 'customer-a'; f.storage.set('mbox.http.cookie.reservation.v2', 'mbox_reservation_session=customer-a'); f.config.storeId = 'other-store'
    assert.equal(await f.api.getPendingCustomerReservation(), null); assert.equal(f.posts().length, 1)
    f.config.storeId = 'audit-store'; assert.ok(await f.api.getPendingCustomerReservation()); assert.equal(f.attempts().length, 1)
  })
  test(`${platform}: late response after identity switch retains old request without reporting new-account success`, async () => {
    const f = fixture(platform); f.controls.loseFirstResponse = false
    f.controls.beforePost = () => { f.state.customerPublicId = 'customer-b'; f.storage.set('mbox.http.cookie.reservation.v2', 'mbox_reservation_session=customer-b') }
    await assert.rejects(f.api.createCustomerReservation(input), e => e.code === 'RESERVATION_SUBMISSION_SCOPE_CHANGED')
    assert.equal(f.attempts().length, 1)
  })
  test(`${platform}: definite rejection permits corrected submission, unknown 409 remains pending`, async () => {
    const f = fixture(platform); f.controls.reject = 'RESERVATION_POLICY_CHANGED'
    await assert.rejects(f.api.createCustomerReservation(input)); assert.equal(f.attempts().length, 0)
    f.controls.reject = 'IDEMPOTENCY_CONFLICT'
    await assert.rejects(f.api.createCustomerReservation(input)); assert.equal(f.attempts().length, 1)
  })
  test(`${platform}: storage failure prevents POST and expired unknown request only queries`, async () => {
    const f = fixture(platform); f.state.storageFailure = true
    await assert.rejects(f.api.createCustomerReservation(input)); assert.equal(f.posts().length, 0)
    f.state.storageFailure = false; f.controls.commitFirst = false; await assert.rejects(f.api.createCustomerReservation(input))
    const [key, attempt] = f.attempts()[0]; attempt.createdAt = Date.now() - 25 * 60 * 60 * 1000; f.storage.set(key, attempt)
    await assert.rejects(f.api.recoverCustomerReservation(), e => e.code === 'RESERVATION_SUBMISSION_EXPIRED')
    assert.equal(f.posts().length, 1); assert.equal(f.attempts().length, 1)
  })
  test(`${platform}: expired committed request can still be read back without a POST`, async () => {
    const f = fixture(platform); await assert.rejects(f.api.createCustomerReservation(input))
    const [key, attempt] = f.attempts()[0]; attempt.createdAt = Date.now() - 25 * 60 * 60 * 1000; f.storage.set(key, attempt)
    const result = await f.api.recoverCustomerReservation(); assert.equal(result.publicId, attempt.payload.publicId)
    assert.equal(f.posts().length, 1); assert.equal(f.attempts().length, 0)
  })
}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: reopened reservation page blocks new form until original request is recovered`, async () => {
    const f = fixture(platform); await assert.rejects(f.api.createCustomerReservation(input))
    const p = f.page('reservations', ['loadData', 'startNewReservation'], {
      STATUS_NAMES: { pending: '等待门店确认' }, EXECUTABLE_RESERVATION_STATUSES: new Set(['pending', 'confirmed']),
      impactView: v => v, dateTime: String,
    })
    p.data = { seatOptions: [{ code: 'quiet_chat', name: '聊天' }], reservations: [], showForm: true }
    p.preloadWechatSubscriptionPresentationOptions = p.preloadAlipaySubscriptionPresentationOptions = async () => []
    p.checkAvailability = p.loadPerformances = async () => {}
    await p.loadData()
    assert.equal(p.data.loading, false); assert.equal(p.data.reservationRecoveryReady, true)
    assert.ok(p.data.pendingReservation); assert.equal(p.data.showForm, false)
    p.startNewReservation(); assert.equal(p.data.showForm, false)
    f.controls.profileFailure = true; await p.loadData()
    assert.equal(p.data.reservationRecoveryReady, false); assert.equal(p.data.pendingReservation, null)
    p.startNewReservation(); assert.equal(p.data.showForm, false); assert.equal(f.posts().length, 1)
  })
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) test(`${platform}: concurrent submission coalesces before profile read and cannot switch payload`, async () => {
  const f = fixture(platform); f.controls.loseFirstResponse = false
  const first = f.api.createCustomerReservation(input)
  const second = f.api.createCustomerReservation(input)
  await assert.rejects(f.api.createCustomerReservation({ ...input, partySize: 3 }), e => e.code === 'RESERVATION_SUBMISSION_PENDING')
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.publicId, b.publicId); assert.equal(f.posts().length, 1)
  assert.equal(f.calls.filter(c => c.path === '/api/public/mini/customer/profile').length, 1)
})
