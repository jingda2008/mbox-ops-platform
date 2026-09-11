# M-BOX 1.0.0-rc.187

This release implements DEV-01–13 from the final requirements: direct collection despite unknown attempts; one real aggregate payment allocated to original orders; private guest table switching/history; role-specific work history; actionable operational reasons; authenticated media; mobile search/camera reuse; monthly scheduling; and report/receipt printing.

Database migrations 190–196 retain payment facts and same-operation idempotency. Allocation totals, store/session ownership, refund original-order limits, loyalty/recommendation references and late overcollection remain database-validated. Unknown attempts continue existing financial reconciliation. A scoped finance queue records owners and prevents closing cases with unknown funds or unresolved overcollection.

The five-record display repair defaults to transaction rollback and checks exact IDs, amounts, cancelled order/closed session, stopped financial review and absence of confirmed funds. It does not alter payments, refunds, ledger entries, stock or old release markers. The already handled CNY20 refund and previously repaired complaints/items are excluded.

Validation and deployment evidence are recorded in `final-development-execution-20260911.md` and the deployment report. Existing commercial acceptance gaps remain in generated TC registers. Mini Program upload, experience-version selection, Windows installation and actual paper/phone checks are distinct from backend release. No physical acceptance is implied by automated tests.
