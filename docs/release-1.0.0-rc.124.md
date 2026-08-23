# M-BOX 1.0.0-rc.124

## Scope

This patch candidate supersedes `1.0.0-rc.123` and deploys the normalized staff
web and service bundle against the existing normalized schema `105`. It does not
build, upload or replace the native WeChat mini-program package.

## Device and printing authorization response

- Missing, malformed or expired employee sessions now receive an explicit
  `401 AUTH_REQUIRED` response from printer-route and print-bridge management
  endpoints.
- Authenticated employees without the required effective permission continue to
  receive `403`; valid print-bridge device credentials remain a separate
  authentication boundary.
- The change prevents normal login expiry from being misreported as a `500`
  device-service outage and does not relax API authorization.

## Unchanged operating boundary

- Direct cash and physical POS collection remain limited to ordinary unpaid
  orders; provider-started or unknown online payments remain blocked pending an
  authoritative channel result.
- Role grants, personal grants and personal denials still determine effective
  module entry and direct-route access.
- Windows print bridge pairing, routing, leases, retry and audit behavior remain
  on schema `105`; no migration is added by this patch.

## Acceptance boundary

The focused response-contract tests must pass locally and the full deterministic,
PostgreSQL, browser, load, image and release checks must pass again for the exact
`rc.124` commit. Public verification must confirm schema `105`, the exact release
SHA and `401` responses for both unauthenticated management endpoints. Real cash,
physical POS and printer output remain field acceptance and must not be simulated
as received funds or printed paper.

## Production route

The public origin is `https://mbox.shmbox.com`. Production deployment must use
the immutable GitHub pre-release, the private application host at
`10.100.80.223:22` through its configured jump path, and the separate evidence
relay at `139.224.254.60:6122`.

## Verified deployment evidence

- Main CI `32661896113`, tag CI `32662338043` and release workflow
  `32662338040` completed successfully for commit
  `518dd69b1b070466a816730ba30df77af7d482a6`.
- Production activated image digest
  `sha256:2c8993b002a192d69a2dcd68174f16e37b398671bba52febb5393dc1a9b40ed6`
  at `2026-08-23T19:59:14Z`; schema remained `105` and a verified backup was
  retained at `/opt/mbox/backups/mbox-20260823T195812Z-aK0apj.dump`.
- Release smoke and real-browser checks passed for `/`, `/guest?table=W01`,
  `/reserve` and `/staff/live`. A separate internet host then completed 70
  repeated public route, readiness and unauthenticated printer-management
  checks with zero failures.
- Both `/api/hardware/print-bridges` and `/api/hardware/printer-routes` returned
  `401 AUTH_REQUIRED`; the payment and print-bridge credential boundaries also
  rejected empty unauthenticated requests with `401`.
- DNS resolved the public origin to `139.196.99.138`, HTTP redirected to HTTPS,
  and the deployed TLS certificate for `mbox.shmbox.com` was valid through
  `2027-02-28`.

This evidence proves the deployed software and public authorization response.
It does not prove cash was physically received, a physical POS completed, paper
was printed, or the native WeChat package was uploaded; those remain separate
field and platform acceptance actions.
