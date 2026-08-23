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
