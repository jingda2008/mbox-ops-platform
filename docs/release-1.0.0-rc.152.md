# M-BOX 1.0.0-rc.152

## Scope

This candidate adds a server-authoritative, context-aware WeChat subscription
notification flow for member service events. It covers confirmed activity
registration, issued member benefits and membership-level changes. Every
notification request is optional: customer consent, WeChat availability,
template configuration and provider delivery are all handled without blocking
the underlying activity, benefit or membership transaction.

On the native mini-program, the subscription prompt is requested only after a
meaningful, related customer action. The decision service deduplicates prompts
across the first menu action, checkout, activity registration and coupon
entry, so an ordinary order journey cannot become a stream of unrelated
permission interruptions.

Migration 146 adds the normalized delivery ledger used for idempotency,
operator traceability and retry handling. It does not change balances, payment
settlement, activity inventory, existing member data or WeChat payment flows.

## Acceptance boundary

Focused notification and customer-funnel tests, the normalized build and the
release metadata checks passed locally before this release is tagged. CI still
binds the final code, migration, image and test execution to the immutable
release commit.

This candidate does not prove a real WeChat template delivery. That requires
the production template IDs and a real-device acceptance check after the
release is live. A missing or declined subscription authorization must leave
the original customer action successful and visible.

## Production route

Deploy only through the immutable-tag process: CI artifact verification,
database backup/readback, candidate health, Caddy cutover, rollback protection
and browser-semantic public-route checks. Record the deployed commit, image
digest, schema 146 and production readiness after the switch.

## Deployment evidence

Not yet deployed. Release evidence is complete only after the immutable tag
has passed CI and the production switch has been independently verified.
