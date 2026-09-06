# M-BOX 1.0.0-rc.171

## Scope

This candidate repairs the staff-assisted ordering and table-finance attention
paths. A dedicated read-only endpoint now paginates the complete active catalog,
filters it to `staff_assisted`, verifies a positive current price, applies
inventory availability and removes cost data. The cashier role gains only the
table visibility, order creation and audited close/turnover permissions needed
for its operating duty; catalog management, gifting and refund initiation stay
outside that role.

The live table map now distinguishes unpaid, provider-confirming, payment-error,
refund-pending and settled sessions using local authoritative financial facts.
It shows per-table counts and persistent payment/refund actions without calling
the payment provider from the table polling path. Customer-left turnover keeps
unknown or late payment facts available for cashier reconciliation and does not
fabricate payment success.

The WeChat and Alipay order cards use bounded grid rows so long bundle copy
cannot push price or add controls outside the existing card. Guest reservations
are again available without membership, while member-only benefits remain
gated. Two staff management selectors also paginate beyond 100 active products.

## Acceptance boundary

The candidate must pass the complete repository gate, all normalized PostgreSQL
transaction and RLS tests, the isolated HTTP acceptance run, the 39-flow mobile
browser suite and sustained-load gate. Browser acceptance specifically logs in
as cashier `sanmu`, verifies the W01 financial alert and local-state table colour,
opens assisted ordering and finds a kitchen snack.

Payment-provider production behavior is unchanged. Passive table and cashier
reads do not query the provider; explicit payment query, close, retry, refund
and reconciliation commands keep their existing idempotency and audit rules.
Real-device Mini Program acceptance and the WeChat experience-version selection
remain separate from backend deployment evidence.

## Production route

Deploy only the immutable `v1.0.0-rc.171` GitHub release bundle through
`deploy/aliyun/deploy-release.sh`. The release must verify the tag SHA, image
digest, schema migration 157, OSS backup upload/readback, candidate health and
deep links before the Caddy switch. Keep the previous healthy production image
available until `/api/ready`, `/`, `/guest?table=W01`, `/reserve` and
`/staff/live` pass after activation.
