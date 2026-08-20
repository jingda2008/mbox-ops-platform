# M-BOX 1.0.0-rc.99

## Scope

This candidate supersedes `1.0.0-rc.98`. The `rc.98` production activation
succeeded, but a production-safe simulated beverage receiving flow showed that
the versioned store configuration omitted the existing inventory count, count
approval and waste permissions. The database and APIs correctly denied the
operation; this release restores the intended least-privilege role mapping.

## Inventory role correction

- Managers, deputy managers and bartenders may count tracked beverage stock and
  record operational waste.
- Owners and operations leads may approve a count submitted by another
  employee.
- Cashiers and kitchen employees do not gain receiving, counting or waste
  permissions. Snacks and fruit remain outside tracked inventory unless a
  product is explicitly configured otherwise.
- Database separation of duties still rejects self-approval.

## Acceptance boundary

This release deploys only the normalized staff web, service and database
bundle. It does not upload or overwrite a WeChat mini-program package. The menu
artwork catalogue remains inactive and guest-hidden pending physical-product,
recipe and cost approval. Real payment/refund and real-device WeChat acceptance
remain separate evidence.
