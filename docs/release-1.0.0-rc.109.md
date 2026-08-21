# M-BOX 1.0.0-rc.109

## Scope

This candidate supersedes rc.108 and is built from the current `main` after
PR #113. It deploys the normalized staff web, service and database migrations
`001` through `098`. It does not build, upload or overwrite the WeChat
mini-program package.

## Included changes

- Carries forward the full functional and database history already contained
  in `main`, including rc.104 order handling, prior-business-day closure and
  the production-origin release safeguards added through rc.108.
- Applies the restrained M-BOX brand-green visual system to staff login,
  workspace navigation, quick actions and operating modules without changing
  permissions, business commands or role responsibilities.
- Keeps mobile quick functions available after entering a module and makes the
  inactive navigation labels meet WCAG AA contrast requirements.
- Synchronizes stale customer-flow contract checks with the current source and
  preserves a 44-pixel customer content-card action target. Those mini-program
  source changes remain outside this deployment because no mini-program upload
  is performed.

## Production route

- The public operating origin remains `https://mbox.shmbox.com`.
- The production server is reached through the validated payment-server jump
  path to its private SSH endpoint. The release still uses the public hostname
  as its logical deployment identity, so the existing public-origin guard is
  not bypassed.
- A dedicated target key is restricted to the payment server's private source
  address. Passwords and database credentials are not placed in Git, command
  arguments, release artifacts or application containers.

## Verification boundary

The candidate requires pull-request CI, release metadata, normalized database
and RLS tests, real browser commercial flows, sustained-load evidence, tag CI,
an immutable release artifact and post-deployment private/public readiness.
The production deployment must stop if any identity, backup, migration,
readiness or cutover check fails. Store-side operating acceptance and real
payment evidence remain separate requirements.
