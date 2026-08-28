# M-BOX 1.0.0-rc.157

## Scope

This candidate supersedes `1.0.0-rc.156` and contains the merged customer
mini-program checkout recovery from PR #137 (`6d70a74`). The mini-program cart
is now a compact, recognizable entry to an editable order review. Customers can
see product prices, quantities, line subtotals and the final amount before one
confirmation creates the order and directly starts WeChat payment.

The client distinguishes payment success, customer cancellation, failed launch,
WeChat acceptance with delayed server confirmation, and an unknown checkout
submission result. A definite pre-order rejection releases the local guard and
states that no order was created. An unknown result can be dismissed, but the
same idempotency key and cart freeze are retained for safe status lookup or
retry. After WeChat accepts payment, the client will not reopen payment while
the authoritative callback is still being confirmed. Contextual subscription
authorization is requested only after the WeChat payment callback and cannot
change the payment result.

The checkout and supporting customer pages add narrow-screen constraints for
the Huawei X5 outer screen and other widths at or below 360px. The server and
production example require guest `wechat_jsapi`; a staff-style native QR mode is
rejected before a shared-cart order is created. No database migration is added;
normalized schema remains at migration `147`.

The backend release bundle excludes the WeChat mini-program. Deploying this tag
updates the server and production configuration guard only; it does not upload,
approve or switch a mini-program experience version.

## Acceptance boundary

The exact tag must pass immutable CI, including normalized PostgreSQL checks,
browser checks, performance checks and release-artifact construction. The PR
already passed the customer mini-program contract and table-scope checkout
tests, the guest payment/configuration unit suite, the normalized full suite and
the release recovery drills.

These gates prove neither a real WeChat debit nor a physical Huawei X5/store
acceptance. They do not convert an unknown payment to success and do not permit
a second payment after WeChat acceptance. Real one-yuan payment, callback-delay,
cancellation, weak-network, final arrival and end-of-day reconciliation remain
required field evidence.

## Production route

Deploy only through the immutable tag bundle after CI produces the matching
image and evidence. The deployment process must verify backup/readback,
production configuration, candidate readiness, exact commit and image identity,
then cut over only if all checks pass. On a preflight, migration, candidate or
public-route failure, retain the prior immutable release and stop rather than
treating a partial switch as success.
