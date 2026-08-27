# M-BOX 1.0.0-rc.150

## Scope

This candidate supersedes `1.0.0-rc.149` for the native M-BOX mini-program.
For a required paid Superhigh registration, the primary “submit registration
and pay” action now creates the server-authoritative, idempotent registration
and immediately presents the corresponding WeChat payment sheet. Customers no
longer need to find and tap a separate “continue payment” button after their
seat is held.

Free registrations, waitlist registrations, and the explicit “do not prepay”
option remain non-payment paths. The native WeChat payment confirmation and
the query-first handling of cancelled, failed or unknown payment results stay
in place; this candidate never treats a client callback as settled funds.

## Acceptance boundary

The mini-program flow test proves one required-payment journey creates exactly
one registration, one payment action, one native payment request and one final
payment query. It also proves no intermediate outcome modal interrupts that
path. The release candidate package excludes developer-private configuration.

No database migration is added; the expected normalized schema remains `145`.
The candidate does not itself establish a real payment settlement, WeChat
review approval or real-device production payment outcome.

## Production route

Deploy only through the approved immutable-tag release process with image
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route checks. Record the actual commit, image digest,
schema `145`, production tier and worker health after the switch.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence are recorded only after the release gate passes.
