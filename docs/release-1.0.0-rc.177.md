# M-BOX 1.0.0-rc.177

## Scope

This candidate preserves the rc.176 payment recovery, staff authorization,
overcollection and responsive-page repairs. It corrects the immutable
LuJiazui store configuration identity that stopped the first production
activation before application cutover.

The role document changed in rc.176 while retaining configuration version
`2026.09.07-v19`. Production correctly refused to overwrite an existing
version with different content. This candidate advances the document to
`2026.09.07-v20` and adds an append-only checksum ledger to the release
metadata gate. Future edits that forget to allocate a new configuration
version now fail before a tag or production transaction is created.

The failed rc.176 activation left the public rc.175 application healthy. Its
forward-compatible schema migration 158 completed, while the changed store
configuration and rc.176 application image were not activated. rc.177 must
therefore verify the existing schema-158 state, create a fresh predeployment
backup and pass the same immutable release transaction before cutover.

## Payment authority

An unresolved online attempt may be explicitly released from its operational
slot without being deleted or marked failed. Any active employee who already
has access to the order may initiate another approved collection. Only enough
authoritative successful receipts stop further attempts. Every late success is
preserved; excess receipt becomes auditable overcollection and a refund task,
without duplicating revenue, fulfilment, inventory consumption or benefits.

## Acceptance boundary

Automated acceptance must cover unit, PostgreSQL, isolated HTTP, browser,
responsive viewport, Mini Program and sustained-load gates on the exact merged
commit. Production deployment must use the verified release script, backup and
OSS readback, exact image digest, schema 158, healthy workers and public deep
links. The native WeChat Mini Program source changed in the inherited rc.176
scope, so a separately evidenced Developer Tools upload and experience-version
selection are required.

Real WeChat/StarPay money, refund arrival, cash/POS reconciliation, physical
printer/KDS, Android and iOS WeChat devices, and real store-role exercises
remain external acceptance items. Android App packaging remains out of scope.
Commercial readiness therefore remains `DENY` until those items are closed.
