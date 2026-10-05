# iOS native audit wave 4 — 2026-10-05

This batch adds native staff workflows previously unavailable in iOS and repairs their shared session, pending-command recovery, navigation, scanning, and accessible presentation. It is committed from an immutable 303-file iOS snapshot; later marketing and reservation reception implementations remain outside this batch.

## Implemented scope

- Inventory setup/publication, recipe configuration, catalog/category configuration, product operations/phases, stock cost and speech drafts.
- Owner finance, customer content, media processing, device configuration, staff policies/settings and business reports.
- Member benefit wallet, cards, gifts, number/overview, membership configuration and recovery, coupon calendars/policies, loyalty operations/refunds, annual benefit policies and personal contact governance.
- Bottle storage, show catalog/requests, experience plans, service recovery, remake/handover, fulfillment history and physical kitchen state.
- Native push registration/lifecycle scaffolding with generation-safe authenticated transport; backend/provider, signing and delivery acceptance remain separate.
- Employee route/permission checks, session-generation guards, deterministic recovery JSON, payment versus table/inventory scanning rules, and durable original-request recovery.
- Large-text heading layout and complete year-bearing dates for membership, annual/contact workflows, audit history and policy windows.

## Reproducible validation

The original frozen snapshot ran 57/57 Foundation/core test groups successfully. Its first simulator Release build failed on three multi-variable `@State` declarations. Those declarations were corrected, then a 14-file display-only change made membership dates include the year. Both corrected snapshots completed actual simulator Release builds. No core model/request source changed between the 57-group pass and this final display delta.

Final evidence directory: `outputs/system-audit-20261005/ios-wave4-year-fixed`.

- iOS source files: 303; source and dependency manifest entries: 326.
- Full source/dependency manifest SHA-256: `5d3b231843df58e0c08113cb6f7d87f720bbbc735518367c1c3db7dc99b4ade1`.
- Release completion: 2026-10-05T12:13:00Z; exit 0; source manifest unchanged after build.
- Original matrix: `ios-wave4-115251Z`; initial failed build evidence is retained.
- Actual simulator membership visual review used real SwiftUI screens and a deny-by-default local transport fixture; default and accessibility text sizes were inspected. This was not a production interaction test.

## Remaining evidence boundaries

Marketing and the new reservation admission/whole-group seating workflows are subsequent batches. This batch does not provide an Apple-signed device build, App Store/TestFlight upload, physical-device installation, remote push delivery, payment, printer, or venue acceptance. The local signing inventory currently has no valid signing identity. Production backend and Android APK publication are tracked separately; this commit does not claim either. Supplier purchase returns are the only excluded functional scope.
