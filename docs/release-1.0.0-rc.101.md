# M-BOX 1.0.0-rc.101

## Scope

This candidate supersedes `1.0.0-rc.100`. It deploys only the normalized staff
web, service and database bundle. It does not upload or overwrite a WeChat
mini-program package.

## Reservation completion

- Staff can now complete an `arrived` or `seated` reservation through the
  existing reservation command boundary.
- Completion releases the held reservation resource, creates one authoritative
  `reservation.completed.v1` audit and outbox fact, and is safe to retry under
  concurrent staff requests.
- This provides a controlled resolution path for an arrival that carries into
  the next business day; it does not alter historical payment, attendance or
  fulfillment facts.

## Public test boundary

The source repository is publicly visible for testing and technical review. It
is not approved for commercial operation, live money processing or production
store use. Real payment/refund and real-device WeChat acceptance remain
separate evidence gates.
