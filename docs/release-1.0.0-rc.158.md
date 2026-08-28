# M-BOX 1.0.0-rc.158

## Scope

This candidate contains PR #140, which corrects the native mini-program
scan-order payment handoff. The online-payment service deliberately returns a
`pending` action after it has created a valid WeChat JSAPI pre-order and before
the customer has completed payment. The old mini-program client mistakenly
required a non-contractual `ready` status, so it showed a launch-failure sheet
without calling `wx.requestPayment`.

The client now accepts only a complete `pending` + `jsapi` action with the
required WeChat parameters, then opens the native WeChat payment sheet for both
the initial cart checkout and a later “continue payment” action. Unknown or
incomplete actions remain in the safe confirmation path; they are never marked
paid and cannot create a duplicate order. The payment-result sheet has compact
action buttons and a top-right pill-style cancel control, including the
Huawei Mate X5 outer-screen width.

No database migration is included. The normalized schema remains at migration
`147`. The server deployment bundle excludes the native WeChat mini-program:
after this backend deployment, the customer-visible client change still
requires a separately verified Mini Program upload and experience-version
release.

## Acceptance boundary

PR #140 passed the full CI matrix: quality/build checks, a fresh isolated
PostgreSQL transaction and HTTP suite, normalized browser commercial flows and
the sustained-load check. It also passed local mini-program table-scope
checkout tests and customer-funnel tests, and the exact source was compiled in
WeChat DevTools using the Huawei Mate X5 outer-screen profile.

These checks verify that the native client calls `wx.requestPayment` when the
server returns valid JSAPI parameters. They do not prove a live debit, provider
callback arrival, WeChat identity binding, or real-device payment completion.
Those remain field acceptance steps after the client version is uploaded.

## Production route

Deploy only through the immutable tag bundle after tag CI has generated the
matching image and evidence. Production cutover must verify configuration,
backup/readback, candidate health, exact SHA and image digest, formal-route
smoke checks and the final OSS evidence record. If any preflight, migration,
candidate or public-route gate fails, keep the previous immutable release
active.
