# M-BOX 1.0.0-rc.84

## Scope

This candidate repairs the release configuration contract exposed by the rejected `rc.83` Alibaba Cloud candidate. It does not change customer, employee, payment, order, reservation or inventory business behavior.

## Permanent controls

- The authoritative store configuration generates the required store credential and employee PIN template fields.
- Environment canonicalization preserves only the named daily credential and uppercase employee PIN fields.
- Read-only preflight validates all provisioning credentials before backup, migration or provisioning.
- The same validator is reused by the provisioner.
- IP endpoints are not sent as TLS SNI host names.

## Acceptance

- Configuration generation and canonicalization tests pass.
- Missing or malformed employee PINs fail before database work.
- Missing store credentials fail before database work.
- Preflight reports counts and status only; it does not emit credential values.
- The full CI, immutable release identity, OSS evidence, candidate deep routes, cutover and rollback controls remain required.
