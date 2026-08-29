# M-BOX 1.0.0-rc.159

## Scope

This candidate contains the guest-ordering, recommendation and automatic
business-day turnover changes merged by PR #143. The native Mini Program now
requests its recommendation questionnaire and recommendation strategy from the
server-owned, versioned policy configuration. The client sends only the three
configured answers; it does not keep a second local scoring policy. The server
can use the current table, a signed-in member's bounded paid-order history,
staff-entered party context and current session behaviour. Refunded, cancelled
and unresolved orders are excluded from purchase-history weighting.

The customer-facing ordering flow keeps the recommendation entry independent
from menu category filtering, removes internal system prompts, gives the cart a
clear compact entry, and uses one editable review sheet before it creates the
order and requests native WeChat payment. Narrow-sheet spacing, scroll regions
and touch targets were reviewed for the Huawei Mate X5 outer-screen width.

Expired or ended guest table sessions now return identifiable 401/409 domain
errors instead of an unhandled 500. The Mini Program clears only the local
table binding that matches the failed request, so a delayed response from a
previous table cannot erase a newer scan.

Normalized migrations `148` and `149` add recommendation-history indexes and
the 12:00–06:00 automatic physical-table-turnover policy. At the cutoff, only
prior-business-day open/closing table sessions are released. Payment, refund,
inventory, order and late-provider evidence is retained for reconciliation;
the system does not fabricate a payment result or discard a financial fact.

## Acceptance boundary

The feature PR passed cloud quality checks, an isolated PostgreSQL migration,
transaction/RLS and HTTP suite, mobile browser flows and sustained-load checks.
Locally it also passed Mini Program static verification, customer checkout and
table-scope recovery suites. The exact source was compiled in WeChat DevTools
with the Huawei Mate X5 outer-screen profile.

These checks prove code-path and isolated-data behaviour. They do not prove a
real WeChat debit, provider callback arrival, POS/refund channel behaviour,
printing, morning worker execution or a real-device customer completion. The
backend release bundle deliberately excludes the native Mini Program; a
separate, attested Mini Program upload remains required before users receive
the client changes.

## Production route

Deploy only from this immutable tag after tag CI has produced the exact image,
manifest and evidence. The production procedure must perform configuration
preflight, verified backup/readback, migration, zero-traffic candidate checks,
formal route checks, traffic cutover and OSS evidence sealing. Any failed gate
keeps the prior immutable release active.
