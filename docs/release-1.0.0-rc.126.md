# M-BOX 1.0.0-rc.126

## Scope

This patch candidate supersedes `1.0.0-rc.125` and deploys the normalized staff
web and service bundle against the existing normalized schema `105`. It does not
build, upload or replace the native WeChat mini-program package.

## Staff authentication closure

- Every API module that resolves an employee session now classifies missing,
  conflicting and expired staff credentials as `401 AUTH_REQUIRED`.
- Activity operations, homepage content, media library, customer analytics,
  loyalty controls, membership configuration, personal-contact governance,
  promotions, staff recommendation changes and performance revisions share the
  same authentication response instead of leaking a false `500` service error.
- Permission denial remains a distinct `403`; input, conflict, idempotency and
  infrastructure failures keep their existing status and do not get hidden as
  authentication failures.
- A source-wide regression test fails if a new staff-context API is added
  without explicit authentication classification.

## Retained staff workspace closure

- Staff page state remains bound to both the authenticated employee and session,
  so a previous employee's entries cannot return after switching or navigating
  back to the workbench.
- Permission-derived entries remain aligned with the APIs and controls they
  open for payments, inventory, activities, content, loyalty, privacy and
  performance without relaxing mutation authority.

## Acceptance boundary

The exact candidate must pass deterministic, PostgreSQL, browser, load,
mini-program contract and immutable release checks. Production verification
must confirm schema `105`, the exact release SHA and image digest, worker health,
public browser routes and explicit `401` responses for unauthenticated staff
entry APIs. No real cash, provider payment, physical POS, printer output,
authenticated field shift or WeChat platform upload is claimed by these
automated checks.

## Production route

The public origin is `https://mbox.shmbox.com`. Production deployment must use
the immutable GitHub pre-release, the private application host at
`10.100.80.223:22` through its configured jump path, and the separate evidence
relay at `139.224.254.60:6122`.

## Deployment evidence

- Release commit: `d134f60a07efaf1acb22803819d87efc72384fd7`.
- Main CI `32668614404`, tag CI `32669026218` and release workflow
  `32669026219` completed successfully.
- GitHub pre-release: `v1.0.0-rc.126`; application asset digest
  `sha256:87d94270d40edf8d18249b1d39c98431ea7e2a702d797a71edfe008108d80046`.
- Production image: `mbox-normalized:1.0.0-rc.126-d134f60`; release image
  digest `sha256:7944b438db7c8457f3b9b638d9ed715d93796bcf28d39d19b0cc1a9961459b01`.
- Database schema remains `105`; the container is healthy, workers are healthy,
  strict inventory is active and normalized writes are enabled.
- Pre-cutover backup:
  `/opt/mbox/backups/mbox-20260823T220813Z-QL6TWg.dump`; rollback container:
  `mbox-app-rollback-d134f60-20260824-060911`.
- Independent evidence-relay verification completed 40 readiness requests with
  zero failures; `/`, `/guest?table=W01`, `/reserve` and `/staff/live` all
  returned the exact release build.
- Eleven staff-management read entrances and the staff performance-revision
  command returned `401 AUTH_REQUIRED` with no session; the three production
  endpoints that previously returned false `500` responses now classify the
  expired login correctly.
- Local exact-tree verification passed 956 non-database tests, 1109 PostgreSQL
  tests and 38 real-browser flows; all GitHub release gates independently
  repeated the quality, database, browser and sustained-load checks.
