# iOS reception, marketing and private-record cleanup — 2026-10-05

This incremental batch completes marketing permission workflows and reception admission/whole-group seating, and fixes a shared private-record cleanup defect. It builds on PR340's immutable 303-file base and is frozen as a complete 323-file iOS snapshot.

## Workflows and original-request safety

- Marketing uses purpose-specific customer selection, notice publication and delivery/history permissions. Reading notices alone does not grant recipient/history access. Queue and date displays were inspected at default and accessibility text sizes.
- Reservation admission registers people, time and preferences without prebinding tables. Arrival seating selects the whole group of 1–20 real sessions, validates current table/location/guest versions and records any count difference. New protocol reservations require seating before completion. Original/current positions remain visible after a table move.
- New reception private payloads and validated acknowledgements are in device-only Keychain slots; the ordinary pending record contains bound references. Recovering a legacy `/native-reservations` record retains its original endpoint, key and schema. This does not retroactively encrypt every historical ordinary pending record.
- New operation readiness is bound to the last validated options/selection, employee/session/permission scope and a 30-second window; reading new reception data does not make a stale old reservation list fresh.

## Shared cleanup correction

Previously, ordinary pending records were deleted before best-effort `SecItemDelete` calls. A failed private-slot deletion could strand sensitive payroll, contact, membership, reservation, bottle, show or payment-code data without a cleanup entry point.

The generic cleanup service handles nine business families; reception uses a separate ticket service. Only allowlisted services and exact keys derived from the command UUID may be erased. No contact, PIN, request body or other private payload is copied into cleanup tickets.

Initialization persists a trusted no-HTTP ticket before any private payload is stored, then secures the ordinary pending record. On the initial submission attempt, HTTP is permitted only after initialization-ticket consumption is confirmed. A validated original response or definitive rejection persists an independently bound completion ticket before ordinary checkpointing. Cleanup deletes and reads back each private slot, removes the original ordinary pending file, then removes its ticket. While a trusted ticket survives, interrupted cleanup resumes locally. An uncertain transition with no surviving ticket retains the original request for explicit original-key recovery as described below; ordinary `completedSteps` or `rejected` flags cannot authorize erasure.

If initialization-ticket deletion succeeded but its readback failed, the secured original request remains pending. The local cleanup button performs no HTTP and cannot erase its private payload without a ticket. The original employee may explicitly recover using exactly the same key/body; no new request is manufactured. Temporary Keychain unavailability is separate from a corrupt pending file and has a local retry control.

## Fixed-source evidence

- Final snapshot: `outputs/system-audit-20261005/ios-final-integration-125110Z`, 323 iOS files. Its 195 application/project files exactly match the successfully built `ios-cleanup-ui-build-fixed-124527Z`; only three later test files differ.
- Actual simulator Release: passed, source hashes unchanged. An earlier real build failure from a missing `@MainActor` annotation was repaired and retained as evidence; Foundation/parse checks were not used as build proof.
- Reception: 106 core assertions, 179 actual AppModel assertions, 155 legacy reservation assertions passed.
- Generic cleanup: 756 core assertions, 54 actual AppModel fault assertions, 14 original management-session assertions passed. Final fault tests inject all Keychain services and network; ordinary-file deletion failures also use a real temporary immutable file.
- Marketing: 337 assertions / 15 recovery paths and server contract fixture passed. Shared AppModel, authentication race and navigation checks are recorded in the final snapshot's targeted-result file.

Simulator rendering, unsigned device archive, signed installation, remote delivery, real financial operations, paper output and venue acceptance remain distinct. No production business records were created to test this work. The only excluded business scope remains supplier purchase returns.
