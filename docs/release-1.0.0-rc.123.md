# M-BOX 1.0.0-rc.123

## Scope

This candidate supersedes `1.0.0-rc.122` and deploys the normalized staff web,
service and database bundle through migration `105`. It does not build, upload
or replace the native WeChat mini-program package.

## Cash collection boundary

- Authorized staff can record the full remaining amount as received cash or a
  physical POS payment without first creating an online pending payment.
- A pending online row is closed atomically only when the system can prove it
  was never submitted to the provider.
- Provider-started, provider-referenced or unknown-result payments block manual
  collection and direct the cashier to authoritative channel query or closure.
- The current employee, time and receipt reference are retained; the UI requires
  a second confirmation that the money has actually been received.

## Permission-derived entries

- Final effective permissions, including role grants, personal grants and
  personal denials, are the sole authority for module existence.
- Granting a supported fine-grained permission automatically reveals its parent
  page. Revocation or denial removes the entry after session refresh.
- Role navigation configuration controls label, icon and order only. Direct URLs
  and APIs remain protected by the same effective permission boundary.

## Store Windows print bridge

- Adds schema `105`, revocable device credentials, ten-minute one-time pairing,
  heartbeat and Windows queue discovery.
- Adds one operations page for printer add/edit/pause/enable, route configuration,
  detection, test printing, reconnect and failed-job review. Configuration changes
  require a reason and preserve before/after audit facts.
- Routes bar production, kitchen production and authority-confirmed payment
  receipts independently. Print failure does not roll back orders, payment,
  inventory or electronic fulfillment.
- Ambiguous post-spool outcomes stop automatic physical reprinting and require a
  person to confirm whether paper already came out; physical exactly-once output
  is not claimed.

## Acceptance boundary

Local deterministic, PostgreSQL, type, lint, build, load and package checks pass
for the candidate source. Immutable main/tag CI, release evidence and production
verification are still required before deployment can be reported complete.
Cash/POS, GP-D802, the second printer, USB/network queues, paper-out, disconnect
and Windows restart remain field acceptance rather than automated proof.

## Production route

The public origin is `https://mbox.shmbox.com`. Production deployment must consume
the immutable GitHub pre-release and existing private application-host/evidence-
relay contract. The native WeChat package remains a separate upload and review
action.
