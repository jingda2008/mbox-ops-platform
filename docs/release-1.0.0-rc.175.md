# M-BOX 1.0.0-rc.175

## Scope

This candidate closes the second defect found by the rc.174 production
acceptance readback. The previous candidate corrected the provider observation
authority, but the production coordinator passes a 62-character scoped worker
identifier. The close binding combined that identifier, a payment UUID and a
fresh UUID, producing a 157-character value. The same value is deliberately
used as the normalized payment command idempotency key, whose audited maximum
is 128 characters. StarPay therefore returned a definitive failed result and
the observation was recorded correctly, but the payment command rejected the
overlong key and rolled back consumption every 30 seconds.

The close binding now contains the payment UUID and a fresh UUID only. At about
94 characters it remains unique per provider-close attempt and stays within the
command boundary independently of worker naming. Provider binding and command
idempotency still use the same value; the change does not weaken immutable
observation verification, infer a financial result, or edit production facts by
hand.

Order fulfilment and physical table occupancy remain separate. A
provider-confirmed failed payment can clear the financial pending state and
leave its cancelled order unpaid without restoring fulfilment. The physical
table session remains open until authorised staff close it or record customer
departure, so an unrelated active or paid order at the same table is not ended
automatically.

This backend-only candidate does not change WeChat or Alipay Mini Program
source. WeChat 1.2.2 remains the matching customer UI candidate and no native
re-upload is required.

## Acceptance boundary

The candidate must pass the complete repository gate, all normalized PostgreSQL
transaction and RLS tests, isolated HTTP acceptance, mobile browser coverage
and sustained-load gate. Regression coverage must use the production-length
worker identifier and a UUID payment id, assert the provider close binding and
payment command idempotency key are identical, and reject any value longer than
128 characters.

Production acceptance requires at least 23 consecutive internal `/api/ready`
samples at 30-second intervals, spanning more than ten minutes. Every sample
must return HTTP 200 with the exact release SHA and image digest, schema 157,
production tier, healthy workers and an empty failure list. The two affected
payments must transition from pending to the provider-confirmed failed state,
their orders must become unpaid without reactivating fulfilment, and no new
unconsumed observation or
`stale-guest-immediate-payment-reconciliation` failure may appear after the
first successful reconciliation cycle.

## Production route

Deploy only the immutable `v1.0.0-rc.175` GitHub release bundle through
`deploy/aliyun/deploy-release.sh`. Verify the tag SHA, image digest, existing
schema 157, OSS backup upload/readback, candidate health and deep links before
cutover. Retain rc.174 as the rollback container until the continuous
production acceptance window passes.
