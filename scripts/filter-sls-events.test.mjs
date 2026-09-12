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

for (const name of ['payment_reconciliation_failed','verified_payment_callback_apply_failed','payment_command_failed']) {
 test(`retains structured ${name} without raw error text`, () => {
  const event=classifySlsEvent({event:name,paymentId:'ec8959e0-c502-4688-8fce-7ac1b59527d7',stage:'apply_verified_success',errorCode:'23514',errorLocation:'/server/normalized/payment.js:10:2',message:'secret SQL',stack:'secret stack'})
  assert.equal(event?.logstore,'payment-audit');assert.equal(event?.severity,'error');assert.equal(event?.code,'23514')
  assert.equal(event?.stage,'apply_verified_success');assert.equal(event?.errorLocation,'/server/normalized/payment.js:10:2')
  assert.ok(event?.paymentRef);assert.equal(JSON.stringify(event).includes('secret'),false)
 })
}

test('preserves Docker event time so replay does not change event identity',()=>{
 const line='2026-09-12T08:00:00.123456789Z '+JSON.stringify({event:'payment_reconciliation_failed',errorCode:'23514',time:1789199999000})
 const first=classifySlsEvent(line),second=classifySlsEvent(line)
 assert.equal(first?.timestamp,'2026-09-12T08:00:00.123456789Z');assert.equal(first?.fingerprint,second?.fingerprint)
})
