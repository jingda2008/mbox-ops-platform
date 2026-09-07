# M-BOX 1.0.0-rc.176

## Scope

This candidate repairs the deep-audit findings across payment recovery, table
operations, staff permissions, responsive customer pages and release runtime
loading. Android App packaging remains explicitly out of scope; Android WeChat
Mini Program compatibility remains part of the customer acceptance boundary.

An unresolved online attempt can now be explicitly released for another
collection without pretending that the original attempt failed and without a
synchronous provider query or close. Every active employee role can initiate
online collection for an order already in that employee's table scope. A
retry-released attempt remains available for reconciliation and a late signed
success, but it no longer occupies the current-payment slot, blocks normal
table closure after the balance is paid, keeps an expired inventory reservation
open, or hides the replacement collection controls.

Authoritative success remains the only fact that closes the order balance.
Multiple real successes are all preserved in the payment and reconciliation
ledgers; the order sale, fulfilment activation, recommendation attribution and
loyalty award remain single-order facts. Returning the overcollection does not
reverse customer benefits while the order remains fully paid. A third payment
is rejected once the net confirmed collection covers the order.

StarPay pending or failed query responses no longer require a success-only
provider transaction time. They use the trusted query observation time while a
successful response still requires the provider's authoritative transaction
time.

The customer web menu no longer renders an empty fixed cart or stacks two
sticky headers, preventing bottom-navigation overlap and off-screen overflow.
Staff pages avoid unauthorized fulfilment reads, restore heading hierarchy,
44-pixel controls and stronger text contrast. Large staff modules are loaded by
route, reducing the initial staff application chunk and removing the production
chunk-size warning.

The native WeChat Mini Program removes an unreachable account-page payment
binding. Because native source changed, this candidate requires a new WeChat
Developer Tools upload and a separately verified experience-version selection.

## Acceptance boundary

Before deployment, this exact commit must pass release metadata, architecture,
dependency audit, all unit and normalized PostgreSQL tests, isolated HTTP and
browser flows, responsive viewport checks, Mini Program release tests and the
sustained-load gate. Payment acceptance must include an unresolved attempt,
explicit retry release, a successful replacement, a late success on the old
attempt, overcollection display, refund back to the order total and rejection
of a further collection.

Real WeChat/StarPay money, refund arrival, cash/POS reconciliation, physical
printer/KDS, store roles and iOS/Android WeChat devices remain field acceptance
items. These external items keep commercial readiness at `DENY`; they are not
fabricated by automated tests or by deploying the validation runtime.

## Production route

Merge the reviewed commit to `main`, tag that exact main commit as
`v1.0.0-rc.176`, wait for the immutable GitHub CI image and evidence bundle,
then deploy only through `deploy/aliyun/deploy-release.sh`. Verify backup and
OSS readback, schema 158, exact commit and image digest, worker health and public
deep links before and after cutover. Retain rc.175 as the rollback container
until post-cutover observation passes.

Build the Mini Program release candidate from the same merged commit. The
native upload, experience-version selection and real-device acceptance are
separate evidence gates from the backend deployment.
