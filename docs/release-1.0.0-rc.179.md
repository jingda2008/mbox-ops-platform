# M-BOX 1.0.0-rc.179

## Scope

This candidate releases the already-merged per-copy bundle selection and owner
finance/payroll foundations (schema 159-160), then adds schema 161 for durable
payment/refund provider-query backoff and the verified operations-feedback
repairs documented in `MBOX_OPERATIONS_PAYMENT_AUDIT_20260908.md`.

Payment or refund queries are financial follow-up and never table state. The
database now persists query phase, due time, lease, counts and final stop reason;
restarts and concurrent workers cannot return an operationally released payment
to a 30-second loop. Pending/processing responses update only this mutable state
and no longer append an immutable observation on every poll. Verified terminal
queries and callbacks continue through the existing amount, currency, original
transaction and financial-command authority.

StarPay JSAPI IP-risk rejection receives a distinct response and guest-facing
recovery guidance. The provider still receives the consumer address resolved
through the trusted reverse-proxy boundary; stored diagnostics contain only a
masked prefix. A retry creates a separate payment attempt and merchant order.

The staff web workbench adds visible new fulfillment/service notices, current
ordered value on each active table and an exception-manager batch workflow for
verified historical KDS carryover. Every carryover task is still closed through
the existing audited, idempotent task command. This release does not auto-open a
table from an unauthenticated QR scan and does not fabricate a parking voucher
without a parking operator contract.

## Mini Program

The native WeChat Mini Program changes its failed-payment presentation to
distinguish network rejection, identity rejection, merchant/configuration
unavailability and other provider rejection. It explicitly states when no debit
was initiated and offers network switching or staff QR/POS/cash collection.
After the merged release is deployed, the exact merged `miniprogram/` tree must
be uploaded through WeChat Developer Tools and selected as an experience
version; upload is not real-device payment acceptance.

## Acceptance boundary

Automated checks cover immutable migrations 001-161, role and API boundaries,
provider-query state transitions, Mini Program contracts, production build and
browser flows. Deployment must read back the merged commit, immutable image
digest, schema 161 and store configuration `2026.09.08-v21`.

Real StarPay/WeChat receipt, delayed success, real refund, W06 two ¥45 collection
differences, cash/POS reconciliation, real employee accounts, parking integration
and physical devices remain external acceptance. Commercial readiness remains
`DENY`; this candidate may deploy the continuity and observability repairs but
must not be described as real-money or store acceptance completion.
