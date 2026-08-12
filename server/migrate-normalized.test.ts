import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NORMALIZED_MIGRATIONS_DIRECTORY,
  NORMALIZED_SCHEMA_FLAVOR,
  assertNormalizedMigrationTarget,
  loadNormalizedMigrations,
  unwrapNormalizedMigrationTransaction,
} from './migrate-normalized.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const value = await mkdtemp(join(tmpdir(), 'mbox-normalized-migrations-'))
  temporaryDirectories.push(value)
  return value
}

describe('normalized migration baseline', () => {
  it('is bound to the isolated normalized migration directory', () => {
    expect(NORMALIZED_MIGRATIONS_DIRECTORY).toMatch(/database\/normalized-migrations\/?$/)
    expect(NORMALIZED_MIGRATIONS_DIRECTORY).not.toMatch(/database\/migrations\/?$/)
  })

  it('loads one continuous immutable migration chain with explicit transactions', async () => {
    const migrations = await loadNormalizedMigrations()
    expect(migrations.map((migration) => migration.version)).toEqual([
      '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012',
      '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024',
      '025', '026', '027', '028', '029', '030', '031', '032', '033', '034',
    ])
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(unwrapNormalizedMigrationTransaction(migration.sql).trim().length).toBeGreaterThan(0)
    }
  })

  it('rejects migration gaps and files without one transaction wrapper', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, '002_gap.sql'), 'BEGIN; SELECT 1; COMMIT;\n')
    await expect(loadNormalizedMigrations(directory)).rejects.toThrow('不连续')

    await rm(join(directory, '002_gap.sql'))
    await writeFile(join(directory, '001_unwrapped.sql'), 'SELECT 1;\n')
    await expect(loadNormalizedMigrations(directory)).rejects.toThrow('BEGIN/COMMIT')
  })

  it('defines all required core tables without legacy runtime or projection tables', async () => {
    const sql = (await loadNormalizedMigrations()).map((migration) => migration.sql).join('\n')
    const requiredTables = [
      'tenants', 'stores', 'areas', 'tables', 'employees', 'roles', 'employee_roles',
      'table_assignments', 'table_sessions', 'idempotency_records', 'audit_events',
      'outbox_messages', 'service_tasks', 'service_task_events', 'products', 'product_prices',
      'orders', 'order_items', 'kds_tasks', 'kds_task_events', 'inventory_items', 'recipes',
      'recipe_items', 'inventory_movements', 'inventory_balances', 'payments', 'refunds',
      'reconciliation_entries', 'reservations', 'reservation_table_locks', 'customers',
      'customer_profiles', 'benefits', 'performers', 'schedules', 'song_requests', 'notifications',
      'staff_permission_definitions', 'role_permission_assignments',
      'employee_permission_overrides', 'role_data_scopes', 'role_approval_limits',
      'role_navigation_items', 'store_daily_credentials', 'store_device_access_leases',
      'staff_sessions', 'table_session_customers', 'pricing_authorizations',
      'staff_login_rate_limits',
      'assisted_order_contexts', 'kds_exceptions', 'reservation_payments',
      'song_request_payment_evidence', 'customer_identities', 'customer_tags',
      'customer_preferences', 'customer_events', 'benefit_reservations',
      'benefit_redemptions', 'table_qr_credentials', 'guest_sessions',
      'guest_session_rate_limits', 'guest_session_events', 'inventory_barcodes',
      'purchase_receipts', 'purchase_receipt_lines', 'inventory_stock_counts',
      'inventory_stock_count_lines', 'stored_bottles', 'stored_bottle_events',
      'operating_cost_entries', 'employee_sales_rules',
      'employee_sales_attribution_events', 'group_voucher_redemptions',
      'table_session_transfer_events', 'sop_rules', 'sop_rule_versions',
      'sop_rule_steps', 'sop_instances', 'sop_step_executions',
      'ai_execution_requests', 'guest_behavior_events', 'guest_service_request_groups',
      'guest_request_rate_limits', 'business_days', 'devices', 'printer_routes',
      'print_jobs', 'print_job_events', 'hardware_commands',
      'public_reservation_policies', 'reservation_guest_sessions',
      'public_reservation_rate_limits', 'reservation_private_contacts',
      'waitlist_entries', 'waitlist_events', 'product_bundle_components',
      'store_configuration_applications',
      'product_catalog_applications',
    ]
    for (const table of requiredTables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE mbox\\.${table}\\s*\\(`))
    }
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:mbox\.)?runtime_states\b/i)
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:mbox\.)?runtime_state_versions\b/i)
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:mbox\.)?operational_/i)
    expect(sql).not.toMatch(/CREATE\s+TABLE[^;]*projection_checkpoint/i)
  })

  it('encodes concurrency, integrity, append-only and RLS invariants in SQL', async () => {
    const sql = (await loadNormalizedMigrations()).map((migration) => migration.sql).join('\n')
    expect(sql).toMatch(/table_sessions_one_active_table_uq[\s\S]*status IN \('open', 'closing'\)/)
    expect(sql).toMatch(/EXCLUDE USING gist[\s\S]*reserved_during WITH &&/)
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, store_id, order_item_id\) REFERENCES mbox\.order_items/)
    expect(sql).toMatch(/service_tasks_sla_claim_idx/)
    expect(sql).toMatch(/kds_tasks_claim_idx/)
    expect(sql).toMatch(/outbox_pending_claim_idx/)
    expect(sql).toMatch(/notifications_business_key_uq/)
    expect(sql).toMatch(/notifications_delivery_claim_idx[\s\S]*status IN \('pending', 'failed', 'sending'\)/)
    expect(sql).toMatch(/notifications_attempt_limit_ck/)
    expect(sql).toMatch(/UNIQUE \(tenant_id, store_id, table_session_id, source_type, source_id\)/)
    expect(sql).toMatch(/table_session_customers_primary_uq/)
    expect(sql).toMatch(/status IN \('pending', 'sending', 'delivered', 'failed', 'dead', 'cancelled'\)/)
    expect(sql).toMatch(/service_task_events_append_only/)
    expect(sql).toMatch(/kds_task_events_append_only/)
    expect(sql).toMatch(/inventory_movements_append_only/)
    expect(sql).toMatch(/audit_events_append_only/)
    expect(sql).toMatch(/current_setting\('app\.tenant_id', true\)/)
    expect(sql).toMatch(/current_setting\('app\.store_id', true\)/)
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/CREATE ROLE mbox_runtime[\s\S]*NOLOGIN[\s\S]*NOBYPASSRLS/)
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA mbox TO mbox_runtime/)
    expect(sql).toMatch(/GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mbox TO mbox_runtime/)
    expect(sql).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA mbox FROM PUBLIC/)
    expect(sql).not.toMatch(/(?:CREATE|ALTER) ROLE mbox_runtime[\s\S]{0,200}\bPASSWORD\b/i)
    expect(sql).toMatch(/staff_sessions[\s\S]*expires_at = issued_at \+ interval '6 hours'/)
    expect(sql).toMatch(/employees_pin_hash_secure_format_ck/)
    expect(sql).toMatch(/staff_login_rate_limits_expiry_idx/)
    expect(sql).toMatch(/principal_hash char\(64\)/)
    expect(sql).toMatch(/product_prices_no_overlapping_validity/)
    expect(sql).toMatch(/product_bundle_components_validate/)
    expect(sql).toMatch(/products_protect_bundle_kind/)
    expect(sql).toMatch(/UNIQUE \(tenant_id, store_id, redemption_idempotency_key\)/)
    expect(sql).toMatch(/benefit_reservations_active_idx/)
    expect(sql).toMatch(/table_qr_credentials_one_active_table_uq/)
    expect(sql).toMatch(/guest_sessions_one_live_table_device_uq/)
    expect(sql).toMatch(/employee_sales_rules[\s\S]*EXCLUDE USING gist[\s\S]*effective_during WITH &&/)
    expect(sql).toMatch(/table_session_transfer_events_append_only/)
    expect(sql).toMatch(/sop_step_executions_due_idx/)
    expect(sql).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*store_id,\s*table_session_id,\s*merge_key\s*\)/)
    expect(sql).toMatch(/business_days_one_open_store_uq/)
    expect(sql).toMatch(/print_jobs_claim_idx/)
    expect(sql).toMatch(/waitlist_entries_active_contact_uq/)
    expect(sql).toMatch(/stores_seed_permission_definitions/)
    expect(sql).toMatch(/benefit_redemptions[\s\S]*authorization_source/)
    expect(sql).toMatch(/'order\.create'[\s\S]*'kds\.prepare'[\s\S]*'payment\.initiate\.staff'/)
    expect(sql).not.toMatch(/\b(?:real|double precision)\b/i)
  })

  it('accepts only an empty database or the same normalized schema flavor', () => {
    expect(() => assertNormalizedMigrationTarget({
      userTableCount: 0,
      hasLegacyMigrationMetadata: false,
      hasRuntimeStates: false,
      hasRuntimeStateVersions: false,
      hasNormalizedMetadata: false,
      hasNormalizedMigrations: false,
    })).not.toThrow()

    expect(() => assertNormalizedMigrationTarget({
      userTableCount: 40,
      hasLegacyMigrationMetadata: false,
      hasRuntimeStates: false,
      hasRuntimeStateVersions: false,
      hasNormalizedMetadata: true,
      hasNormalizedMigrations: true,
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
    })).not.toThrow()
  })

  it('fails closed for legacy, non-empty, partial, or foreign-flavor databases', () => {
    const base = {
      userTableCount: 1,
      hasLegacyMigrationMetadata: false,
      hasRuntimeStates: false,
      hasRuntimeStateVersions: false,
      hasNormalizedMetadata: false,
      hasNormalizedMigrations: false,
    }
    expect(() => assertNormalizedMigrationTarget({ ...base, hasRuntimeStates: true })).toThrow('legacy')
    expect(() => assertNormalizedMigrationTarget({ ...base, hasLegacyMigrationMetadata: true })).toThrow('legacy')
    expect(() => assertNormalizedMigrationTarget(base)).toThrow('不是全新空库')
    expect(() => assertNormalizedMigrationTarget({
      ...base,
      hasNormalizedMetadata: true,
      hasNormalizedMigrations: false,
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
    })).toThrow('不完整')
    expect(() => assertNormalizedMigrationTarget({
      ...base,
      hasNormalizedMetadata: true,
      hasNormalizedMigrations: true,
      schemaFlavor: 'another-product',
    })).toThrow('flavor')
  })
})
