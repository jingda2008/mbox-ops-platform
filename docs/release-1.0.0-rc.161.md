# M-BOX 1.0.0-rc.161

## Scope

This candidate contains PR #147 on top of the deployed rc.160 baseline. It
finishes the customer self-checkout cancellation path and repairs the staff
surface that actually runs in production.

For an ordinary QR guest order using immediate WeChat payment, abandoning the
last payment step now informs the service. The unpaid order is removed from
operational customer, staff, KDS and table-turnover work, and the table can be
turned over or used for a new order. The service keeps the financial attempt
and abandonment fact for reconciliation instead of deleting an audit trail.

A background worker queries and closes stale guest payment intents. If a
provider later confirms collected money after the operational cancellation, it
creates a controlled refund follow-up only; it never revives fulfillment,
inventory consumption, KDS work, loyalty or recommendation attribution.
Staff-assisted pending orders, completed payments, activity registrations and
refunds remain outside the automatic guest-abandonment path.

The selected table's real production screen is now a closeable modal dialog in
`NormalizedStaffApp`. Its collection, assisted order, gift, recommendation,
service record, transfer and turnover actions open from the dialog and return
there after a secondary sheet closes. It supports a visible close control,
backdrop close, Escape close and focus containment.

## Acceptance boundary

The exact feature commit passed GitHub CI quality, isolated PostgreSQL
transaction/RLS and HTTP workflow checks, normalized-browser commercial flows
and sustained-load checks. Local targeted browser validation passed the same
table-dialog path: staff can order, collect, re-open collection and gift from
the dialog without touching the underlying grid.

This proves code and isolated-data behavior. It does not prove a live WeChat
debit, a payment-provider callback, POS/refund channel action, printer output,
or a real-device customer journey. The native Mini Program source is built and
uploaded separately through a source-identified DevTools project; that upload
creates an experience build, not a public release to every customer.

## Production route

Deploy only from immutable tag `v1.0.0-rc.161` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. The production
transaction runs configuration preflight, backup/readback, migration
compatibility validation, zero-traffic candidate checks, route smoke tests,
traffic cutover and OSS evidence sealing. A failed gate leaves the preceding
immutable release active.
