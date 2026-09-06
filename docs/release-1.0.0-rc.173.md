# M-BOX 1.0.0-rc.173

## Scope

This candidate closes the second provider uncertainty gap found during the
rc.172 production acceptance window. rc.172 correctly classified an unmappable
StarPay query as financially unknown, but a query could validly return pending
and the following close call could itself reject with a non-standard provider
error. That close error still reached the background coordinator as an item
failure and made `/api/ready` alternate between ready and not-ready every 30
seconds.

The shared provider-operation boundary now covers both query and close calls.
A rejected, malformed or unreachable close response remains financially
unknown: it creates no verified provider observation and does not rewrite the
payment as paid, failed or closed. The existing worker keeps the pending finance
fact and waits five minutes before another provider attempt.

Guest checkout abandonment releases only the abandoned order's inventory,
capacity and fulfilment. It deliberately does not close the physical table
session. Staff can use the audited customer-left turnover action when the table
is actually vacant; this prevents an abandoned payment from blocking turnover
without automatically ejecting another customer or closing an unrelated paid
order at the same table.

This backend-only candidate does not change WeChat or Alipay Mini Program
source. WeChat 1.2.2 remains the matching customer UI candidate and no native
re-upload is required.

## Acceptance boundary

The candidate must pass the complete repository gate, all normalized PostgreSQL
transaction and RLS tests, isolated HTTP acceptance, mobile browser coverage
and sustained-load gate. The new regression test must reproduce a successful
pending query followed by a rejected close call and prove that the result is
unknown and no verified provider observation is written.

Production acceptance requires at least 23 consecutive internal `/api/ready`
samples at 30-second intervals, spanning more than two five-minute retry
windows. Every sample must return HTTP 200 with the exact release SHA and image
digest, schema 157, production tier, healthy workers and an empty failure list.
Application logs from the same window must contain no
`stale-guest-immediate-payment-reconciliation` failure.

## Production route

Deploy only the immutable `v1.0.0-rc.173` GitHub release bundle through
`deploy/aliyun/deploy-release.sh`. Verify the tag SHA, image digest, existing
schema 157, OSS backup upload/readback, candidate health and deep links before
cutover. Retain rc.172 as the rollback container until the continuous
production acceptance window passes.
