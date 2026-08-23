# M-BOX 1.0.0-rc.120

## Scope

This candidate supersedes `1.0.0-rc.119`. It deploys the integrated operations,
inventory media, settlement safeguards and normalized database bundle through
migration `103`. It does not build, upload or overwrite the WeChat mini-program
package.

## Integrated operations

- Adds immutable public media assets, recipe cost versions and order settlement
  exception facts through migrations `100` to `103`.
- Tightens inventory media handling, settlement safeguards and home content
  display mode publishing for staff operations.
- Removes legacy activity write paths that bypassed the unified operations entry.

## Mini-program boundary

The WeChat package changes on the same integration branch remain a separate
candidate/upload step. This release only ships the normalized staff web, service
and database bundle.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment reaches the private
application host through the approved payment-server jump path. Migration
`100` through `103` requires the existing maintenance-window database contract
and its backup, restore and evidence gates.
