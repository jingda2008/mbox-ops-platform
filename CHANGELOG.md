# Changelog

## 1.0.0-rc.55 - 2026-07-29

- Replaced the public reservation form with a mobile-first three-step flow for date and party size, direct store assignment or self-selected seating, and final contact confirmation.
- Connected self-selected reservations to the official 61-table venue directory with live availability, occupied-table status, server-side collision protection and table release after cancellation.
- Added focused stage, indoor and outdoor map views, visible deposit and minimum-spend information, and fixed bottom actions without horizontal mobile overflow.
- Added manager task supervision actions for assisted completion, takeover and safe reassignment while preserving the original task, responsibility history and immutable audit events.
- Added database migration 021 for reservation assignment mode and requested-table projections, plus public-access, cross-client and manager-workflow regression coverage.

## 1.0.0-rc.54 - 2026-07-28

- Moved walk-in opening controls into the selected table area so employees choose party size and sales ownership without leaving the floor context.
- Kept employees on the live floor after a successful opening and automatically collapsed the completed selection.
- Separated store-wide management visibility from configured table-operating responsibility.
- Hid unassigned areas from the employee floor and enforced the same responsibility boundary for direct API and AI-assisted table openings.
- Updated shared menu-search browser acceptance to allow multiple relevant products while preserving exact specification search.

## 1.0.0-rc.53 - 2026-07-28

- Decoupled walk-in seating from public reservation-area preferences so formal venue tables can open even when their physical area is not a customer-selectable reservation option.
- Changed table capacity from a hard seating limit to an operational recommendation for walk-ins, reservations and waitlist guests.
- Added visible extra-seat feedback and immutable capacity, actual-party-size and extra-seat evidence to table-opening audits.
- Reset the suggested party size when employees switch tables to prevent the previous table's headcount from carrying into the next operation.

## 1.0.0-rc.52 - 2026-07-28

- Added configurable L0-L3 service workflows for zero-action guest context, one-tap quick service, two-step accountable tasks and controlled high-risk transactions.
- Added duplicate request merging, actual-completer evidence and safe backup or cross-area completion for configured low-risk services.
- Simplified table-context ordering, complimentary ordering, account access and busy-shift task presentation.
- Split fulfillment into ready-to-serve, made-to-order, service-only and no-fulfillment paths with combined completion and delivery for multi-role staff.
- Added normalized service and fulfillment projection fields plus migration 020.
- Retired I01-I03 and the legacy interactive area from runtime operations while retaining archived history for analysis.

## 1.0.0-rc.51 - 2026-07-28

- Restored the normal-order and complimentary-order controls as a consistent pair in staff-assisted ordering.
- Added explicit configuration guidance when an employee can see the complimentary-order control but lacks a valid personal authority.
- Extended known built-in M-BOX commerce authorities once so manager, supervisor and owner permissions no longer expire with the original seed shift.
- Preserved administrator-configured limits, product scopes, cumulative controls and later validity changes after the one-time migration.
- Allowed the system administrator to configure audited commerce authorities without granting payment or complimentary-order execution rights.
- Added browser coverage for 李艳, an authorized server and an unauthorized server, including the zero-payment complimentary workflow.

## 1.0.0-rc.50 - 2026-07-28

- Added the venue-owned 2026 floor plan and a configurable 61-table catalogue covering VIP, L, A, B, C, S, special and outdoor areas.
- Corrected the duplicated W5 and W10 labels in the supplied visual source to unique W06 and W11 table codes.
- Added a non-destructive layout migration that preserves occupied and reserved tables, retains legacy I tables until idle and expands staff area assignments.
- Integrated the previously unshipped configurable employee gift-policy controls and protected fullscreen staff-assisted ordering.
- Updated the service worker media policy and responsive layout presentation for the new floor-plan asset.

## 1.0.0-rc.49 - 2026-07-28

