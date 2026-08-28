# M-BOX 1.0.0-rc.156

## Scope

This candidate supersedes `1.0.0-rc.155` and contains the merged table-read
transaction repair from PR #135 (`ab28c03`). It repairs a PostgreSQL `25006`
failure where a staff table-detail read entered a `READ ONLY` transaction but
the table-scope check still issued `FOR SHARE`.

The repair explicitly separates no-lock table-scope checks for read models from
the existing locked checks used by commands. It covers table order detail,
table payment-order selection, and the daily-snack redeem/cancel prechecks.
Payment, collection, table movement, fulfilment and other state-changing paths
retain their locking checks. No database migration is added; normalized schema
remains at migration `147`.

The staff panel no longer calls the order-detail endpoint with an optimistic
open-table placeholder, stops automatic retries after a failed request, and
offers a compact support-reference copy action. The release bundle excludes the
WeChat mini-program; this release does not upload or switch a mini-program
experience version.

## Acceptance boundary

The exact tag must pass immutable CI, including normalized database checks,
browser checks, performance checks and release-artifact construction. Local
regression includes the focused server and staff-panel suite, a disposable
PostgreSQL reproduction of the old `25006` failure, and a passing no-lock read
transaction test.

These gates prove neither a real customer payment nor a physical store-service
acceptance. They also do not make an unresolved payment successful; the
existing payment status and retry safety rules remain authoritative.

## Production route

Deploy only through the immutable tag bundle after CI produces the matching
image and evidence. The deployment process must verify backup/readback,
candidate readiness, exact commit and image identity, then cut over only if all
checks pass. On a preflight, migration, candidate or public-route failure,
retain the prior immutable release and stop rather than treating a partial
switch as success.
