# M-BOX 1.0.0-rc.134

## Scope

This candidate supersedes `1.0.0-rc.133` without changing its operational
scope: activity publish outbox UUID handling, bounded unresolved-payment
retry, and the customer-left table-turnover path remain included.

It corrects a PostgreSQL portability defect found by the `rc.133` fresh-database
CI job. The customer-left stored procedure no longer assumes `pgcrypto.digest`
is installed in the `public` schema; it uses the established M-BOX SHA-256
function instead. This keeps its idempotency and audit hashes identical in
meaning while working with managed PostgreSQL extension schemas.

This release does not build, upload or replace the native WeChat mini-program
package.

## Acceptance boundary

Before activation, the exact immutable tag must pass release CI and a fresh
PostgreSQL migration from `001` through `141`, including the customer-left
turnover integration path. Local checks are necessary but do not prove native
WeChat upload, real-device interaction, real payment, physical POS, printer,
hardware or staffed-field operation.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment uses the approved
release script, immutable GitHub pre-release, backup, migration, candidate
health, Caddy cutover and rollback safeguards. Post-switch evidence must
verify the exact commit, image digest, schema `141`, worker health and `/`,
`/guest?table=W01`, `/reserve` and `/staff/live`.

## Deployment evidence

Not yet deployed. The release workflow adds immutable tag, CI, image,
backup/readback, migration and smoke evidence after the candidate passes.
