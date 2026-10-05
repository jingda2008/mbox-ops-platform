const runtime = require('./platform')
const { getRuntimeConfig } = require('../config/index')
const { request } = require('./request')
const { ensureCustomerSession, isCustomerSessionInvalid, renewReservationSessionOnly } = require('./auth')
const { randomId } = require('./id')

const flights = new Map()
const creations = new Map()
const STORAGE_PREFIX = 'mbox.reservation.submission.v1:'
// The server's ordinary command receipts expire after 24 hours. Older unknown
// attempts may be read back, but must never become a fresh booking on replay.
const SAFE_REPLAY_MS = 23 * 60 * 60 * 1000
const DEFINITE_REJECTIONS = new Set([
  'PUBLIC_RESERVATION_REQUEST_INVALID', 'RESERVATION_POLICY_CHANGED',
  'RESERVATION_CAPACITY_FULL', 'TABLE_ALREADY_RESERVED', 'RESERVATION_HOLD_EXPIRED',
])

function failure(code, message) { return Object.assign(new Error(message), { code }) }
function configuredScope() {
  const config = getRuntimeConfig()
  return JSON.stringify([config.apiBaseUrl, config.storeId])
}
function sessionCredential() { return runtime.getStorageSync('mbox.http.cookie.reservation.v2') || '' }
function assertCurrent(context) {
  if (configuredScope() !== context.configuration || sessionCredential() !== context.credential) {
    throw failure('RESERVATION_SUBMISSION_SCOPE_CHANGED', '预约身份或门店已变化，请重新读取本人预约；原请求已保留。')
  }
}
async function currentContext() {
  const requestedConfiguration = configuredScope()
  await ensureCustomerSession(false)
  if (!sessionCredential()) await ensureCustomerSession(true)
  if (requestedConfiguration !== configuredScope() || !sessionCredential()) {
    throw failure('RESERVATION_SUBMISSION_SCOPE_CHANGED', '预约身份或门店已变化，请重新读取本人预约；原请求已保留。')
  }
  for (let turn = 0; turn < 2; turn += 1) {
    const configuration = configuredScope(), credential = sessionCredential()
    try {
      const response = await request('/api/public/mini/customer/profile', { requireTableSession: false })
      const context = { configuration, credential }
      assertCurrent(context)
      const customerPublicId = response && response.data && response.data.publicId
      if (typeof customerPublicId !== 'string' || !customerPublicId || customerPublicId.length > 128) {
        throw failure('RESERVATION_SUBMISSION_IDENTITY_UNCONFIRMED', '暂时无法核对本人预约身份，请重新读取后再试。')
      }
      context.scope = JSON.stringify([configuration, customerPublicId])
      context.storageKey = STORAGE_PREFIX + encodeURIComponent(context.scope)
      return context
    } catch (error) {
      if (turn || !isCustomerSessionInvalid(error)) throw error
      renewReservationSessionOnly()
      await ensureCustomerSession(true)
    }
  }
}
function readAttempt(context) {
  assertCurrent(context)
  const attempt = runtime.getStorageSync(context.storageKey)
  if (!attempt) return null
  if (attempt.version !== 1 || attempt.scope !== context.scope || !attempt.payload
    || typeof attempt.payload.publicId !== 'string' || !attempt.payload.publicId.startsWith('reservation-')
    || typeof attempt.key !== 'string' || attempt.key.length < 8
    || !Number.isFinite(attempt.createdAt)
    || attempt.payload.mode !== 'direct'
    || typeof attempt.payload.customerName !== 'string' || typeof attempt.payload.contact !== 'string'
    || !Number.isSafeInteger(attempt.payload.guestCount) || attempt.payload.guestCount < 1
    || !Number.isSafeInteger(attempt.payload.reservationPolicyVersion)
    || typeof attempt.payload.arrivalAt !== 'string' || !Number.isFinite(Date.parse(attempt.payload.arrivalAt))
    || typeof attempt.payload.seatPreference !== 'string'
    || !(attempt.payload.note === null || typeof attempt.payload.note === 'string')
    || !(attempt.payload.preferredScheduleId === null || typeof attempt.payload.preferredScheduleId === 'string')) {
    throw failure('RESERVATION_SUBMISSION_RECORD_INVALID', '本机原预约记录暂时无法核对，请联系门店确认，避免重复预约。')
  }
  return attempt
}
function pendingView(attempt) {
  return attempt ? { publicId: attempt.payload.publicId, arrivalAt: attempt.payload.arrivalAt, guestCount: attempt.payload.guestCount } : null
}
function finish(context, attempt, result) {
  assertCurrent(context)
  if (!result || result.publicId !== attempt.payload.publicId) {
    throw failure('RESERVATION_SUBMISSION_UNCONFIRMED', '预约回执暂时无法核对，请继续查询原预约，避免重复提交。')
  }
  const ids = runtime.getStorageSync('mbox.reservation.public.ids') || []
  runtime.setStorageSync('mbox.reservation.public.ids', [result.publicId].concat(ids.filter(id => id !== result.publicId)).slice(0, 20))
  // Clear only this exact request, never a later submission or another identity.
  const current = readAttempt(context)
  if (current && current.key === attempt.key) runtime.removeStorageSync(context.storageKey)
  return result
}
async function execute(context, attempt, recovery) {
  try {
    if (recovery) {
      try {
        const original = await request('/api/public/reservations/' + encodeURIComponent(attempt.payload.publicId), { requireTableSession: false })
        return finish(context, attempt, original.data)
      } catch (error) {
        assertCurrent(context)
        if (!(error && error.statusCode === 404 && error.code === 'RESERVATION_NOT_FOUND')) throw error
      }
      const age = Date.now() - attempt.createdAt
      if (age < 0 || age > SAFE_REPLAY_MS) {
        throw failure('RESERVATION_SUBMISSION_EXPIRED', '原预约暂未查到且已超过安全重试时限，请联系门店核对；本次不会新建预约。')
      }
    }
    assertCurrent(context)
    const response = await request('/api/public/reservations', {
      method: 'POST', requireTableSession: false,
      headers: { 'idempotency-key': attempt.key }, data: attempt.payload,
    })
    return finish(context, attempt, response.data)
  } catch (error) {
    assertCurrent(context)
    if (DEFINITE_REJECTIONS.has(error && error.code)) {
      const current = readAttempt(context)
      if (current && current.key === attempt.key) runtime.removeStorageSync(context.storageKey)
    } else {
      error.pendingReservation = pendingView(attempt)
    }
    throw error
  }
}
function payloadFor(input) {
  return {
    mode: 'direct', customerName: input.customerName, contact: input.contact,
    guestCount: input.partySize, arrivalAt: input.scheduledAt,
    seatPreference: input.seatPreference || 'no_preference', note: input.note || null,
    reservationPolicyVersion: input.reservationPolicyVersion,
    preferredScheduleId: input.preferredScheduleId || null,
  }
}
function runAttempt(context, attempt, recovery) {
  const previous = flights.get(context.storageKey)
  if (previous) return previous
  const pending = execute(context, attempt, recovery).finally(() => {
    if (flights.get(context.storageKey) === pending) flights.delete(context.storageKey)
  })
  flights.set(context.storageKey, pending)
  return pending
}
async function createSubmission(input) {
  const context = await currentContext()
  let attempt = readAttempt(context)
  const payload = payloadFor(input)
  if (attempt) {
    const original = Object.assign({}, attempt.payload)
    delete original.publicId
    if (JSON.stringify(original) !== JSON.stringify(payload)) {
      throw Object.assign(failure('RESERVATION_SUBMISSION_PENDING', '上次预约结果尚未确认，请先查询并恢复原预约，再填写新预约。'), { pendingReservation: pendingView(attempt) })
    }
    return runAttempt(context, attempt, true)
  }
  attempt = { version: 1, scope: context.scope, key: randomId('reservation-submit'), createdAt: Date.now(), payload: Object.assign({}, payload, { publicId: randomId('reservation') }) }
  runtime.setStorageSync(context.storageKey, attempt)
  if (JSON.stringify(readAttempt(context)) !== JSON.stringify(attempt)) {
    throw failure('RESERVATION_SUBMISSION_STORAGE_FAILED', '本机未能保存预约恢复记录，本次没有提交，请检查存储后重试。')
  }
  return runAttempt(context, attempt, false)
}
function createCustomerReservation(input) {
  // Coalesce the entire operation, including its asynchronous identity read.
  // A second caller must not start a new booking just because the first one
  // completed before the second profile response arrived.
  const scope = JSON.stringify([configuredScope(), sessionCredential()])
  const fingerprint = JSON.stringify(payloadFor(input))
  const existing = creations.get(scope)
  if (existing) {
    if (existing.fingerprint !== fingerprint) return Promise.reject(failure('RESERVATION_SUBMISSION_PENDING', '原预约正在提交，请先确认原预约，再填写新预约。'))
    return existing.promise
  }
  const promise = createSubmission(input).finally(() => {
    const current = creations.get(scope)
    if (current && current.promise === promise) creations.delete(scope)
  })
  creations.set(scope, { fingerprint, promise })
  return promise
}
async function getPendingCustomerReservation() {
  const context = await currentContext()
  return pendingView(readAttempt(context))
}
async function recoverCustomerReservation() {
  const context = await currentContext()
  const attempt = readAttempt(context)
  if (!attempt) return null
  return runAttempt(context, attempt, true)
}

export { createCustomerReservation, getPendingCustomerReservation, recoverCustomerReservation }
