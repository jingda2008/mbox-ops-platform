const { request, deviceKey } = require('./request')
const { randomId } = require('./id')
const { getTableSession } = require('./session')
const { ensureCustomerSession } = require('./auth')

async function loadGuestSession() {
  const session = getTableSession()
  if (session.tableToken && wx.getStorageSync('mbox.connected.table.token') !== session.tableToken) {
    const connected = await request('/api/guest/session/scan', {
      method: 'POST',
      requireTableSession: false,
      data: { tableQrToken: session.tableToken, deviceKey: deviceKey() },
    })
    wx.setStorageSync('mbox.connected.table.token', session.tableToken)
    return connected.data
  }
  const response = await request('/api/guest/session', { requireTableSession: false })
  return response.data
}

async function getGuestSession() { return { data: await loadGuestSession(), source: 'api', warning: '' } }

async function publicRequest(path, options) {
  await ensureCustomerSession(false)
  return request(path, Object.assign({ requireTableSession: false }, options || {}))
}

async function getMiniBootstrap() { return (await publicRequest('/api/public/mini/bootstrap')).data }
async function getActivities() { return (await publicRequest('/api/public/mini/activities')).data }
async function enrollMembership() {
  return (await publicRequest('/api/public/mini/membership/enroll', {
    method: 'POST', headers: { 'idempotency-key': randomId('membership-enroll') }, data: {},
  })).data
}
async function updatePreferences(preferences, displayName) {
  return (await publicRequest('/api/public/mini/preferences', {
    method: 'PATCH', headers: { 'idempotency-key': randomId('member-preferences') },
    data: { preferences, displayName: displayName || null },
  })).data
}
async function registerActivity(activityPublicId, partySize, contactSnapshot, safetyAcknowledgement, paymentChoice) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}/registrations`, {
    method: 'POST', headers: { 'idempotency-key': randomId('activity-register') },
    data: { partySize, contactSnapshot, safetyAcknowledgement, paymentChoice: paymentChoice || 'none' },
  })).data
}

async function getReservations() {
  await ensureCustomerSession(false)
  const ids = wx.getStorageSync('mbox.reservation.public.ids') || []
  const records = await Promise.all(ids.slice(0, 20).map(async (id) => {
    try { return (await publicRequest(`/api/public/reservations/${encodeURIComponent(id)}`)).data } catch (_error) { return null }
  }))
  return { reservations: records.filter(Boolean) }
}

async function getReservationAvailability(arrivalAt, guestCount) {
  return (await publicRequest(`/api/public/reservation/availability?arrivalAt=${encodeURIComponent(arrivalAt)}&guestCount=${encodeURIComponent(guestCount)}`)).data
}

async function createCustomerReservation(input) {
  const response = await publicRequest('/api/public/reservations', {
    method: 'POST', headers: { 'idempotency-key': randomId('reservation') },
    data: {
      mode: 'direct', customerName: input.customerName, contact: input.contact,
      guestCount: input.partySize, arrivalAt: input.scheduledAt,
      seatPreference: input.seatPreference || 'no_preference', note: input.note || null,
    },
  })
  const data = response.data
  const ids = wx.getStorageSync('mbox.reservation.public.ids') || []
  if (data && data.publicId) wx.setStorageSync('mbox.reservation.public.ids', [data.publicId].concat(ids.filter((id) => id !== data.publicId)).slice(0, 20))
  return data
}

async function getMenu(query) {
  const params = []
  if (query && query.categoryCode) params.push(`categoryCode=${encodeURIComponent(query.categoryCode)}`)
  if (query && query.search) params.push(`search=${encodeURIComponent(query.search)}`)
  params.push('limit=100')
  return (await request(`/api/guest/menu/products?${params.join('&')}`)).data
}
async function recommendExperience(input) {
  return (await request('/api/guest/experience/recommendations', {
    method: 'POST', headers: { 'idempotency-key': randomId('experience-recommend') }, data: input,
  })).data
}
async function createExperiencePlan(input) {
  return (await request('/api/guest/experience/plans', {
    method: 'POST', headers: { 'idempotency-key': randomId('experience-plan') }, data: input,
  })).data
}
async function prepareCheckoutUpgrade(items, occasion, alcoholPreference) {
  return (await request('/api/guest/checkout/upgrade-offers', {
    method: 'POST', headers: { 'idempotency-key': randomId('checkout-upgrade-offer') },
    data: { items, occasion, alcoholPreference },
  })).data
}
async function checkout(items, checkoutUpgradeOfferPublicId) {
  return request('/api/guest/orders', {
    method: 'POST', headers: { 'idempotency-key': randomId('guest-order') },
    data: { items, checkoutUpgradeOfferPublicId: checkoutUpgradeOfferPublicId || null },
  })
}
async function getTableOrders() { return (await request('/api/guest/orders/table')).data }
async function createServiceTask(input) {
  return request('/api/guest/service-requests', {
    method: 'POST', headers: { 'idempotency-key': randomId('guest-service') },
    data: { requestType: input.requestType || 'custom', detail: input.detail || null },
  })
}
async function submitSongRequest(input) {
  return request('/api/guest/song-requests', {
    method: 'POST', headers: { 'idempotency-key': randomId('song-submit') }, data: input,
  })
}
async function getTodayPerformances() {
  return (await request('/api/guest/performances/today', { requireTableSession: false })).data
}

module.exports = {
  getGuestSession, getMiniBootstrap, getActivities, enrollMembership, updatePreferences,
  registerActivity, getReservations, getReservationAvailability, createCustomerReservation, getMenu, recommendExperience,
  createExperiencePlan, prepareCheckoutUpgrade, checkout, getTableOrders,
  createServiceTask, submitSongRequest, getTodayPerformances,
}
