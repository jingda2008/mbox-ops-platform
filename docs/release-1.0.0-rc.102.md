# M-BOX 1.0.0-rc.102

## Scope

This candidate supersedes `1.0.0-rc.101`. It deploys the normalized staff web,
service and database bundle. It deliberately does not upload or overwrite a
WeChat mini-program package.

## Customer mini-program source

- The customer membership invitation uses explicit, customer-selected consent.
  The authorization control remains unavailable until the agreement is
  selected.
- The profile support area carries the configured native WeCom customer-service
  route. The route is only available to a real WeChat client after the
  separately managed mini-program package is uploaded and released.
- Public content, performance, preferences and contact views are served by the
  deployed API, but their mini-program presentation is not published by this
  server deployment.

## Public test boundary

The source repository is publicly visible for testing and technical review. It
is not approved for commercial operation, live money processing or production
store use. Real payment/refund and real-device WeChat acceptance remain
separate evidence gates.
