# M-BOX 1.0.0-rc.149

## Scope

This candidate supersedes the failed `1.0.0-rc.148` candidate. It aligns the
real-browser acceptance path with the approved text-only table-observation
workflow: the staff dialog must provide the one-line text input and must not
provide a voice-recording button, microphone notice, recorder or transcription
entry.

The included staff feature remains unchanged: authorized service staff can
read active-table order statuses without payment or customer data, while table
observations accept text and preserve existing historical records.

## Acceptance boundary

Focused server and UI tests, the corrected cross-surface contract test and the
real Playwright scenario against an isolated PostgreSQL database passed
locally. The Linux CI gate repeats the whole normalized database, browser,
performance and release bundle validation. No database migration is added; the
expected schema remains `145`.

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
