# M-BOX 1.0.0-rc.178

## Scope

This candidate fixes two production findings without changing product status,
prices, store permissions or database schema.

Staff-assisted ordering now receives category display and parent metadata and
classifies the active `snack` and `cold_food` children under the `food` root.
The assisted catalog remains constrained by the server-side `staff_assisted`
channel, active status, price, inventory and availability rules, but it no
longer incorrectly applies the customer-only `guestVisible` filter. A category
named `fruit` is not assumed to be food because production currently uses that
code beneath a whisky parent.

Submitted StarPay refunds in `processing` are now queried by the existing
bounded background cycle. A signed, amount/currency/original-transaction
matched terminal result is consumed through the existing financial command;
`processing`, unknown and unavailable responses do not create a success or
failure fact and do not stop table reads, payments or other background work.
The staff table banner distinguishes employee action from automatic provider
reconciliation. A provider-confirmed failed refund remains an employee action.

## Payment authority

Refund submission is not refund success. Only a verified callback or active
query may complete an online refund. Queries run in batches of at most 20 and
each refund is isolated, so one external failure cannot lock the table screen.
Payment collection authority is unchanged: only enough authoritative successful
receipts stop another collection attempt; late and excess receipts remain
auditable and require controlled refund handling.

## Acceptance boundary

Automated acceptance covers unit, PostgreSQL, HTTP, build and browser gates on
the exact release candidate. Production deployment must still bind the merged
commit and immutable image digest, keep schema 158 and store configuration v20,
and pass public route and health readback.

The native `miniprogram/` source is unchanged, so this release does not require
a duplicate WeChat Developer Tools upload. The staff operating page and guest
web menu are web application code delivered by the production deployment.

Real StarPay/WeChat refund arrival, cash/POS reconciliation, physical devices
and store-role exercises remain external acceptance items. Android App
packaging remains out of scope. Commercial readiness therefore remains `DENY`
until those items are closed.
