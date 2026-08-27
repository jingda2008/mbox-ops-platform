# M-BOX 1.0.0-rc.151

## Scope

This candidate supersedes `1.0.0-rc.150`. It keeps the native mini-program
flow in which a required paid Superhigh registration creates exactly one
idempotent registration and immediately presents the WeChat payment sheet.
Free, waitlist and explicit no-prepayment registrations remain outside that
payment path.

It also repairs the activity-registration expiry worker. Its audit and outbox
queries now cast values supplied to PostgreSQL's polymorphic JSON functions as
text. An expired registration whose provider result is still unknown can move
to the existing manual-review path without the worker failing with `42P08`.
No financial status, inventory reservation, idempotency key or registration
cycle rule is changed.

## Acceptance boundary

The focused worker suite covers release, confirmation and review branches and
asserts the explicit parameter types. The original failing audit statement was
reproduced on the production database inside a rolled-back transaction; the
corrected form completed for the same registration and was also rolled back.

The native customer-funnel test from rc.150 continues to prove one required
payment journey creates one registration, starts one payment and performs one
final query without an intermediate outcome modal. This candidate does not
prove actual fund settlement, WeChat review approval, or a real-device payment
outcome.

No database migration is added; normalized schema remains `145`.

## Production route

Deploy only through the immutable-tag process: CI, image verification,
backup/readback, candidate health, Caddy cutover, rollback protection and
public route checks. Record the deployed commit, image digest, schema `145`,
production tier and healthy-worker state after the switch.

## Deployment evidence

Not yet deployed. Release evidence is complete only after the immutable tag
has passed CI and the production switch has been independently verified.
