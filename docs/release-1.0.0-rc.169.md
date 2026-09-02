# M-BOX 1.0.0-rc.169

## Scope

This candidate repairs interrupted-payment recovery and makes cashier attention
state visible. Passive payment-status polling and cashier-workbench refresh now
read only the local authoritative ledger. External provider query is limited to
an explicit staff action or the bounded background reconciliation worker, so a
slow or unavailable payment service cannot make table operations wait on page
refresh traffic.

When a guest explicitly leaves the final immediate-payment sheet, the service
releases the unfulfilled order, inventory reservation and operational capacity
in the local transaction without waiting for the external rail. The payment
fact remains auditable and the background worker continues provider query and
close. An unknown provider result is never rewritten as failed, and any late
captured money is routed to the existing refund follow-up instead of reviving
fulfilment. The customer starts a fresh order after release; authorised staff
retain the explicit query-and-close recovery before changing collection method.

The table map now distinguishes no order, unpaid, payment pending, paid, refund
attention and stale payment exception states. Refund or payment exceptions add
an attention badge to the all-table view. Staff can filter tables by area and
pending payment. The cashier workbench refreshes local refund attention while
visible and idle, warns when new work appears, and supports search by order
reference, table or exact amount plus area and payment-state filters.

The production dependency lock also advances Fastify and both resolved
`fast-uri` lines to patched releases. The release pull request initially
stopped on newly published high/moderate npm advisories; the refreshed lock must
pass a clean production dependency audit and the complete compatibility suite
before the candidate can be tagged. Because patched Fastify rejects numeric
hop-only proxy trust, the application now validates the immediate Caddy peer as
loopback or private-network traffic and stops at the first public client hop.

## Acceptance boundary

Feature pull request 170 and its final evidence check passed repository quality,
a clean PostgreSQL migration through schema 156, all normalized transaction and
RLS tests, real normalized HTTP workflows, mobile-browser commercial flows and
sustained 5 RPS performance checks. Local acceptance separately passed the
repository check, 1,341 PostgreSQL tests with one environment-conditional skip,
and 39 of 39 real-browser scenarios.

These checks prove the state transitions, permissions, query isolation and UI
contracts in controlled environments. They do not prove a real WeChat or Postar
payment, refund settlement, device-specific Mini Program behaviour or staff
operating acceptance. The Android entry problem was explicitly outside the
feature scope. This backend/staff-web release does not upload or select a native
Mini Program package.

## Production route

Deploy only from immutable tag `v1.0.0-rc.169` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. Keep rc.168
recoverable until backup and restore metadata, candidate health, Caddy cutover,
public readiness, worker health and the four browser routes are verified. This
candidate adds no database migration; the expected normalized schema remains
156.

## Production result

Production deployment completed at `2026-09-03 01:26 CST`
(`2026-09-02T17:26:00Z`) from immutable tag `v1.0.0-rc.169`. The deployed
commit is `63910fd7dd7b6803c5669f4ca4a548ff73582f2b`; the runtime image digest is
`sha256:c7c5aadfb2dd37c070a3055f450009534f3d775dbe1aba46c71f0fc63f835fad`.
GitHub tag CI run `33659039080` and Release run `33659038997` both completed
successfully before deployment.

The controlled release created and verified database backup
`/opt/mbox/backups/mbox-20260902T172424Z-u0QU6p.dump` (37,935,808 bytes),
verified pre-deployment, backup, deployment and completion objects through the
OSS evidence relay, then passed candidate health and deep verification before
Caddy cutover. The remote state reached `completed`; schema remains 156. The
previous rc.168 application is retained, stopped, as rollback container
`mbox-app-rollback-63910fd-20260903-012536`.

Post-cutover `/api/ready` independently returned `ready`, production tier,
strict inventory enforcement, write enabled and healthy workers with the exact
commit and image digest above. Browser-style HTTP requests, a 430 px Chromium
run and checks from the independent evidence relay all passed `/`,
`/guest?table=W01`, `/reserve` and `/staff/live`. One additional local Node
probe using a three-second timeout saw a transient timeout after the successful
cutover; the ten-second bounded rerun, Chromium, direct readiness checks and 12
independent relay route checks passed, so no sustained production fault was
observed.

This deployment does not upload or select a native WeChat Mini Program build.
It also does not count as real WeChat/Postar payment, refund settlement,
Android-device or staff operating acceptance; those external gates remain
open.
