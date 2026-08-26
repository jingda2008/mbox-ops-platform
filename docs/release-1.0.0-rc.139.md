# M-BOX 1.0.0-rc.139

## Scope

This candidate supersedes `1.0.0-rc.138`. It makes the existing authorised
customer-left turnover operation clear and operationally neutral: a physical
table is released when the guest has left, while payment, refund and
reconciliation facts remain available to the cashier for later handling.

This is not a financial write-off. It does not mark a payment or refund
successful, cancel an approved refund, hide an outstanding financial fact, or
close the financial business day. The normal business-day close remains
blocked until financial reconciliation is complete.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and a fresh
PostgreSQL migration from `001` through `143`. The customer-left regression
must cover a paid and delivered order with an approved refund, proving the
physical table closes while the order, payment and refund states remain
unchanged.

Local builds and isolated database tests do not prove real payment-channel,
physical POS, printer, hardware, staffed-field or native WeChat acceptance.

## Production route

Deployment uses the approved release script with backup/readback, candidate
health, Caddy cutover, rollback safeguards and public route verification.
Post-switch evidence must confirm the exact commit, image digest, schema `143`
and worker health. This release does not build, upload or replace the native
WeChat mini-program package.

## Deployment evidence

Not yet deployed. The immutable tag, CI, image, backup/readback and
post-switch evidence will be recorded only after the candidate passes the
release gate.
