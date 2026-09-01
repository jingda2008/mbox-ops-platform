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

## Production result

Production deployment completed on 2026-09-02 (Asia/Shanghai) from immutable
tag `v1.0.0-rc.168`. The deployed commit is
`a825ae913cf2ef38080534a271ef38b207cc7b31`, the release image digest is
`sha256:70c8777c57d0e551f64cfd7b799565089ed4b1b629c9bee3a8078d9ebae44c65`,
and the public readiness response reports production tier with normalized
schema 156 and healthy workers. Public smoke and browser checks passed for
`/`, `/guest?table=W01`, `/reserve` and `/staff/live`.

The pre-cutover PostgreSQL backup is
`/opt/mbox/backups/mbox-20260901T200947Z-bf8TgZ.dump`. Its four-object OSS
upload/readback verification passed. Release evidence, image evidence,
deployment evidence and completion evidence also passed OSS readback. The
previous rc.167 application remains recoverable as
`mbox-app-rollback-a825ae9-20260902-041058`.

Post-cutover production readback confirmed:

- legacy forbidden product-snapshot rows decreased from 81 to 0;
- active normalized-name/specification duplicate groups decreased from 16 to
  0, and the partial uniqueness index is present;
- all 16 verified legacy products are inactive and hidden, all 16 canonical
  products remain active, and legacy bundle-component references are 0;
- all 65 available tables retain non-empty layout snapshots;
- all four Patron/培恩龙舌兰 bottle and glass products are active, guest
  visible, priced and backed by controlled menu images;
- all 30 active guest-visible bundles have a positive server-calculated saving;
- the reported Martell legacy product `P041B` is inactive, while the canonical
  `MB20260009` product remains active. Both public menu selection and order
  price locking require `status='active'`, so the inactive record cannot be
  displayed or ordered even though its historical visibility flag is retained
  for a later deliberate reactivation;
- the 156 active recipes still have their pre-existing empty instruction
  snapshots. This release does not invent missing instructions; it prevents
  future edits that do not include an instruction change from overwriting any
  stored instruction snapshot.

Tag CI run 33552421378 passed quality, clean migration, normalized database and
RLS tests, real HTTP workflows, mobile-browser flows, sustained 5 RPS checks,
immutable image construction and final evidence verification. Release workflow
33552421369 published the verified pre-release and transfer bundle.
