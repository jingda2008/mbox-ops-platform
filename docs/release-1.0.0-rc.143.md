# M-BOX 1.0.0-rc.143

## Scope

This candidate supersedes `1.0.0-rc.142` for reliability only. It eliminates
overlapping queries on a single PostgreSQL scoped client in customer-experience
read paths. It also makes the employee device-verification browser check
diagnose the authoritative device-access response before asserting the login
transition.

It changes no payment, refund, inventory, table-turnover, membership rule,
permission, customer-facing mini-program, database schema or operational data.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and the normal fresh
PostgreSQL migration gate through schema `143`. Local validation covers the
full normalized PostgreSQL suite, browser role flows, Web type checking and the
production Web build.

This candidate does not build, upload or replace the native WeChat mini-program
package. It also does not establish real payment-channel, physical POS, printer,
hardware or staffed field acceptance.

## Production route

Deploy only through the approved release script with backup/readback, candidate
health, Caddy cutover, rollback safeguards and public-route verification.
Post-switch evidence must record the exact commit, image digest, schema `143`
and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
