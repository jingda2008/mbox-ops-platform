# M-BOX 1.0.0-rc.172

## Scope

This candidate closes a production payment-reconciliation readiness gap found
after rc.171 activation. A rejected, malformed or unreachable StarPay query is
not a verified payment result. The online-payment boundary now normalizes those
responses to the existing financially-unknown state for guest, employee and
system query/close paths instead of allowing a provider protocol exception to
degrade application readiness.

An explicitly abandoned guest checkout remains operationally released and its
table stays usable. The pending payment fact is retained for signed callback,
later query and cashier refund review; the candidate never rewrites uncertainty
as success or failure. Repeated provider queries for the same abandoned unknown
payment are held for five minutes in the running worker, and stale retry state
is pruned after the payment leaves the candidate set.

This backend-only candidate does not change the WeChat or Alipay Mini Program
source. The previously uploaded WeChat 1.2.2 candidate therefore remains the
matching customer UI candidate and does not require another native upload.

## Acceptance boundary

The candidate must pass the complete repository gate, all normalized PostgreSQL
transaction and RLS tests, isolated HTTP acceptance, the mobile browser suite
and sustained-load gate. Regression tests cover guest-authorized query, system
query, system close, operational abandonment, bounded retry and the invariant
that no unknown result enters the verified payment ledger.

Production acceptance additionally requires observing `/api/ready` through at
least two five-minute reconciliation windows while the existing abandoned
pending payments remain unresolved. Every sample must return HTTP 200 with the
exact release SHA and image digest, schema 157, production tier and healthy
workers. The tables and finance reminders must remain available independently
of provider-query success.

## Production route

Deploy only the immutable `v1.0.0-rc.172` GitHub release bundle through
`deploy/aliyun/deploy-release.sh`. Verify the tag SHA, image digest, existing
schema 157, OSS backup upload/readback, candidate health and deep links before
cutover. Keep rc.171 available for rollback until the public readiness samples,
guest/reservation/staff deep links and deployment-completion evidence pass.
