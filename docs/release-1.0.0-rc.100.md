# M-BOX 1.0.0-rc.100

## Scope

This candidate supersedes `1.0.0-rc.99`. The `rc.99` production candidate
stopped before provisioning because its changed inventory role mapping still
used the already-published store configuration identifier. The active `rc.98`
application remained healthy.

## Store configuration correction

- Publishes the intended least-privilege inventory role mapping under the new
  monotonic identifier `2026.08.21-v11`.
- Managers, deputy managers and bartenders may count tracked beverage stock and
  record waste; owners and operations leads may approve another employee's
  submitted count.
- Cashiers and kitchen employees remain denied these inventory mutations, and
  database separation of duties still rejects self-approval.

## Acceptance boundary

This release deploys only the normalized staff web, service and database
bundle. It does not upload or overwrite a WeChat mini-program package. The 56
new menu records remain inactive and guest-hidden. Real payment/refund and
real-device WeChat acceptance remain separate evidence.
