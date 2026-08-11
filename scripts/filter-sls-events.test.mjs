import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySlsEvent } from './filter-sls-events.mjs'

test('keeps only bounded fields for payment callback failures', () => {
  const event = classifySlsEvent({
    level: 50,
    msg: 'payment callback failed',
    statusCode: 502,
    req: { url: '/api/payments/callback?token=private' },
    requestBody: { phone: '13800138000', customerAuthCode: 'private-code' },
    err: { stack: 'contains private details' },
    reqId: 'request-1',
  })
  assert.deepEqual(event && {
    eventType: event.eventType,
    logstore: event.logstore,
    route: event.route,
    statusCode: event.statusCode,
    requestId: event.requestId,
  }, {
    eventType: 'callback_exception',
    logstore: 'payment-audit',
    route: '/api/payments/callback',
    statusCode: 502,
    requestId: 'request-1',
  })
  const serialized = JSON.stringify(event)
  assert.equal(serialized.includes('13800138000'), false)
  assert.equal(serialized.includes('private-code'), false)
  assert.equal(serialized.includes('private details'), false)
})

test('classifies permission rejection and ignores normal requests', () => {
  assert.equal(classifySlsEvent({ level: 30, statusCode: 200, msg: 'request completed' }), null)
  const denied = classifySlsEvent({ level: 40, code: 'AUTHORIZATION_DENIED', msg: 'permission denied', actorId: 'emp-manager' })
  assert.equal(denied?.eventType, 'permission_denied')
  assert.equal(denied?.logstore, 'release-audit')
  assert.equal(denied?.actorId, 'emp-manager')
})

test('accepts explicit deployment and container events only from a closed vocabulary', () => {
  assert.equal(classifySlsEvent({ mboxAuditEvent: 'deployment_succeeded', releaseSha: 'a'.repeat(40) })?.logstore, 'release-audit')
  assert.equal(classifySlsEvent({ mboxAuditEvent: 'container_oom', container: 'mbox-app' })?.logstore, 'runtime-errors')
  assert.equal(classifySlsEvent({ mboxAuditEvent: 'arbitrary_customer_event', message: 'normal' }), null)
})
