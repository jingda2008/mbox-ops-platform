# M-BOX 1.0.0-rc.141

## Scope

This candidate supersedes `1.0.0-rc.140`. It unifies Web confirmation and
short-input interactions in a fixed M-BOX dialog, rather than relying on
browser-native prompt windows. It also makes customer performance information
resilient: a failed feed is shown as retryable, while a genuinely empty day
can continue to be presented as empty.

The mini-program reads public performance schedules by date, independently of
the guest table session. This release does not change payment, refund,
inventory, table-turnover or database business rules.

`rc.140` was not activated: its tag CI exposed that the browser flow still
waited for a native `window.confirm` after the UI had moved to the rendered
M-BOX confirmation dialog. This candidate makes that flow deliberately open
and confirm the rendered dialog for each payment-policy change. It does not
weaken the confirmation or alter any payment-policy rule.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and the normal
fresh PostgreSQL migration gate through schema `143`. The release must retain
the rc.140 customer-left turnover regression and add coverage for failed
performance reads, public-date performance access and the fixed confirmation
dialog contract.

Local builds and isolated database tests do not prove real payment-channel,
physical POS, printer, hardware, staffed-field or native WeChat acceptance.

## Production route

Deployment uses the approved release script with backup/readback, candidate
health, Caddy cutover, rollback safeguards and public route verification.
Post-switch evidence must confirm the exact commit, image digest, schema `143`
and worker health. This release does not build, upload or replace the native
WeChat mini-program package.

## Deployment evidence

Not yet deployed. The immutable tag, CI, image, backup/readback and
post-switch evidence will be recorded only after the candidate passes the
release gate.
