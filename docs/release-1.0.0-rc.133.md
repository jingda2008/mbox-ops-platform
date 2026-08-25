# M-BOX 1.0.0-rc.133

## Scope

This candidate supersedes `1.0.0-rc.132` for the normalized staff web,
service and database bundle.

It fixes Superhigh activity publishing when an outbox record is written: the
database-facing aggregate remains the internal UUID while the operator-facing
audit object remains the public activity number. It also adds a bounded
unresolved-payment retry operation for normal table orders. An employee who
did not receive an explicit online-payment success may record that fact,
generate a replacement QR or collect through another permitted method. The
original payment is never deleted and any later confirmed result remains in
the cashier/reconciliation path.

For a customer who leaves before an authoritative payment success, a staff
member with the explicit turnover permission can close the table after
cancelling unfulfilled work and writing a permanent exception event. Confirmed
or partial payments, refund work, and other customer-value commitments still
block this path. A late successful callback records money but cannot revive
cancelled kitchen or inventory work.

This release does not build, upload or replace the native WeChat mini-program
package.

## Acceptance boundary

Before activation, the exact immutable tag must pass the release CI and a
fresh PostgreSQL migration from `001` through `140`. Local candidate evidence
includes the normalized PostgreSQL suite, activity publishing regression,
explicit retry/replacement regression, customer-left turnover regression,
web typecheck, production build and mini-program static checks.

Local checks do not claim a completed native WeChat upload, real-device
interaction, real provider payment, physical POS, printer, hardware or
staffed-field shift. These remain separate operational evidence boundaries.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment uses an immutable
GitHub pre-release, the established application-host route through the
evidence relay, plus its backup, migration, candidate-health, Caddy-switch and
rollback safeguards. Post-switch evidence must verify the exact commit, image
digest, schema `140`, worker health and `/`, `/guest?table=W01`, `/reserve`
and `/staff/live`.

## Deployment evidence

Not yet deployed. This document intentionally records the candidate boundary;
the immutable tag, CI identity, image digest, backup/readback, migration and
production smoke evidence are added only by the approved release workflow.

## Remaining delivery boundary

The server release includes mini-program source only. It does not upload,
review or replace the native WeChat package. Native DevTools and real-device
acceptance, real payment, POS, printer, hardware and staffed-field validation
remain separate evidence boundaries.