- Fixed configuration draft saves when legacy service types omit the optional guest-visibility field.
- Preserved the distinction between an omitted visibility setting and an explicit true or false value without introducing non-serializable runtime fields.
- Added a regression test that saves the same configuration shape used by live operations and verifies the complete runtime state remains PostgreSQL-serializable.

## 1.0.0-rc.48 - 2026-07-28

- Fixed the guest all-drinks view so category-compatible products remain visible even when legacy or imported records are missing a beverage-family value.
- Added deterministic beverage-family inference plus server-side validation that prevents new guest-visible drink products from being published without a specific drink type.
- Replaced the misleading empty menu shown for expired or revoked table sessions with a dedicated full-width rescan state.
- Constrained the guest ordering shell and menu workspace to the mobile viewport, with WeChat Android browser coverage for category changes and horizontal overflow.
- Made Playwright API and web ports configurable so concurrent worktrees can run isolated browser verification.

## 1.0.0-rc.47 - 2026-07-27

- Added an optional order-level fulfillment note to guest and staff-assisted ordering, with a 300-character server-side limit and idempotency conflict protection.
- Propagated one immutable note snapshot through the order, KDS tasks, delivery task, print jobs, cashier table account and guest order history.
- Highlighted important notes at every responsible handoff so bar, kitchen, runner, cashier and manager can see the same instruction without relying on verbal relay.
- Added integration coverage for guest ordering, staff-assisted ordering, KDS creation, print jobs and delivery task propagation.

## 1.0.0-rc.46 - 2026-07-27

- Added the customer menu sales path with three comparable tonight recommendations, optional quick selection, restrained shake discovery, normal category browsing, search and product details.
- Added a versioned 81-product V2/V3 menu catalog, real cocktail and bottle costs, conservative food/component cost caps and automatic bundle cost rollups.
- Added one-time catalog migration with SKU upsert, valid bundle references, audit evidence and protection for later administrator changes.
- Expanded bundle orders into auditable fulfillment component lines without double-counting customer revenue, discounts or performance attribution.
- Added guest recommendation behavior events for impressions, answers, reranking, product details, acceptance and cart abandonment.
- Improved menu and product administration, mobile quantity controls, combination presentation and customer/staff ordering layouts.

## 1.0.0-rc.45 - 2026-07-26

- Added permission-scoped conversational operations analytics for natural-language management queries without exposing unrestricted SQL.
- Added migration `018_analytics_query_foundation.sql` and normalized analytics indexes for business-day, table, product, customer and employee dimensions.
- Made high-frequency guest, reservation and waitlist actions respond immediately while preserving asynchronous submission, idempotency and failure recovery.
- Refined customer haptics so browsing and quantity changes remain quiet while deliberate service, order, song and payment confirmations use restrained feedback.
- Added release metadata gates that keep package, lockfile, release notes, changelog and Git tags aligned before a release can pass CI.
- Added tag-triggered CI and automatic GitHub pre-release creation after all checks, browser flows, database verification and container build succeed.

## 1.0.0-rc.1 - 2026-07-14

- Delivered configurable service SOPs, table responsibility routing, proactive not-ordered care, complaints, customer feedback, and SLA escalation.
- Delivered order/KDS/table ledger, configurable discount and gift authority, payment/refund evidence, physical POS reporting, member benefits, notifications, paid songs, reservations, inventory, and bottle storage.
- Added signed table QR sessions, production employee sessions, WeChat identity boundary, mini-program customer flows, and responsive PC/tablet/mobile operation surfaces.
- Added PostgreSQL migrations with forced RLS, CAS aggregate storage, immutable revision journal, migration checksums, backup/restore, non-root container, CI, metrics, and readiness probes.
- Added inventory consumption for managed sale and gift orders with transaction rollback and idempotent replay.

This is a release candidate for controlled staging and store shadow operation. Payment-provider live money tests, WeChat review, cloud TLS/PITR, external security assessment, formal master-data import, and store acceptance remain release gates.
