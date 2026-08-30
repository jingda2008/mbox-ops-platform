# M-BOX 1.0.0-rc.163

## Scope

This candidate contains PR #152 on top of the rc.162 production baseline. It
adds a shared presentation layer for inventory quantities, units, categories,
unit costs and business references. The active `NormalizedStaffApp` receiving,
inventory, count, waste, cost-correction, barcode and product-publication paths
now render readable Chinese values rather than raw database decimals or internal
unit and category codes.

The same contract covers catalog recipes, activity-package materials, guest
order results and public reservation references. Unknown or invalid display
values fail to a neutral label instead of inventing a business meaning. Full
identifiers and exact cost facts remain available to server, cashier, privacy,
audit and reconciliation paths.

## Acceptance boundary

The feature commit passed local web type checking and production build, six
targeted Vitest files with 31 assertions, 128-file mini-program static checks
and 82 mini-program release-candidate tests. PR #152 passed GitHub quality,
isolated PostgreSQL, normalized browser, sustained performance and aggregate
verification gates. The browser gate explicitly verifies that the compact
reservation reference remains visible while the full internal identifier is not
rendered.

There are no schema migrations and no changes to inventory quantities, costs,
orders, payments or audit facts. The native mini-program source includes the
activity registration reference display adjustment, but this backend/web release
does not claim a WeChat DevTools upload, review or production mini-program
release. Huawei X5, real staff-role reading and physical inventory reconciliation
remain separate acceptance work. Commercial release remains denied by the
outstanding operating checklist.

## Production route

Deploy only from immutable tag `v1.0.0-rc.163` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. The production
transaction must retain the rc.162 service until configuration, backup/readback,
candidate health, traffic cutover and formal-route verification all succeed.
