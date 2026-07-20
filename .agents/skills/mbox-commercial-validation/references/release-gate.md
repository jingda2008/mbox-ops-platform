# M-BOX Release Gate

## Client coverage

| Surface | Mandatory validation |
| --- | --- |
| Guest QR/H5 | table session, menu, cart, service request, order status, stage schedule, mobile overflow |
| Public reservation | create, edit, cancel, manager visibility, contact validation, mobile layout |
| Staff web/app | six-hour identity, role navigation, task response, table actions, visible feedback |
| KDS | bartender/kitchen claim restrictions, prepare, complete, pickup, deliver, SLA escalation |
| Cashier/payment | authorization, idempotency, simulated boundary, physical POS reporting, refund separation |
| Manager/owner | oversight, assignment, exception takeover, configuration publish, audit trail |
| Mini-program/mobile shells | source check, build/sync checks, no secret embedded in client bundles |

## Role coverage

At minimum validate owner, manager, server, bartender, kitchen, and cashier. Verify both an allowed action and a denied high-risk action for each role. UI hiding is not sufficient; server authorization tests must also pass.

## Load model

The local k6 model represents 300 guest journeys with a 60-VU burst. It reads the guest page, health endpoint, and isolated L01 guest session. Thresholds are:

- request failures below 1%
- server 5xx exactly 0
- all checks above 99%
- HTTP P95 below 1 second
- HTTP P99 below 2 seconds
- guest session P95 below 1.2 seconds

This is an application baseline, not proof of production database capacity. Run a separate staging soak test only with an isolated tenant and monitoring enabled.

## Deployment decision

Deploy to validation only after the local gate passes. Preserve the previous Cloud Run revision for rollback, send traffic only after health/readiness checks pass, and keep the 213-TC blockers visible in release notes.
