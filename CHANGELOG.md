# Changelog

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
