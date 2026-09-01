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
enabled liquid items with historical bottle-based ledgers and positive package
volumes; 109 are referenced by 247 recipe-component rows across 155 enabled
products. This rules out a strict unit cutover without a separate physical
open-bottle count and migration plan.

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
