import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:15174'
const guestCount = Number(__ENV.GUESTS || 300)
const virtualUsers = Math.min(Number(__ENV.VUS || 60), guestCount)
const localMode = (__ENV.LOCAL_MODE || 'true') === 'true'
const tableToken = __ENV.TABLE_TOKEN || ''

const serverErrors = new Rate('server_errors')
const guestSessionDuration = new Trend('guest_session_duration', true)
const completedJourneys = new Counter('completed_guest_journeys')

export const options = {
  scenarios: {
    nightly_guests: {
      executor: 'shared-iterations',
      vus: virtualUsers,
      iterations: guestCount,
      maxDuration: '4m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    server_errors: ['rate==0'],
    guest_session_duration: ['p(95)<1200'],
    checks: ['rate>0.99'],
  },
}

function guestId() {
  const suffix = String((__VU * 1_000_000 + __ITER) % 1_000_000_000_000).padStart(12, '0')
  return `10000000-0000-4000-8000-${suffix}`
}

export default function () {
  const headers = { 'x-mbox-guest-id': guestId(), 'x-mbox-guest-source': 'guest_web' }
  const page = http.get(`${baseUrl}/guest?table=L01`, { tags: { flow: 'guest_page' } })
  serverErrors.add(page.status >= 500)

  const health = http.get(`${baseUrl}/api/health`, { tags: { flow: 'health' } })
  serverErrors.add(health.status >= 500)

  let sessionOk = true
  if (localMode || tableToken) {
    const query = tableToken ? `token=${encodeURIComponent(tableToken)}` : 'table=L01'
    const session = http.get(`${baseUrl}/api/guest/session?${query}`, {
      headers,
      tags: { flow: 'guest_session' },
    })
    guestSessionDuration.add(session.timings.duration)
    serverErrors.add(session.status >= 500)
    sessionOk = check(session, {
      'guest session succeeds': (response) => response.status === 200,
      'guest session identifies L01': (response) => response.json('table.code') === 'L01',
    })
  }

  check(page, { 'guest page loads': (response) => response.status === 200 })
  check(health, { 'health endpoint is ready': (response) => response.status === 200 })
  if (sessionOk) completedJourneys.add(1)
  sleep(Math.random() * 0.2)
}
