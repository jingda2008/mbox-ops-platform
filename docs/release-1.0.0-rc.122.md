# M-BOX 1.0.0-rc.122

## Scope

This candidate supersedes `1.0.0-rc.121` without changing its customer or
staff feature scope. It restores the immutable normalized migration prefix
already present in production and deploys the normalized staff web, service
and database bundle through migration `104`. The native WeChat mini-program
source remains outside the backend deployment and upload process.

## Migration lineage correction

- Keeps production migration `102_printer_management_permission.sql` at its
  original filename and exact SHA-256.
- Moves the not-yet-applied homepage content display mode to migration `103`.
- Moves the not-yet-applied Superhigh membership consent source to migration
  `104`.
- Anchors all three filenames and checksums in the migration baseline test so
  a later merge cannot reuse or renumber this production lineage unnoticed.

`rc.121` stopped at migration compatibility preflight before any database
write or traffic cutover. The active production release remained healthy and
unchanged.

## Retained operations changes

- Shows the real public menu while a trusted table QR waits for staff opening,
  with ordering disabled and an explicit instruction to contact service staff.
- Filters employee assisted ordering to products explicitly allowing the
  `staff_assisted` channel.
- Refreshes staff table summaries every 15 seconds while visible and reconciles
  open checkout payment state every two seconds.
- Restores 44px task, inventory, reservation and membership touch targets and
  updates the current automated acceptance contracts.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment must consume the
immutable GitHub pre-release and existing private-host/evidence-relay contract.
The native WeChat package remains a separate upload and review action.

## Immutable CI and performance evidence

- Main CI `32651260918`, tag CI `32651690411` and release workflow
  `32651690408` completed successfully for release SHA
  `5ec0e0581486d60bee4901c121c8e8e548f90287`.
- The tag quality ledger decision is `ALLOW` and the evidence is bound to the
  clean `v1.0.0-rc.122` source commit.
- Four isolated PostgreSQL scenarios sustained five arrivals per second for
  60 seconds each. The 2,400 resulting HTTP operations had zero errors, zero
  duplicate KDS claims and no final backlog.
- The worst scenario latency was order submission at p95 `53.65ms` and p99
  `63.19ms`. Database pool, transaction and query failures were all zero.

## Production deployment result

- The first `rc.122` activation stopped before database writes or traffic
  cutover because the active container was release `3b587e0` while the
  `current` and `.env` control pointers still referenced `e7efbd6`. The
  pre-existing active-release identity blocker worked as intended.
- The pointers were atomically reconciled to the observed healthy production
  release after its commit, image, schema, tier and worker identity were
  verified. The reconciliation evidence is retained on the production host.
- The second activation completed at `2026-08-23T16:50:25Z`, applying only
  migrations `103_home_content_display_mode.sql` and
  `104_membership_terms_community_source.sql`.
- Production now reports release SHA
  `5ec0e0581486d60bee4901c121c8e8e548f90287`, schema `104`, release image
  digest `sha256:bf63ab7a55f7f2ddc645b9961b55336ff1ab28da31d885056faae469c6b1d693`,
  strict inventory enforcement, enabled writes and healthy workers.
- External API and browser smoke checks passed for `/`, `/guest?table=W01`,
  `/reserve` and `/staff/live`.

## Remaining release boundary

The repository source and mini-program release contracts passed, but no
independently signed WeChat upload receipt, review approval, production release
receipt or iOS/Android real-device package evidence was supplied. The native
WeChat package therefore remains not uploaded and the commercial release gate
remains `DENY`.
