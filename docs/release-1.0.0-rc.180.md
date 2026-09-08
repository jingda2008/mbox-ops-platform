# M-BOX 1.0.0-rc.180

## Scope

This hotfix corrects the closed-table protection boundary for verified legacy
KDS carryover. Migration 129 correctly stopped new or advancing operational
work after table closure, but it also unintentionally stopped the existing
authorized manager-cancellation command. The visible batch action added in
rc.179 therefore returned an internal error for the three August 24 VIP1 test
tasks and made no changes.

Migration 162 retains the closed-table write lock and permits only an active
task to move to `cancelled` when the already-authorized manager command binds
that exact task inside the same database transaction. The route still requires
the existing KDS exception-management permission, reason code, reason note and
idempotency key. It continues to write the immutable KDS event, structured
exception evidence, staff audit and outbox records; no operational or financial
history is deleted.

## Mini Program

There are no changes under `miniprogram/` in this hotfix. A new WeChat Mini
Program upload or experience-version selection is not required for rc.180.

## Acceptance boundary

Automated checks cover migrations 001-162 and prove both sides of the boundary:
an ordinary status write on a closed table still fails, while an exact
manager-bound active-to-cancelled transition succeeds and writes its task event.
Deployment must read back the merged commit, immutable image digest and schema
162 before the production manager command is retried.

After deployment, production acceptance for this incident requires all three
exact VIP1 tasks from business date 2026-08-24 to read back as `cancelled`, with
their cancellation events and manager-exception audit evidence present and no
active carryover remaining. This hotfix does not change payments, inventory,
orders, table financial state, or customer Mini Program behavior.
