# M-BOX 1.0.0-rc.154

## Scope

This candidate supersedes the failed `1.0.0-rc.153` candidate. It corrects two
release-contract gaps introduced with the contextual WeChat member-service
notification feature: the normalized migration baseline now includes migration
146, and the profile no longer presents a generic notification-settings entry.

The notification service remains context-driven. A customer can be offered an
optional activity, benefit or membership notice only while taking a directly
related action. Declining, closing or lacking WeChat subscription support never
blocks the original registration, order or payment-recovery action.

No database migration changes are made in this candidate; schema migration 146
is unchanged. There is no change to payment settlement, activity inventory or
member balances.

## Acceptance boundary

The full normalized test suite passes locally: 184 test files passed, 1,120
tests passed and 60 intentionally skipped. The targeted mini-program activity
sharing and table-payment scope regressions also pass. The mini-program release
suite is run from a clean checkout to exclude developer-private WeChat files.

This candidate does not prove real WeChat template delivery. Production
template IDs and a real-device acceptance check remain necessary after
deployment; missing authorization must leave the related customer action
successful.

## Production route

Deploy only through the immutable-tag process: CI artifact verification,
database backup/readback, candidate health, Caddy cutover, rollback protection
and browser-semantic public-route checks. Record the deployed commit, image
digest, schema 146 and production readiness after the switch.

## Deployment evidence

Not yet deployed. Release evidence is complete only after the immutable tag
has passed CI and the production switch has been independently verified.
