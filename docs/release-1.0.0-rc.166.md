# M-BOX 1.0.0-rc.166

## Scope

This candidate changes the employee-facing quantity contract for liquid
inventory. Recipe composition, physical stock counts and waste are entered and
displayed in millilitres with visible units. Existing production liquid items
remain stored in their historical bottle-based ledger and are converted only at
the user-interface boundary using the item's recorded package volume. A 700 ml
item stored as 0.064 bottle therefore reads as 44.8 ml, while an employee entry
of 45 ml is stored as 0.064286 bottle.

New liquid inventory items must use `ml` as their base unit and retain a positive
package volume. Existing bottle-based liquid items cannot evade conversion by
being moved to a non-liquid category. Receiving continues to use package or
base-unit quantities, and sale specifications remain bottle, glass, shot or
cocktail where appropriate. The release does not rewrite current balances,
recipes, costs, movements or historical order facts.

The candidate also includes the main-branch WeChat subscription-template
updates since rc.165. Reservation submission prioritizes the published arrival
template, while Superhigh activity registration prioritizes registration,
performance-start and schedule-change templates. Normalized migration 155
updates those policy rows; no inventory migration is included.

## Acceptance boundary

Production was inspected read-only before implementation. It contains 110
active liquid items with historical bottle-based ledgers and positive package
volumes; 109 are referenced by 247 active-recipe component rows across 155
products, of which 153 are currently active and two are inactive. This rules
out a strict unit cutover without a separate physical open-bottle count and
migration plan.

Automated coverage verifies exact decimal conversion, recipe read/write,
stock-count and waste submission, legacy order consumption, receiving,
barcode use, compatible metadata edits, category-escape rejection and visible
numeric-unit suffixes. The repository-wide check passes. An isolated PostgreSQL
run passes 1,332 tests with one environment-specific skip, and pull-request
quality, PostgreSQL, real-browser, sustained-performance and aggregate gates
pass. The real-browser gate was repeated after one noisy guest-startup P95 run;
the identical commit passed on rerun.

The native Mini Program source checks remain green, but this release does not
upload or publish a new native Mini Program package. Final field acceptance
still requires an authorized employee to verify one known 700 ml recipe, one
stock count and one waste entry against the physical bottle remainder.

## Production route

Deploy only from immutable tag `v1.0.0-rc.166` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. Keep rc.165
recoverable until backup and restore metadata, migration 155, candidate health,
Caddy cutover, public readiness, worker health and the four browser routes are
verified. Roll back the application image if needed; do not reverse migration
155 or overwrite inventory and order facts.

## Production deployment

Production deployment completed at `2026-09-01T03:10:19Z` from immutable tag
`v1.0.0-rc.166` and commit
`f8d72a273bc6343b55328c93ad9518fc30bf053c`. Tag CI run `33464367949` and
release run `33464367895` both succeeded. The deployed image digest is
`sha256:7b8fc226cb62e70f0162cf86788040cab03b93b3834b37e6619a7d10fbf5bf94`.

The deployment created backup
`/opt/mbox/backups/mbox-20260901T030904Z-wkxXmV.dump`, applied migration 155,
verified the candidate, switched Caddy and archived predeployment, backup,
deployment and completion evidence through the OSS relay. Public readiness
reports production tier, schema 155, strict inventory, writes enabled and a
healthy worker. Both API and real-browser verification passed for `/`,
`/guest?table=W01`, `/reserve` and `/staff/live`.

A post-cutover read-only audit still finds all 110 historical bottle-ledger
liquid items with positive capacity and nonzero balance, no reserved liquid
inventory and no activity-package liquid reference. The compatibility release
therefore did not stand in for a physical open-bottle migration. Native Mini
Program upload and authorized employee field acceptance remain outside this
deployment.
