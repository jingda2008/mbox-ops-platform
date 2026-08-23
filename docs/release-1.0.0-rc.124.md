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
