# M-BOX 1.0.0-rc.94

## Scope

This candidate supersedes `1.0.0-rc.93`, whose immutable release image could
not be built because the staff web preview imported a logo from the
mini-program directory excluded from the Docker build context.

## Release packaging correction

- Places the circular M-BOX badge inside the normalized web source tree so the
  production image contains the exact asset used by the preview.
- Keeps the mini-program source directory excluded from the staff service and
  database image; this release does not pretend to upload or publish a WeChat
  mini-program package.

## Included business changes

- Adds 56 first-party menu images and matching inactive product drafts. The
  drafts remain hidden and cost-unapproved until real invoices, recipes, stock
  and physical output are verified.
- Adds authorized inventory recipe readback and editing for tracked products.
- Refines the customer home, menu browsing, member invitation, navigation and
  narrow-screen ordering experience while preserving explicit agreement before
  WeChat phone authorization.
- Defaults after-hours booking to the next bookable business date and lets
  authorized staff confirm future pending reservations without putting future
  confirmed reservations into the current-day arrival queue.

## Acceptance boundary

Production menu activation, WeChat platform upload/review, real-device phone
authorization, real payment and refund, simulated inventory evidence and
role-by-role store acceptance remain separate operating evidence.
