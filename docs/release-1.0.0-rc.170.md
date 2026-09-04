# M-BOX 1.0.0-rc.170

## Scope

This candidate turns the Alipay mini-program phone-number enrollment path into
a first-class shared-backend capability. Guest enroll, recovery and verified-
phone replace accept an explicit `phoneAuthorizationProvider=alipay` flag, route
ciphertext through AES-128-CBC decryption (zero IV), and refuse Alipay payloads
on the WeChat one-time-code adapter.

Reservation and guest session issuance now return opaque `sessionToken` values
in JSON so Alipay runtimes that cannot read HttpOnly cookies can persist Bearer
or `x-mbox-*-session` headers. Runtime config accepts `MBOX_ALIPAY_APP_ID` and
`MBOX_ALIPAY_AES_KEY`; the Aliyun env normalizer allowlists both keys.

The native Alipay frontend under `alipay-miniprogram/` follows the WeChat page
parity baseline, uses official `getAuthorize` + `my.getPhoneNumber`, and maps
Alipay open-platform config errors (`40001 Missing Required Arguments`) to a
clear failure instead of a generic invalid-authorization toast.

## Acceptance boundary

Local phone-authorization unit tests, Alipay platform adapter tests and the
Alipay static/parity gate must pass before tagging. True-device enrollment was
proven against the prior production hot patch after open-platform signing, AES
and application gateway were configured.

This release does **not** enable Alipay self-checkout payment (`tradeNO`), does
not upload or select an Alipay experience/production mini-program package, and
does not replace WeChat table mini-codes with Alipay codes. Commercial release
remains `DENY` until real funds, Alipay payment adaptation and store acceptance
are complete.

## Production route

Preferred immutable path remains tag `v1.0.0-rc.170` after CI publishes the
image digest and release manifest. When only password jump-host access is
available, operators may build `mbox-normalized:1.0.0-rc.170-<shortsha>` on
`10.100.80.223` from the merged commit, keep `MBOX_ALIPAY_*` in
`/opt/mbox/secrets/app.env`, cut over `mbox-app`, and record the SHA-built
digest in the commercialization checklist without claiming tag-CI equivalence.

Keep the previous rc.169 / hot-patch rollback container recoverable until
`/api/ready`, worker health and enrollment probes pass.
