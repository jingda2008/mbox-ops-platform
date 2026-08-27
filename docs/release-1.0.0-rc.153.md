# M-BOX 1.0.0-rc.153

## Scope

This candidate supersedes the failed `1.0.0-rc.152` candidate without changing
its member-service notification design or database migration. It completes the
test-only mini-program VM environments used by the activity-share and
table-scope recovery suites. Those environments now explicitly supply the
optional contextual subscription prompt and request utility, matching the
actual page dependency contract.

The customer-facing behavior remains unchanged: a contextual subscription
request is optional, is related to a direct customer action, is deduplicated,
and must never block activity registration, menu selection, checkout or a
payment recovery. Schema migration 146 remains the only added schema change.

## Acceptance boundary

The previously failing activity-share and table-scope suites pass after the
test-contract correction. The complete mini-program release suite is then run
from a clean checkout so no developer-private WeChat configuration can enter
the candidate package. CI still binds the final code, migration, image and
test execution to this immutable release commit.

This candidate does not prove a real WeChat template delivery. That requires
production template IDs and real-device acceptance after deployment. A missing
or declined subscription authorization must leave the original customer action
successful and visible.

## Production route

Deploy only through the immutable-tag process: CI artifact verification,
database backup/readback, candidate health, Caddy cutover, rollback protection
and browser-semantic public-route checks. Record the deployed commit, image
digest, schema 146 and production readiness after the switch.

## Deployment evidence

Not yet deployed. Release evidence is complete only after the immutable tag
has passed CI and the production switch has been independently verified.
