# rc.181 production acceptance — 2026-09-08 12:22 CST

- PR: https://github.com/jingda2008/mbox-ops-platform/pull/191
- Release: v1.0.0-rc.181
- Production commit: e7e434ee726d08caf30fca5bc048a1553dc7f755
- Image digest: sha256:fe11dfbdf2ed07d22e5102e50154493ec898e9d949e3de158add5a7081622bdb
- Tag CI: 34185375340; release workflow: 34185375351; both successful.
- Target: mbox.shmbox.com; evidence relay: 139.224.254.60. Production schema 162, ready response verified.
- Official deployment script completed database backup verification, immutable image and evidence verification, activation, OSS completion archive and external browser smoke for /, /guest?table=W01, /reserve and /staff/live.

## Incident readback

Before deployment, the cashier query returned two carryover orders (A02 and S2), one processing refund and one terminal activity registration. After deployment, A02 and the terminal activity no longer appeared in routine work.

The S2 7800-cent refund remained under its persisted query backoff. A bounded invocation of the deployed PaymentCommandService consumed its existing verified submit-rejection observation, using its original integration authority. The OnlinePaymentService adapter was deliberately null: no provider network request or new refund was possible. The operation used stable idempotency key rc181-recover-S2-verified-refund-failure and rechecked the exact release, refund identity, amount, currency and failed observation before execution.

Final production readback: default orderCount=0, carryoverOrderCount=0, processingRefundCount=0, activity count=0; A02 search returned two historical orders. The specific S2 refund was failed, with one consumed observation, reconciliation phase stopped and stop_reason provider_terminal_result. Financial history was preserved.

This confirms state recovery, not payment of the remaining 7800 cents to the customer. Cashier must separately decide whether a new refund is still owed. No new charge or refund was initiated, and no Mini Program source changed or upload was required.
