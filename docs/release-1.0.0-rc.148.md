# M-BOX 1.0.0-rc.148

## Scope

This candidate supersedes the failed `1.0.0-rc.147` release candidate. It
corrects the cross-surface contract so table observation tests enforce the
approved text-only workflow: the table sheet must not contain a voice-recording
label, browser recorder, browser speech recognition or transcription call.

The underlying `rc.147` feature remains included: authorized service staff can
read active-table order statuses without payment or customer data, and the
table-observation sheet accepts text while preserving historical records.

## Acceptance boundary

The corrected mini-program/staff contract test, focused table-status tests,
type checks, normalized unit suite and production build passed locally. The
release-lock shell test requires Linux `flock`, which is unavailable in the
macOS development environment and is therefore verified by the Linux CI gate.
No database migration is added; the expected schema remains `145`.

This release does not itself prove a real service shift, device login,
collection, refund settlement or WeChat payment outcome. Those remain
controlled production acceptance work with the applicable staff roles and
external providers.

## Production route

Deploy only through the approved release script with immutable tag and image
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route checks. Post-switch evidence must record the exact
commit, image digest, schema `145`, production tier and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
