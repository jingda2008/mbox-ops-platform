# M-BOX 1.0.0-rc.137

## Scope

This candidate supersedes `1.0.0-rc.136`. It repairs the retry-release path
for an online payment that has no explicit success result. The command
previously appended a valid client idempotency key to a bounded outbox event
key, which could exceed the outbox limit and roll back the entire release
transaction.

The outbox event key is now stable and payment-scoped. Command idempotency
continues to use the original client key. One payment can still be released
only once, and a late provider success remains a visible financial fact for
reconciliation and any required refund.

This release does not mark a payment successful or failed, does not close a
table with an active refund, and does not build, upload or replace the native
WeChat mini-program package.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and a fresh
PostgreSQL migration from `001` through `142`. The payment retry regression
must exercise the actual command executor, audit event and outbox write using
a 128-character idempotency key.

Local builds and isolated database tests do not prove a real payment-channel
result, physical POS, printer, hardware, staffed-field operation or native
WeChat acceptance.

## Production route

Deployment uses the approved release script with backup/readback, migration,
candidate health, Caddy cutover, rollback safeguards and external route smoke.
Post-switch evidence must confirm the exact commit, image digest, schema `142`,
worker health and `/`, `/guest?table=W01`, `/reserve` and `/staff/live`.

## Deployment evidence

Not yet deployed. The release workflow will add immutable tag, CI, image,
backup/readback, migration and smoke evidence after this candidate passes.
