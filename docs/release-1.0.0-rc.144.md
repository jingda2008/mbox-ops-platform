# M-BOX 1.0.0-rc.144

## Scope

This candidate supersedes `1.0.0-rc.143` for payment recovery and financial
attribution safety. It unifies the encrypted WeChat mini-program payer
identity used by paid activity registration and scanned-table ordering,
prevents invisible customer QR fallback, and makes payment recovery query and
close the provider order before a collection method can change.

It also introduces normalized migration `145`. Activity-payment rows now have
an immutable registration-cycle attribution. A late provider success from a
closed earlier cycle remains an auditable financial fact, is not assigned to a
reopened registration cycle or its loyalty promotion fact, and must be
refunded before further collection.

## Acceptance boundary

Local evidence covers a fresh PostgreSQL migration through schema `145`, a
144-to-145 historical-payment upgrade fixture, payment command/API contracts,
mini-program static contracts, Web type checks and the production Web build.

Before activation, the immutable tag must pass release CI and the approved
release procedure must create a backup/readback report. Real WeChat JSAPI,
provider query/close, refund callback, staff QR/POS, printer and on-site
turnover flows still require controlled production acceptance. This candidate
does not by itself upload or release a native WeChat mini-program package.

## Production route

Deploy only through the approved release script with migration checksum
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route verification. Post-switch evidence must record
the exact commit, image digest, schema `145` and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
