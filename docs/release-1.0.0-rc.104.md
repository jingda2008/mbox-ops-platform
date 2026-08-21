# M-BOX 1.0.0-rc.104

## Scope

This candidate updates the normalized staff web, service and database from the
current main branch. It adds migration `098_unpaid_order_cancellation.sql` and
the matching staff workflows. The release bundle deliberately excludes the
WeChat mini-program package, so deployment does not upload or overwrite the
customer mini-program.

## Operating closure

- Authorized cashiers and managers can cancel an unpaid order only after
  recording a typed reason and confirming the action. Pending or successful
  payment facts, any refund evidence, stale business dates and inconsistent
  delivered-item inventory all fail closed.
- Delivered items, consumed inventory and the source business date remain
  immutable facts. Only unfinished KDS work, unfinished order items and their
  still-reserved inventory are released.
- Prior-business-day unpaid orders remain visible in the cashier workbench, and
  authorized managers can cancel an obsolete carryover KDS task with a recorded
  reason instead of hiding or rewriting it.
- Tracked drinks become unavailable when their active recipe has insufficient
  unreserved inventory and recover automatically after stock is recorded.
  Products explicitly configured as `not_managed`, currently snacks and fruit,
  do not invent quantity inventory.
- Store provisioning verifies the exact configured role permissions and
  navigation after reconciliation so configuration drift blocks the release.

## Verification boundary

The candidate requires clean `001` through `098` migration, PostgreSQL/RLS,
unit, build, architecture and release-system evidence for its exact commit and
image. Real payment/refund settlement, production maintenance credentials,
backup restoration and post-cutover staff checks remain runtime deployment
evidence rather than claims derived from source tests.
