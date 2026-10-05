BEGIN;

-- The existing API and controlled definer functions already accept 3..500
-- trimmed characters. Align storage with that contract without rewriting
-- historical evidence, changing permissions, or replacing immutable migration 095.
ALTER TABLE mbox.personal_contact_retention_policy_versions
  DROP CONSTRAINT personal_contact_retention_policy_v_legal_basis_reference_check,
  ADD CONSTRAINT personal_contact_retention_policy_v_legal_basis_reference_check
    CHECK (length(btrim(legal_basis_reference)) BETWEEN 3 AND 500);

ALTER TABLE mbox.personal_contact_legal_holds
  DROP CONSTRAINT personal_contact_legal_holds_legal_basis_reference_check,
  ADD CONSTRAINT personal_contact_legal_holds_legal_basis_reference_check
    CHECK (length(btrim(legal_basis_reference)) BETWEEN 3 AND 500);

COMMIT;
