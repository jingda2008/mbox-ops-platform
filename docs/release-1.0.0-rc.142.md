# M-BOX 1.0.0-rc.142

## Scope

This candidate supersedes `1.0.0-rc.141` for the staff Web surface. It makes
the membership and customer-experience workspaces usable on staff tablets and
compact phones: dense forms reflow, action groups stay reachable, and the
membership configuration navigation no longer depends on horizontal scrolling.

The release corrects a layout defect in summary panels that do not have a
leading icon: the generic summary grid reserved an icon column and could
squeeze their only content column. It changes no membership data, policy,
benefit, permission, payment, refund, inventory, table-turnover or database
business rule.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and the normal fresh
PostgreSQL migration gate through schema `143`. Local verification covers the
membership layout contract, Web type checking, normalized Web build and the
320 px real-employee route sweep including all eight membership entries.

Local/browser validation does not prove native WeChat, real payment channels,
physical POS, printing hardware or staffed field acceptance.

## Production route

Deployment uses the approved release script with backup/readback, candidate
health, Caddy cutover, rollback safeguards and public route verification.
Post-switch evidence must confirm the exact commit, image digest, schema `143`
and worker health. This release does not build, upload or replace the native
WeChat mini-program package.

## Deployment evidence

Not yet deployed. The immutable tag, CI, image, backup/readback and
post-switch evidence will be recorded only after the candidate passes the
release gate.
