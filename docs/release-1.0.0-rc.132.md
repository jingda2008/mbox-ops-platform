# M-BOX 1.0.0-rc.132

## Scope

This release candidate supersedes `1.0.0-rc.131` for the normalized staff
web, service and database bundle. It improves the customer-facing mini-program
source for concise table and show context, quick service requests, and
server-ranked recommendations; it also adds safe optional table-opening
recommendation scenes for staff.

Activity registration and public contact correction are phone-only. A missed
phone field scrolls into view, and an unconfirmed local retry retains the same
idempotency key for at most fifteen minutes without persisting the phone.
Customer table requests are scoped to the scanned credential in memory so a
late response from a previous table cannot overwrite the current table’s cart,
payment or service state.

This release does not build, upload or replace the native WeChat mini-program
package.

## Acceptance boundary

The exact candidate must pass immutable CI quality, PostgreSQL transaction,
browser, performance and release-metadata gates. Local evidence for this
candidate includes a fresh PostgreSQL migration from `001` through `138` and
the complete normalized database suite. Production verification must confirm
the exact SHA, image digest, schema `138`, worker health, public readiness,
migration outcome and both verified evidence archives.

The local checks do not claim a completed native WeChat upload, real device
interaction, real provider payment, physical POS, printer, hardware or
staffed-field shift. Those are separate evidence boundaries.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment uses the immutable
GitHub pre-release, the private application host `10.100.80.223:22` through
the configured relay `139.224.254.60:6122`, and the existing backup,
migration, candidate-health and rollback safeguards.

## Deployment evidence

The immutable tag points to
`e84e55e3f72f87e92e2c3372adf16f1330493573`. Main CI, tag CI and the
GitHub pre-release workflow completed successfully before activation.

Production activation completed on 2026-08-26 through the approved deployment
entrypoint. The verified live identity is:

- schema: `138` / `normalized-core-v1`
- tier: `production`
- image digest:
  `sha256:d7d277cd549a592f98656b5f5d4a1e5cd2d61ddf746bce933b9d3d02805b2985`
- workers: healthy; strict inventory and writes enabled

The backup plus image, deployment and completion evidence were uploaded and
read back through the OSS evidence relay. After cutover, the deployment
verification and independent evidence-relay checks returned the exact
commit identity and HTTP 200 for `/`, `/guest?table=W01`, `/reserve`,
and `/staff/live`.

The publishing Mac's Clash/TUN resolver returned a Fake-IP for the public
hostname. A temporary, command-scoped mapping to the operations public IP was
used only for this release's local smoke process; system DNS, proxy settings
and repository scripts were not changed.

## Remaining delivery boundary

The server release includes the mini-program source only. It does not upload,
review or replace the native WeChat package. Native DevTools and real-device
acceptance, real payment, POS, printer, hardware and staffed-field validation
remain separate evidence boundaries.
