# M-BOX 1.0.0-rc.168

## Scope

This candidate repairs the catalog edit failure reported for legacy products.
Product display snapshots are sanitized on read and write so old operational
keys no longer round-trip into the strict save validator. Images, descriptions
and other display metadata remain available, while status, price, inventory,
recipe and visibility continue to use their authoritative typed fields.

It also closes two adjacent data-loss paths. Editing a table without a layout
change no longer overwrites its existing map position with an empty object, and
editing a recipe without changing its instructions no longer replaces the
stored instruction snapshot with an empty object. The catalog deactivation
control now says that it only marks a draft and directs staff to the bottom save
action before expecting the Mini Program menu to change.

Normalized migration 156 strips obsolete operational keys from existing
product snapshots. It safely rebinds bundle components from 16 production-
verified legacy seed products to their current canonical products, merges any
colliding component quantities, recalculates bundle costs and retires only the
verified legacy records. A partial database uniqueness rule prevents managed
active products from sharing both a normalized customer-facing name and sales
specification, while preserving compatibility for older imported rows that do
not yet have an explicit specification.

## Acceptance boundary

Feature pull request 167 passed repository quality, a clean PostgreSQL
migration through schema 156, all normalized transaction and RLS tests, real
normalized HTTP workflows, mobile-browser commercial flows and sustained 5 RPS
performance checks. The local full suite passed 1,177 tests with 426 documented
skips, and focused migration/catalog coverage passed 108 tests with seven
documented skips.

The migration mapping is deliberately limited to the 16 duplicate pairs
verified in the current production database. It does not guess by name or
retire unrelated products. Production deployment must still read back the
snapshot cleanup, duplicate status, bundle references, table layouts and ready
metadata after cutover. The Mini Program menu will hide a product only after the
staff draft has been saved successfully and the public API sees it as inactive;
real-device cache refresh remains a separate client acceptance check.

## Production route

Deploy only from immutable tag `v1.0.0-rc.168` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. Keep rc.167
recoverable until backup and restore metadata, candidate health, Caddy cutover,
public readiness, worker health and the four browser routes are verified. The
expected normalized schema after deployment is 156.
