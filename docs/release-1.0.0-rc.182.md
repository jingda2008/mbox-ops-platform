# M-BOX 1.0.0-rc.182

Unified audit remediation from bc515baa7dd880ca0f8b7913193631b7ec90f469.

Scope: staff payment ownership/local release; recoverable write identities; multi-employee payroll drafts and least-privilege finance access; expense date/search/pagination; Mini Program lifecycle recovery, membership gates, preferences, service/bundle/benefit layouts. See [implementation matrix](MBOX_AUDIT_REMEDIATION_IMPLEMENTATION_20260908.md).

No database migration; schema remains 162. No historical payment, refund, payroll or audit records are deleted. Unknown payment results are not recast as failures. Additional collection requires a distinct attempt; confirmed settlement remains server-guarded. Payroll posting is accounting, not a bank transfer.

Validation and publication evidence are recorded separately. Local simulated payment/database/browser/native UI tests do not prove real channel settlement, physical printing, notifications or iOS/Android phone acceptance. Those operating acceptance gates remain open. The current production release must be backed by merged-commit CI and the immutable tag image before deployment.

WeChat business source changed and requires a fresh upload from the merged candidate. The isolated native-audit project must never be uploaded. Alipay source parity is maintained but no Alipay platform upload is included.
