# Changelog

## 1.0.0-rc.63 - 2026-07-31

- Applied role-focused navigation to the desktop sidebar instead of limiting the simplification to the home page and mobile bottom bar.
- Kept home and each role's two to four primary modules visible while moving all other authorized modules into an explicit expandable section.
- Preserved full authorization and direct metric, task, voice and programmatic navigation to secondary modules.
- Automatically expanded secondary navigation when a low-frequency module became active and collapsed it again after returning to primary work.
- Hardened mobile drawer navigation so complete authorized modules remain reachable without repeated menu clicks or off-screen controls.
- Added desktop manager navigation regression coverage and shared browser helpers for primary and secondary role navigation.

## 1.0.0-rc.62 - 2026-07-31

- Separated each role's primary mobile navigation from its complete authorized module set so frequent work stays within two to four visible entries without removing legitimate access.
- Added a fixed role-aware mobile navigation bar with a compact overflow entry for infrequent authorized modules.
- Focused execution roles on their own occupied, reserved or attention-required tables while keeping other active and empty tables available through explicit expansion controls.
- Reduced mobile header, metric, action and empty-state height so the current task, responsible tables and support actions remain visible with less scrolling.
- Added dedicated stage, technical and marketing role profiles, navigation priorities and operational metrics.
- Hid inventory, payment and member-benefit controls that the signed-in employee cannot execute while retaining server-side permission enforcement.
- Corrected server responsibility metrics so assigned empty tables no longer inflate the active-table count.
- Added unit and browser regression coverage for role entry limits, mobile overflow, table focus and permission-specific control visibility.

## 1.0.0-rc.61 - 2026-07-31

- Required staff to select and confirm an open table before entering full-screen assisted ordering.
- Locked the confirmed table throughout ordering, blocked silent table switching and required the signed-in employee's PIN to exit before selecting another table.
- Cleared the unsubmitted cart and table selection after a verified exit, while allowing table-specific shortcuts to prefill but not bypass confirmation.
- Changed guest mood selections from service tasks into visit-scoped table context so staff can see the signal without receiving duplicate work.
- Added structured collaboration guidance and automatic reveal behavior when an employee action requires a manager or another role.
- Expanded customer behavior, unreasonable-request, simulated-payment and complex-refund regression evidence without allowing those requests to bypass price, gift, refund or authorization controls.
- Added browser coverage for table locking, PIN-protected reselection, complimentary ordering, payment handoff, responsive layouts and cross-role fulfillment.

## 1.0.0-rc.60 - 2026-07-30

- Added explicit “immediate payment” and “table tab” choices to staff-assisted ordering; table-tab orders enter fulfillment without creating a payment intent and remain collectible before table close.
- Added auditable refund outcomes for cancelling billed items, retaining fulfilled items as service recovery, or reopening the exact refunded receivable for a replacement payment.
- Linked replacement payments to their source refund, blocked duplicate active recollection, blocked table close until recollection succeeds and allowed a safe retry after a failed or expired recollection attempt.
- Preserved human refund approval, requester/approver separation, configured approval limits and provider or physical-POS confirmation requirements.
- Fixed quick-selection answers being scored correctly but then hidden by a price-midpoint comparison layout that kept the same product in the primary position.
- Made the highest rule-ranked eligible bundle the visible primary recommendation while retaining a lower-priced comparison when available.
- Limited the “more complete” role to an explicitly configured upgrade and labelled other higher-priced choices as alternatives instead of inventing an upgrade.
- Added production-like two-person recommendation coverage proving relaxed/refreshing and ritual/layered answers produce different primary products and comparison sets.
- Strengthened the guest browser flow to assert the rendered recommendation names change after materially different quick-selection answers.

## 1.0.0-rc.59 - 2026-07-30

- Made menu search immediately available on every guest ordering view, with a visually distinct search shortcut and global matching across product names, SKUs, categories, specifications, descriptions and tags.
- Added an optional one-tap opening scene for walk-in tables covering date, friends, brothers, besties, business and celebration.
- Persisted the selected scene as an immutable visit-scoped table-operation snapshot, exposed it to the guest session and used it together with party size in deterministic menu recommendation ranking.
- Extended the server-side AI `table.open` tool so natural commands such as “L01两位约会开台” preserve the same scene instead of bypassing recommendation context.
- Kept opening fully functional when staff skip the scene, retained the scene across table transfer through the table session and prevented previous-visit context from leaking into a reopened table.
- Replaced brittle browser assertions tied to retired product names with behavior-based recommendation, search and product-detail acceptance.

## 1.0.0-rc.58 - 2026-07-30

- Hid refund approval actions unless the current employee is not the requester, has approval permission and has a sufficient configured refund limit.
- Added explicit current-limit and eligible-approver guidance for refunds that exceed the signed-in employee's authority.
- Added regression coverage for requester separation, zero-limit administrators and sufficient-limit owners.
- Replaced a TypeScript parameter-property declaration in the hardware business error with equivalent explicit fields so strict TypeScript 6 production builds remain reproducible.

## 1.0.0-rc.57 - 2026-07-30

- Restored actionable refund review in the staging payment simulator while preserving requester/approver separation, approval limits and explicit human confirmation.
- Added clear pending-refund and eligible-approver guidance instead of generic quantity validation errors or silent unavailable actions.
- Prevented administrators without finance permissions from seeing or executing cash-collection actions in payment pages and AI plans.
- Classified cash collection slips as protected human finance workflows, including natural-language requests to create or generate them.
- Removed acknowledged reservation incidents from the active AI duty-manager warning and planning context while retaining them in handover records.
- Added browser and API regression coverage for administrator cash-command rejection, refund duplication, reservation resolution and role-aware payment controls.

## 1.0.0-rc.56 - 2026-07-29

- Rebuilt public reservation seating around proportional zone frames so floor-plan crops and table overlays remain aligned on mobile without horizontal scrolling.
- Corrected S01-S07 overlay identifiers and separated the indoor floor from the W01-W17 outdoor area.
- Added an indoor overview, a focused stage-side view and an outdoor view with compact density-aware status markers.
- Reduced reservation header and instruction height, kept table details and primary actions in the mobile viewport, and automatically revealed the selected table's availability, deposit and minimum-spend details.
- Extended 390x844 browser coverage for S-table visibility, indoor/outdoor isolation, map bounds and selected-table detail visibility.

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
