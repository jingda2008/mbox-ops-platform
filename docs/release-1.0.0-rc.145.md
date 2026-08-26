# M-BOX 1.0.0-rc.145

## Scope

This corrective candidate supersedes the unactivated `1.0.0-rc.144` release
attempt. It retains the payment-recovery and activity-payment-cycle protections
from rc.144, and repairs the schema-144 menu-category upgrade for stores where
a live product category code already matches a seeded top-level category such
as `drinks`.

The migration now preserves an existing category row and only materializes a
legacy product category that is not already present for that store. It does not
rewrite product categories, re-parent existing rows, or alter live prices,
inventory, payments or orders.

## Acceptance boundary

The corrective upgrade is covered by a PostgreSQL historical-data test with a
legacy `drinks` product category plus an unknown legacy category, and by a
fresh normalized PostgreSQL matrix through schema `145`. The live production
database remains on schema `143` because the earlier rc.144 activation stopped
before cutover and rolled back migration 144.

Before activation, this immutable tag must pass release CI and the approved
release procedure must create a new backup/readback report. Real WeChat JSAPI,
provider query/close, refund callback, staff QR/POS, printer and on-site
turnover flows remain controlled production acceptance work; this release does
not itself upload or release a native WeChat mini-program package.

## Production route

Deploy only through the approved release route with migration checksum
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route verification. Post-switch evidence must record the
exact commit, image digest, schema `145` and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
