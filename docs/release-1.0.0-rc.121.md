# M-BOX 1.0.0-rc.121

## Scope

This candidate supersedes `1.0.0-rc.120`. It deploys the normalized staff web,
service and database bundle through migration `104`. It also records the native
WeChat mini-program source changes, but the backend release bundle does not
build, upload or overwrite the WeChat mini-program package.

## Customer and staff operations

- Keeps the real public menu visible after a fixed table QR is recognized but
  still waiting for staff to open the table, with the explicit instruction to
  contact service staff; ordering remains disabled until the session is active.
- Restricts employee assisted ordering to products that explicitly allow the
  `staff_assisted` channel while retaining the server-side channel check.
- Refreshes staff workspace summaries every 15 seconds while visible and
  reconciles the open checkout result with the authoritative table-order
  payment state every two seconds.
- Restores at least 44px touch targets for task resolution, reservation ranges,
  inventory selling flow and the mini-program membership consent preview.

## Acceptance and evidence

- Updates browser acceptance to the current inventory workflow, two-step table
  closing, read-only cross-station fulfillment view, compact horizontal member
  content cards and current activity/profile labels.
- Generates the version-scoped TC execution register, blocker register and
  execution report without claiming unfinished field or payment cases passed.
- Keeps commercial production approval denied until the existing real-payment,
  field, device and recovery evidence gates are completed.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment must use the immutable
GitHub pre-release and the existing private-host/evidence-relay contract. The
native WeChat package remains a separate upload and review action.
