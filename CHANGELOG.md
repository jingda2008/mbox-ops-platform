# Changelog

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
