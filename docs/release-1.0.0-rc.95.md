# M-BOX 1.0.0-rc.95

## Scope

This candidate supersedes `1.0.0-rc.94`. The `rc.94` code and image passed the
full release gate, but two production activation attempts stopped before any
database write because the release host's first public readiness request timed
out at the edge address.

## Release reliability correction

- Retries the public readiness boundary for a bounded period before migration
  compatibility, writer drain or database writes.
- Applies the same bounded check after the maintenance route is loaded.
- Still fails closed if the expected HTTP status is not observed; it does not
  weaken schema, commit, image digest, role, database or application checks.

## Included business changes

This candidate contains the same menu drafts, inventory workflow, customer
experience, reservation handling and production packaging fixes documented in
`1.0.0-rc.94`.

## Acceptance boundary

Production menu activation, WeChat platform upload/review, real-device phone
authorization, real payment/refund and physical store acceptance remain
separate evidence. New menu items remain inactive until real cost and output
facts are approved.
