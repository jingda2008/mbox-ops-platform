# M-BOX 1.0.0-rc.91

## Scope

This source candidate contains customer mini-program improvements, staff
operating workflows, editable home content and mobile inventory receiving. The
deployable release bundle is intentionally limited to the normalized web app,
service and database; it does not upload, review or replace the WeChat
mini-program. It adds normalized migration 097 so stock behavior is explicit
per product instead of being inferred from product category or fulfillment
station.

## Customer experience

- Membership enrollment starts only after the customer actively checks the
  published agreements and invokes WeChat phone authorization. Declining the
  invitation still allows ordinary browsing and ordering.
- The mini-program home, menu entry, ordering layout and tab bar use restrained
  M-BOX branding, clearer touch targets and narrow-screen overflow protection.
- The member home avoids duplicating functions already present in other tabs
  and can expose staff-published activities and brand stories as editorial
  cards.

## Staff and content operations

- Staff shortcuts remain available after entering and leaving a work area, and
  employee switching returns through the explicit logout flow.
- Authorized staff can create, edit, publish, pause and list typed home-content
  cards without a code release. Customer projections use published scheduling
  and audience fields rather than arbitrary JSON decisions.
- Staff-assisted ordering and the new home-content flow retain server-side
  permission and idempotency boundaries.

## Inventory behavior

- Products now have a typed `tracked` or `not_managed` inventory-control mode.
  Tracked bar products still fail closed when their active recipe is missing;
  food and snack products configured as not managed do not create false stock
  shortages.
- Staff can use a phone camera to scan barcodes or QR codes while receiving
  tracked inventory, with manual entry retained as a controlled fallback.
- Purchase receipts can derive unit cost from quantity and total cost while
  preserving the recorded receipt total.

## Acceptance boundary

The code candidate, database migration and local upload-package checks do not
prove WeChat platform approval, a published mini-program version, production
payment settlement, refund completion or physical barcode-device acceptance.
Production deployment must pass required GitHub checks and the repository's
formal Alibaba Cloud release chain. WeChat upload and review remain a separate
platform-controlled release step.
