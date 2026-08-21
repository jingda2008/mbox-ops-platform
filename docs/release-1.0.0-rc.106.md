# M-BOX 1.0.0-rc.106

## Scope

This candidate supersedes rc.105 without changing its business-day closure
rules. It updates the normalized staff web, service and deployment scripts,
uses the existing `001` through `098` database contract, and adds no migration.
The release bundle excludes the WeChat mini-program package.

## Release preflight correction

- Before any backup, migration or provisioning write, the release process now
  checks the active application directly inside its container.
- The check fails closed unless commit SHA, image digest, schema version,
  deployment tier, normal runtime role, write enablement and worker health all
  match the frozen previous release.
- The deployment host no longer depends on routing through the public edge back
  to itself for this pre-write check. Public URL verification remains required
  after cutover and when validating a restored previous release.

## Business-day closure carried forward

The worker and authorized cashier/manager action close only settled prior-day
tables. Typed order, KDS, payment, refund and other operational blockers remain
open on their original business date until resolved; no historical revenue or
evidence is rewritten.

## Verification boundary

The candidate requires release-policy and failure-order tests, normalized
server/web type checks, production build, quality metadata checks, immutable CI
image evidence and a successful public post-cutover verification. Store-side
operating acceptance and real payment evidence remain separate requirements.
