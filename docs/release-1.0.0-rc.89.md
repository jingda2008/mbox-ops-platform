# M-BOX 1.0.0-rc.89

## Scope

This candidate restores the previously configured Postar test channel to the
normalized validation release without enabling production acquiring. It fixes
the protocol and environment-normalization defects found during the read-only
configuration audit and sandbox verification.

## Payment protocol behavior

- Every Postar request remains RSA-signed and is sent only to the fixed HTTPS
  endpoint for the selected environment. The official synchronous response
  schemas use `code`, `msg` and `data`; an optional response signature is still
  verified when present.
- Active queries bind the returned agency, merchant context, business order,
  provider transaction, status, currency and amount to the stored payment.
  They are recorded as server-to-server query evidence, not falsely labeled as
  signed callbacks.
- A `processing` or failed query may report a provider amount of zero. The raw
  value is retained as evidence, while a successful query must report the exact
  positive order amount before payment fulfillment can be activated.
- Asynchronous payment callbacks remain signature-required. Forged callbacks,
  amount mismatches and transaction-binding conflicts continue to fail closed.

## Configuration correction

- Runtime canonicalization preserves an explicit `MBOX_PAYMENT_MODE` value of
  `test`, `uat` or `production` for Postar instead of replacing it with UAT.
- The remote candidate configuration is based on the active `rc.88` protected
  file and selectively restores only the earlier Postar test identifiers,
  public key, callback URL and WeChat presentation settings.
- The store commerce policy continues to control whether new online payments
  can be initiated. Provider readiness never opens a closed store policy.

## Acceptance boundary

The release may be deployed only to the validation tier with
`MBOX_PAYMENT_MODE=test`. Sandbox QR creation and unpaid active query are not
evidence of production acquiring, successful settlement, live refund or daily
reconciliation. Production credentials, production mode and real-money payment
remain unchanged and require separate explicit authorization and acceptance.
