# M-BOX 1.0.0-rc.162

## Scope

This candidate contains PR #149 on top of the rc.161 baseline. It makes normal
inventory receiving record only the factual inputs a staff member has: the
package count or measured quantity and the actual total paid for that receipt.
The server derives the base-unit cost and maintains the current moving weighted
cost.

Tracked drink, recipe and bundle costs now follow that inventory basis
automatically. A single glass, a whole bottle and a bundle therefore use the
same source facts; manual product-cost writes cannot bypass the calculation.
When a source cost is not trustworthy, the system preserves an explicit
incomplete state rather than inventing a zero. Selling and fulfillment remain
available, while the affected margin is visibly incomplete.

Cost correction is an exceptional, permissioned action. It requires a reason,
records the prior and corrected values in append-only audit data, and refreshes
the downstream recipe and bundle cost. Historical order snapshots are not
rewritten. Existing bottle-count stock is not silently reinterpreted as ml; a
replacement material and an explicit inventory migration are required.

## Acceptance boundary

The feature commit passed local production-build, static checks and a clean
PostgreSQL run of migrations 001–154 with 1,323 passing scenarios. PR #149
also passed GitHub quality, normalized-database/HTTP, browser and sustained
load gates.

This proves the implementation and isolated-data behavior. It does not turn
unverified historical stock into confirmed financial facts or prove a live
supplier receipt, physical stock count, payment-provider callback or printer
output. After rollout, stock marked “待核对” needs an actual receipt or an
audited correction before its margin becomes complete.

## Production route

Deploy only from immutable tag `v1.0.0-rc.162` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. The production
transaction performs configuration and migration compatibility checks, a
backup/readback, zero-traffic candidate checks, traffic cutover and formal
route verification. A failed gate keeps the preceding immutable release
active.
