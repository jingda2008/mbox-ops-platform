# M-BOX 1.0.0-rc.181

Fix cashier carryover entries that remained visible after payment release or completed activity refunds. Explicit text and payment-status searches retain historical records. Genuine unresolved finance work remains visible.

Recover existing verified refund terminal observations before provider I/O, using their original integration authority. This repairs interrupted submit-rejection consumption in both API and worker paths. Amount, currency and original transaction binding remain mandatory; conflicting observations fail closed. StarPay 121338 remains nonterminal and automatic provider queries stop after the 60-day query window without inventing success.

Local validation: 1245 full tests passed; PostgreSQL integration 1401 passed; final targeted regression 120 passed; normalized production build and diff checks passed. CI and deployment must bind evidence to the merged commit.

Production acceptance: A02 refunded/released payment and the terminal activity refund leave the default work queue. The S2 7800-cent refund has a verified failure observation: recovery must mark it failed, never succeeded. Any new refund remains a separate staff action. No financial history is deleted.

No changes under miniprogram; no WeChat upload required. Database schema remains 162. Production rollout and readback are pending at preparation time.
