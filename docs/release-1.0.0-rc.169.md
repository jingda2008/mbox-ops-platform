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

Not deployed yet. Record the immutable commit, image digest, database backup,
rollback container, public readiness and evidence readback only after the
controlled deployment completes.
