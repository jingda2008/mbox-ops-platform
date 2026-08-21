# M-BOX 1.0.0-rc.103

## Scope

This candidate supersedes the unreleaseable `1.0.0-rc.102` tag. It adds the
versioned quality-register artifacts required to evaluate the exact candidate.
No application behaviour, database migration or customer-facing scope changes
from `1.0.0-rc.102`.

The release bundle deploys the normalized staff web, service and database
bundle. It deliberately does not upload or overwrite a WeChat mini-program
package.

## Customer mini-program source

- The customer membership invitation requires an explicit customer-selected
  agreement before WeChat phone authorization may be requested.
- The profile support area contains the configured native WeCom
  customer-service route. It becomes available in a real WeChat client only
  after the separately managed mini-program package is uploaded and released.

## Public test boundary

The source repository is publicly visible for testing and technical review. It
is not approved for commercial operation, live money processing or production
store use. The attached quality register records the remaining field and
commercial acceptance work; real payment/refund and real-device WeChat
acceptance remain separate evidence gates.
