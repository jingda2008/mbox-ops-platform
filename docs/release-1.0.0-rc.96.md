# M-BOX 1.0.0-rc.96

## Scope

This candidate supersedes `1.0.0-rc.95`. The `rc.95` tag passed database,
quality, sustained-load and 37 business browser checks, but its employee first
paint exceeded the unchanged 500 ms p95 gate on two tag-CI attempts.

## Staff startup correction

- Loads the authenticated employee session and the server-filtered workspace
  in parallel instead of serially.
- Reuses the prefetched workspace for the first paint without weakening the
  session or permission checks.
- Recreates the workspace when employees switch, preventing stale navigation
  or operating data from the previous role.
- Keeps the existing 500 ms p95 and 1,000 ms p99 release thresholds unchanged.
  A local isolated PostgreSQL run completed all 30 employee and 30 guest
  samples with employee p95 104.8 ms and guest p95 74.5 ms.

## Included business changes

This candidate retains the menu drafts, inventory workflow, customer
experience, reservation handling and bounded production edge-readiness retry
documented in `1.0.0-rc.94` and `1.0.0-rc.95`.

## Acceptance boundary

Production menu activation, WeChat platform upload/review, real-device phone
authorization, real payment/refund and physical store acceptance remain
separate evidence. New menu items remain inactive until real cost and output
facts are approved.
