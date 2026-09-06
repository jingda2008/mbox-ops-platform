# M-BOX 1.0.0-rc.174

## Scope

This candidate closes the verified-observation binding defect found during the
rc.173 production acceptance window. StarPay was already returning a definitive
failed result for two guest payments whose customers had exited checkout. The
close workflow correctly recorded each immutable observation with integration
authority `postar-close-payment`, but the stale-payment worker attempted to
consume it as `postar-active-query` or `postar-stale-guest-checkout`. The strict
financial evidence check rejected that mismatch, rolled the transaction back
and retried the same payment every 30 seconds.

The close workflow now keeps one authority through every result branch:
provider failed or closed, pending or processing, and late success. The change
does not relax observation verification, invent a payment outcome or modify a
production payment by hand. A matching verified result is consumed once by the
normal payment command; provider uncertainty remains pending and uses the
existing five-minute backoff.

Order fulfilment and physical table occupancy remain separate. Customer exit
can cancel and release only the abandoned order. A definitive failed payment
removes the financial pending state, while an open physical table session stays
under an authorised employee's explicit close or customer-left turnover action.
That prevents payment queries from locking the table interface without risking
automatic closure of another active order at the same table.

This backend-only candidate does not change WeChat or Alipay Mini Program
source. WeChat 1.2.2 remains the matching customer UI candidate and no native
re-upload is required.

## Acceptance boundary

The candidate must pass the complete repository gate, all normalized PostgreSQL
transaction and RLS tests, isolated HTTP acceptance, mobile browser coverage
and sustained-load gate. Regression coverage must assert that every result from
`closeSystem` is consumed with `postar-close-payment`, including the exact
production case of an operationally abandoned order and a provider-confirmed
failed payment.

Production acceptance requires at least 23 consecutive internal `/api/ready`
samples at 30-second intervals, spanning more than ten minutes. Every sample
must return HTTP 200 with the exact release SHA and image digest, schema 157,
production tier, healthy workers and an empty failure list. The two affected
payments must transition from pending to the provider-confirmed failed state,
their orders must become unpaid without reactivating fulfilment, and application
logs from the acceptance window must contain no
`stale-guest-immediate-payment-reconciliation` failure.

## Production route

Deploy only the immutable `v1.0.0-rc.174` GitHub release bundle through
`deploy/aliyun/deploy-release.sh`. Verify the tag SHA, image digest, existing
schema 157, OSS backup upload/readback, candidate health and deep links before
cutover. Retain rc.173 as the rollback container until the continuous
production acceptance window passes.
