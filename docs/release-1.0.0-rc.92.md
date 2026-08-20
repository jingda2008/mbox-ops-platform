# M-BOX 1.0.0-rc.92

## Scope

This candidate contains the same staff web, normalized service and normalized
database scope as `1.0.0-rc.91`. It does not upload, review or replace the
WeChat mini-program.

## Alibaba Cloud RDS release correction

- The protected restore path now recognizes Alibaba Cloud RDS privileged
  accounts without pretending they are PostgreSQL native superusers.
- An RDS administrator is accepted only when it has `CREATEDB`, `CREATEROLE`,
  `BYPASSRLS`, membership in `pg_rds_superuser`, and owns the database captured
  in the immutable restore evidence.
- Self-managed PostgreSQL backup credentials remain non-superuser,
  `BYPASSRLS`, `pg_monitor`, and `pg_read_all_data`. Alibaba Cloud RDS instead
  uses its provider-managed non-native-superuser account with `BYPASSRLS` and
  `pg_rds_superuser`, because RDS does not allow that account to delegate the
  required predefined roles. Snapshot execution remains read-only.
- Passwords remain outside process arguments and application containers in
  root-only libpq service and pass files.

## Acceptance boundary

This change corrects the release mechanism for the existing Alibaba Cloud RDS
topology. It does not prove a successful production migration until the
maintenance, backup, migration, candidate, cutover, public verification and
rollback evidence gates complete for the immutable tag. Mini-program upload is
still a separate, unexecuted release process.
