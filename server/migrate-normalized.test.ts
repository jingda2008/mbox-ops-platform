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
      '025', '026', '027', '028', '029', '030', '031', '032', '033', '034', '035', '036',
      '037', '038', '039', '040', '041', '042', '043', '044', '045', '046', '047', '048',
      '049', '050', '051', '052', '053', '054', '055', '056', '057', '058', '059', '060',
      '061', '062', '063', '064', '065', '066', '067', '068', '069', '070', '071', '072',
      '073', '074', '075', '076', '077', '078', '079', '080', '081', '082', '083', '084', '085', '086', '087', '088', '089', '090', '091', '092', '093', '094', '095', '096', '097', '098', '099', '100', '101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119', '120', '121', '122', '123', '124', '125', '126', '127', '128', '129', '130', '131', '132', '133', '134', '135', '136', '137', '138', '139', '140', '141', '142', '143', '144', '145', '146', '147', '148', '149',
    ])
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(unwrapNormalizedMigrationTransaction(migration.sql).trim().length).toBeGreaterThan(0)
    }
    expect(migrations.filter((migration) => ['102', '103', '104'].includes(migration.version)).map(({ version, filename, checksum }) => ({ version, filename, checksum }))).toEqual([
      {
        version: '102',
        filename: '102_printer_management_permission.sql',
        checksum: '77e93d7e32dc7da3c9d71ec7893372d07842a3cdb0321351714796ce60e41e16',
      },
      {
        version: '103',
        filename: '103_home_content_display_mode.sql',
        checksum: '9ff3f562b7d67b5f076b95866cce16b814ca43adc02ac333aca0c9af8236f34c',
      },
      {
        version: '104',
        filename: '104_membership_terms_community_source.sql',
        checksum: '8804baccfbb3bf7b1371ace9e786214654c37203530e7e51598ea4bd2ab18680',
      },
    ])
  })

  it('adds revocable Windows print bridges and typed bridge-pull printer jobs', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '105')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.print_bridges/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.print_bridge_pairing_codes/)
    expect(migration?.sql).toMatch(/ADD COLUMN print_bridge_id uuid/)
    expect(migration?.sql).toMatch(/windows_queue_name text/)
    expect(migration?.sql).toMatch(/print_profile IN \('escpos_58','escpos_80','windows_text'\)/)
    expect(migration?.sql).toMatch(/delivery_mode IN \('cloud_adapter','bridge_pull'\)/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/schema_version='105'/)
  })

  it('separates customer-visible employee names, formal privacy policies and table-scoped carts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '106')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.employee_customer_public_profiles/)
    expect(migration?.sql).toMatch(/public_display_name text NOT NULL/)
    expect(migration?.sql).toMatch(/status IN \('draft','published','withdrawn'\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.privacy_policy_releases/)
    expect(migration?.sql).toMatch(/content_sha256 char\(64\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.guest_shared_carts/)
    expect(migration?.sql).toMatch(/generation integer NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.guest_shared_cart_operations/)
    expect(migration?.sql).toMatch(/guest_shared_cart_operations_append_only/)
    expect(migration?.sql).toMatch(/FORCE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/schema_version='106'/)
  })

  it('requires independent employee publication and formal privacy-policy operations', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '107')
    expect(migration?.sql).toMatch(/drafted_by_employee_id uuid/)
    expect(migration?.sql).toMatch(/approval_reference text/)
    expect(migration?.sql).toMatch(/customer\.public-profile\.manage/)
    expect(migration?.sql).toMatch(/privacy\.policy\.publish/)
    expect(migration?.sql).toMatch(/published employee customer profile is immutable until withdrawn/)
    expect(migration?.sql).toMatch(/published privacy policy is immutable until withdrawn/)
    expect(migration?.sql).toMatch(/schema_version='107'/)
  })

  it('keeps under-one-unit loyalty rewards as exact original-policy carry facts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '108')
    expect(migration?.sql).toMatch(/calculation_model IN \('per_order_rounded','exact_carry'\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_order_reward_contributions/)
    expect(migration?.sql).toMatch(/points_numerator_per_minor bigint NOT NULL/)
    expect(migration?.sql).toMatch(/reversed_eligible_amount_minor bigint NOT NULL DEFAULT 0/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_reward_carry_balances/)
    expect(migration?.sql).toMatch(/remainder_numerator bigint NOT NULL DEFAULT 0/)
    expect(migration?.sql).toMatch(/FORCE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/schema_version='108'/)
  })

  it('keeps annual benefit previews separate from confirmed dates and actual grants', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '109')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_annual_benefit_policy_versions/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_annual_benefit_occurrences/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.customer_annual_benefit_consents/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_annual_benefit_grants/)
    expect(migration?.sql).toMatch(/movable\/lunar festivals are never silently calculated/)
    expect(migration?.sql).toMatch(/schema_version='109'/)
  })

  it('keeps priority booking within capacity while using a short typed request hold', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '110')
    expect(migration?.sql).toMatch(/reservation_hold_minutes smallint/)
    expect(migration?.sql).toMatch(/reservation_hold_minutes BETWEEN 5 AND 30/)
    expect(migration?.sql).toMatch(/never bypasses capacity or table-lock conflict checks/)
    expect(migration?.sql).toMatch(/schema_version='110'/)
  })

  it('records authorized external collections as payments with mandatory reconciliation evidence', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '116')
    expect(migration?.sql).toMatch(/external_manual/)
    expect(migration?.sql).toMatch(/payments_external_manual_evidence_ck/)
    expect(migration?.sql).toMatch(/payment\.manual\.external\.record/)
    expect(migration?.sql).toMatch(/'OWNER', 'MANAGER', 'CASHIER'/)
    expect(migration?.sql).not.toMatch(/role\.code='SERVER'.*payment\.manual\.external\.record/s)
    expect(migration?.sql).toMatch(/schema_version='116'/)
  })

  it('separates member fulfillment, exceptions and management by permission', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '117')
    expect(migration?.sql).toMatch(/member-fulfillment.*loyalty\.redemption\.fulfill/s)
    expect(migration?.sql).toMatch(/member-exceptions.*loyalty\.redemption\.exception.*loyalty\.accrual\.exception\.view/s)
    expect(migration?.sql).toMatch(/member-management.*loyalty\.account\.view/s)
    expect(migration?.sql).toMatch(/\/staff\/member-management/)
    expect(migration?.sql).toMatch(/schema_version='117'/)
  })

  it('adds only the missing controlled menu-image permission for the beverage package', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '118')
    expect(migration?.sql).toMatch(/media\.asset\.menu\.manage/)
    expect(migration?.sql).toMatch(/库存与酒水上架/)
    expect(migration?.sql).not.toMatch(/inventory\.count\.approve/)
    expect(migration?.sql).toMatch(/schema_version='118'/)
  })

  it('makes employee shared-cart freezes explicit, reasoned and permission-scoped', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '119')
    expect(migration?.sql).toMatch(/guest_cart_writes_frozen boolean NOT NULL DEFAULT false/)
    expect(migration?.sql).toMatch(/length\(btrim\(coalesce\(guest_cart_freeze_reason, ''\)\)\) BETWEEN 2 AND 500/)
    expect(migration?.sql).toMatch(/guest\.cart\.freeze/)
    expect(migration?.sql).toMatch(/'OWNER', 'MANAGER', 'SERVER'/)
    expect(migration?.sql).toMatch(/schema_version='119'/)
  })

  it('separates all-table cashier collection scope from payment capability', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '120')
    expect(migration?.sql).toMatch(/payment\.collect\.all_tables/)
    expect(migration?.sql).toMatch(/'OWNER','OPS_LEAD','MANAGER','CASHIER'/)
    expect(migration?.sql).not.toMatch(/'SERVER'.*payment\.collect\.all_tables/s)
    expect(migration?.sql).toMatch(/schema_version='120'/)
  })

  it('makes annual gift stacking, inventory, substitution and revocation executable policy facts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '121')
    expect(migration?.sql).toMatch(/stack_group text/)
    expect(migration?.sql).toMatch(/priority smallint/)
    expect(migration?.sql).toMatch(/inventory_requirement/)
    expect(migration?.sql).toMatch(/revocation_policy/)
    expect(migration?.sql).toMatch(/feb29_policy/)
    expect(migration?.sql).toMatch(/loyalty_annual_benefit_rule_substitutes/)
    expect(migration?.sql).toMatch(/membership_annual_benefit_grants_stack_window_excl/)
    expect(migration?.sql).toMatch(/schema_version='121'/)
  })

  it('separates annual benefit redemption from physical fulfillment', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '122')
    expect(migration?.sql).toMatch(/status IN \('initiated','reserved','redeemed','fulfilled','cancelled','expired'\)/)
    expect(migration?.sql).toMatch(/redeemed_by_employee_id uuid/)
    expect(migration?.sql).toMatch(/gift_order_id uuid/)
    expect(migration?.sql).toMatch(/complete_annual_benefit_fulfillment_for_order/)
    expect(migration?.sql).toMatch(/schema_version='122'/)
  })

  it('holds real recipe inventory for a daily snack and releases it for retry or order conversion', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '123')
    expect(migration?.sql).toMatch(/annual_daily_snack_inventory_holds/)
    expect(migration?.sql).toMatch(/reserved_quantity=reserved_quantity-hold_row\.quantity/)
    expect(migration?.sql).toMatch(/convert_annual_daily_snack_inventory_hold/)
    expect(migration?.sql).toMatch(/OLD\.status IN \('cancelled','expired'\) AND NEW\.status='initiated'/)
    expect(migration?.sql).toMatch(/schema_version='123'/)
  })

  it('persists complimentary fulfillment as a post-commit retryable intent', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '124')
    expect(migration?.sql).toMatch(/complimentary_fulfillment_intents/)
    expect(migration?.sql).toMatch(/status IN \('pending','retry','dispatched','failed'\)/)
    expect(migration?.sql).toMatch(/next_attempt_at/)
    expect(migration?.sql).toMatch(/schema_version='124'/)
  })

  it('deduplicates a shared-cart operation across submitted and open generations',async () => {
    const migration=(await loadNormalizedMigrations()).find((entry)=>entry.version==='125')
    expect(migration?.sql).toMatch(/ADD COLUMN table_session_id uuid/)
    expect(migration?.sql).toMatch(/scope_operation_id/)
    expect(migration?.sql).toMatch(/conflicting cross-generation requests/)
    expect(migration?.sql).toMatch(/guest_shared_cart_operations_table_operation_uq/)
    expect(migration?.sql).toMatch(/schema_version='125'/)
  })

  it('persists every authenticated shared-cart write attempt outside the business rollback path',async()=>{
    const migration=(await loadNormalizedMigrations()).find((entry)=>entry.version==='130')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.guest_shared_cart_write_attempts/)
    expect(migration?.sql).toMatch(/actor_session_ref.*sha256/)
    expect(migration?.sql).toMatch(/guest_shared_cart_write_attempts_window_idx/)
    expect(migration?.sql).toMatch(/FORCE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/schema_version='130'/)
  })

  it('keeps the SERVER assisted-payment template for roles created after migration',async()=>{
    const migration=(await loadNormalizedMigrations()).find((entry)=>entry.version==='131')
    expect(migration?.sql).toMatch(/seed_server_assisted_payment_permission/)
    expect(migration?.sql).toMatch(/NEW\.code='SERVER'/)
    expect(migration?.sql).toMatch(/payment\.initiate\.staff/)
    expect(migration?.sql).not.toMatch(/payment\.collect\.all_tables/)
    expect(migration?.sql).toMatch(/limit_cashier_navigation_to_cashier_authority/)
    expect(migration?.sql).toMatch(/schema_version='131'/)
  })

  it('keeps member fulfillment narrow but available to SERVER roles created after migration',async()=>{
    const migration=(await loadNormalizedMigrations()).find((entry)=>entry.version==='132')
    expect(migration?.sql).toMatch(/seed_server_member_fulfillment_permission/)
    expect(migration?.sql).toMatch(/NEW\.code='SERVER'/)
    expect(migration?.sql).toMatch(/loyalty\.redemption\.fulfill/)
    expect(migration?.sql).not.toMatch(/permission\.code='benefit\.cancel'/)
    expect(migration?.sql).not.toMatch(/permission\.code='table\.view_all'/)
    expect(migration?.sql).toMatch(/schema_version='132'/)
  })

  it('records priority booking as an immutable reservation fact', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '111')
    expect(migration?.sql).toMatch(/annual_priority_rule_id uuid/)
    expect(migration?.sql).toMatch(/annual_priority_hold_minutes smallint/)
    expect(migration?.sql).toMatch(/assert_reservation_annual_priority_rule/)
    expect(migration?.sql).toMatch(/schema_version='111'/)
  })

  it('makes each daily snack a table-bound, once-per-business-day claim before fulfillment', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '112')
    expect(migration?.sql).toMatch(/redemption_hold_minutes smallint/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.annual_daily_snack_claims/)
    expect(migration?.sql).toMatch(/membership_id,rule_id,business_date/)
    expect(migration?.sql).toMatch(/benefit_reservation_id/)
    expect(migration?.sql).toMatch(/complete_annual_benefit_grant_from_redemption/)
    expect(migration?.sql).toMatch(/schema_version='112'/)
  })

  it('keeps priority eligibility on the waitlist as a typed queue fact', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '113')
    expect(migration?.sql).toMatch(/ALTER TABLE mbox\.waitlist_entries/)
    expect(migration?.sql).toMatch(/annual_priority_rule_id uuid/)
    expect(migration?.sql).toMatch(/assert_waitlist_annual_priority_rule/)
    expect(migration?.sql).toMatch(/never converts a[\s-]+full venue into available capacity/)
    expect(migration?.sql).toMatch(/schema_version='113'/)
  })

  it('makes employee priority-queue overrides reasoned, append-only ordering decisions', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '114')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.reservation_priority_queue_overrides/)
    expect(migration?.sql).toMatch(/mode IN \('promote','demote','clear'\)/)
    expect(migration?.sql).toMatch(/length\(btrim\(reason\)\) BETWEEN 2 AND 500/)
    expect(migration?.sql).toMatch(/reservation_priority_queue_overrides_append_only/)
    expect(migration?.sql).toMatch(/never bypasses capacity, table-lock or confirmation rules/)
    expect(migration?.sql).toMatch(/schema_version='114'/)
  })

  it('grants standard service roles assisted online collection but not cash or POS recording', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '115')
    expect(migration?.sql).toMatch(/role\.code='SERVER'/)
    expect(migration?.sql).toMatch(/permission\.code='payment\.initiate\.staff'/)
    expect(migration?.sql).not.toMatch(/payment\.manual\.cash\.record/)
    expect(migration?.sql).not.toMatch(/payment\.manual\.pos\.record/)
    expect(migration?.sql).toMatch(/schema_version='115'/)
  })

  it('keeps recommendation publication separate from customer rollout', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '092')
    expect(migration?.sql).toMatch(/publication_mode IN \('legacy_unverified','separated'\)/)
    expect(migration?.sql).toMatch(/pre-092 approved recommendation policy cannot be migrated without approval rationale/)
    expect(migration?.sql).toMatch(/published_by_employee_id<>approved_by_employee_id/)
    expect(migration?.sql).toMatch(/recommendation_policy_versions_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/recommendation\.engine','disabled'/)
    expect(migration?.sql).toMatch(/recommendation pilot requires a current managed three-person policy/)
    expect(migration?.sql).toMatch(/role\.code='MANAGER'.*recommendation\.rule\.view.*recommendation\.rule\.draft/s)
    expect(migration?.sql).toMatch(/role\.code='OPS_LEAD'.*recommendation\.rule\.approve/s)
    expect(migration?.sql).toMatch(/role\.code='OWNER'.*recommendation\.rule\.publish/s)
    expect(migration?.sql).toMatch(/schema_version='092'/)
  })

  it('keeps staff recommendation modifications strongly linked, scoped and idempotent', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '093')
    expect(migration?.sql).toMatch(/source_recommendation_option_id uuid/)
    expect(migration?.sql).toMatch(/actor_employee_id uuid/)
    expect(migration?.sql).toMatch(/staff_modification_reason_code text/)
    expect(migration?.sql).toMatch(/staff_modification_idempotency_key text/)
    expect(migration?.sql).toMatch(/staff_modification_request_sha256 char\(64\)/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_source_session_fk/)
    expect(migration?.sql).toMatch(/source_recommendation_option_id<>recommendation_option_id/)
    expect(migration?.sql).toMatch(/recommendation\.staff\.modify\.all/)
    expect(migration?.sql).toMatch(/pre-093 staff_modified recommendation events require manual authority review/)
    expect(migration?.sql).not.toMatch(/(?:actor_employee_id|staff_modification_reason_code)\s*=.*(?:snapshot|metadata|evidence)/s)
    expect(migration?.sql).toMatch(/schema_version='093'/)
  })

  it('keeps membership configuration edits and impact approvals as strong immutable facts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '094')
    expect(migration?.sql).toMatch(/membership_configuration_draft_contributors/)
    expect(migration?.sql).toMatch(/membership_configuration_impact_previews/)
    expect(migration?.sql).toMatch(/membership_configuration_impact_fulfillment_facts/)
    expect(migration?.sql).toMatch(/membership_configuration_approval_facts/)
    expect(migration?.sql).toMatch(/a membership configuration contributor cannot approve the same draft/)
    expect(migration?.sql).toMatch(/expires_at<=clock_timestamp\(\)/)
    expect(migration?.sql).toMatch(/loyalty\.configuration\.approve/)
    expect(migration?.sql).not.toMatch(/(?:policy|content|configuration|impact)_json/)
    expect(migration?.sql).toMatch(/schema_version='094'/)
  })

  it('normalizes personal contacts while preserving correction and retention boundaries', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '095')
    expect(migration?.sql).toMatch(/community_activity_registration_contact_versions/)
    expect(migration?.sql).not.toMatch(/DROP COLUMN contact_snapshot/)
    expect(migration?.sql).toMatch(/ALTER COLUMN contact_snapshot DROP NOT NULL/)
    expect(migration?.sql).toMatch(/community_activity_registrations_legacy_contact_mirror/)
    expect(migration?.sql).toMatch(/prepare_legacy_verified_contact_write/)
    expect(migration?.sql).toMatch(/customer_verified_contacts_one_active_idx/)
    expect(migration?.sql).toMatch(/customer_verified_contact_actions/)
    expect(migration?.sql).toMatch(/personal_contact_retention_policy_versions/)
    expect(migration?.sql).toMatch(/personal_contact_legal_holds/)
    expect(migration?.sql).toMatch(/activity_contact_access_events/)
    expect(migration?.sql).toMatch(/drafted_by_employee_id<>approved_by_employee_id|approved_by_employee_id<>drafted_by_employee_id/)
    expect(migration?.sql).toMatch(/published_by_employee_id<>approved_by_employee_id/)
    expect(migration?.sql).not.toMatch(/retention_days_after_purpose_end\s+(?:integer\s+)?(?:NOT NULL\s+)?DEFAULT/)
    expect(migration?.sql).toMatch(/schema_version='095'/)
  })

  it('keeps table customer location movements strong, segmented and access revoking', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '096')
    expect(migration?.sql).toMatch(/table_customer_movement_events/)
    expect(migration?.sql).toMatch(/table_customer_movement_members/)
    expect(migration?.sql).toMatch(/ADD COLUMN table_id uuid/)
    expect(migration?.sql).toMatch(/apply_table_customer_movement_member/)
    expect(migration?.sql).toMatch(/REVOKE INSERT,UPDATE,DELETE ON TABLE mbox\.table_session_customer_participations/)
    expect(migration?.sql).toMatch(/service task origin table must match its table session/)
    expect(migration?.sql).toMatch(/table\.participation\.manage/)
    expect(migration?.sql).not.toMatch(/(?:movement|participation|location)_(?:snapshot|configuration)\s+jsonb/)
  })

  it('keeps quantity inventory opt-out explicit and limited to product configuration', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '097')
    expect(migration?.sql).toMatch(/inventory_control_mode/)
    expect(migration?.sql).toMatch(/CHECK \(inventory_control_mode IN \('tracked', 'not_managed'\)\)/)
    expect(migration?.sql).toMatch(/WHERE category_code = 'food'/)
    expect(migration?.sql).not.toMatch(/999999|infinity/i)
  })

  it('keeps unpaid order cancellation permissioned, append-only and payment fail-closed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '098')
    expect(migration?.sql).toMatch(/order_cancellation_events/)
    expect(migration?.sql).toMatch(/cancel_unpaid_order/)
    expect(migration?.sql).toMatch(/order\.cancel_unpaid/)
    expect(migration?.sql).toMatch(/payment\.status NOT IN \('failed','closed'\)/)
    expect(migration?.sql).toMatch(/status NOT IN \('delivered','cancelled'\)/)
    expect(migration?.sql).toMatch(/order_cancellation_events_append_only/)
    expect(migration?.sql).toMatch(/REVOKE INSERT,UPDATE,DELETE ON TABLE mbox\.order_cancellation_events/)
  })

  it('keeps a fixed store login credential reusable without making device or employee sessions permanent', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '099')
    expect(migration?.sql).toMatch(/reusable_across_business_dates boolean NOT NULL DEFAULT false/)
    expect(migration?.sql).toMatch(/Device leases and employee sessions retain their own expiry/)
    expect(migration?.sql).toMatch(/schema_version='099'/)
  })

  it('keeps delivered unpaid settlement exceptions distinct from payments and owner-gated for test cleanup', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '101')
    expect(migration?.sql).toMatch(/order_settlement_exception_events/)
    expect(migration?.sql).toMatch(/settle_cancelled_unpaid_order_exception/)
    expect(migration?.sql).toMatch(/reason_code IN \('manager_comp','uncollectible','test_cleanup'\)/)
    expect(migration?.sql).toMatch(/role\.code='OWNER'/)
    expect(migration?.sql).toMatch(/order\.settle_exception/)
    expect(migration?.sql).toMatch(/REVOKE INSERT,UPDATE,DELETE ON TABLE mbox\.order_settlement_exception_events/)
  })

  it('keeps uploaded public images and recipe costs strong, bounded and append-only', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '100')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.media_assets/)
    expect(migration?.sql).toMatch(/byte_length BETWEEN 1 AND 204800/)
    expect(migration?.sql).toMatch(/media_assets_append_only/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.recipe_cost_versions/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.recipe_cost_components/)
    expect(migration?.sql).toMatch(/cost_source IN \('manual','recipe'\)/)
    expect(migration?.sql).toMatch(/schema_version='100'/)
  })

  it('gives homepage content an explicit pinned or rotating display mode', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '103')
    expect(migration?.sql).toMatch(/ADD COLUMN display_mode text NOT NULL DEFAULT 'rotation'/)
    expect(migration?.sql).toMatch(/display_mode IN \('pinned', 'rotation'\)/)
    expect(migration?.sql).toMatch(/schema_version='103'/)
  })

  it('allows explicit community membership consent as a separate mini-program source', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '104')
    expect(migration?.sql).toMatch(/acknowledgement_source IN \('mini_menu','mini_profile','mini_community'\)/)
    expect(migration?.sql).toMatch(/schema_version='104'/)
  })

  it('keeps the production-applied printer permission migration immutable', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '102')
    expect(migration?.sql).toMatch(/'printer\.manage'/)
    expect(migration?.sql).toMatch(/不授权摄像头、耳机、钱箱或其他硬件控制/)
    expect(migration?.sql).toMatch(/schema_version='102'/)
  })

  it('keeps refund roles and amount limits configurable while requiring two employees', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '049')
    expect(migration?.sql).toMatch(/'refund\.request',\s*'退款发起额度'/)
    expect(migration?.sql).toMatch(/ARRAY\['refund\.request'\]::text\[\]/)
    expect(migration?.sql).toMatch(/'refund\.approve',\s*'退款复核额度'/)
    expect(migration?.sql).toMatch(/复核人与发起人必须为不同员工/)
  })

  it('fails closed for every checkout-upgrade rollout that predates atomic capacity holds', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '053')
    expect(migration?.sql).toMatch(/UPDATE mbox\.customer_experience_features[\s\S]*feature_code='checkout_upgrade'/)
    expect(migration?.sql).toMatch(/SET rollout_state='disabled'/)
    expect(migration?.sql).toMatch(/rollout_state IN \('pilot','enabled'\)/)
  })

  it('rejects migration gaps and files without one transaction wrapper', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, '002_gap.sql'), 'BEGIN; SELECT 1; COMMIT;\n')
    await expect(loadNormalizedMigrations(directory)).rejects.toThrow('不连续')

    await rm(join(directory, '002_gap.sql'))
    await writeFile(join(directory, '001_unwrapped.sql'), 'SELECT 1;\n')
    await expect(loadNormalizedMigrations(directory)).rejects.toThrow('BEGIN/COMMIT')
  })

  it('permits documentation comments before BEGIN without permitting executable SQL outside the transaction', () => {
    expect(unwrapNormalizedMigrationTransaction('-- migration purpose\nBEGIN; SELECT 1; COMMIT;'))
      .toContain('SELECT 1')
    expect(unwrapNormalizedMigrationTransaction('/* migration purpose */\nBEGIN; SELECT 1; COMMIT;'))
      .toContain('SELECT 1')
    expect(() => unwrapNormalizedMigrationTransaction('SELECT 0; BEGIN; SELECT 1; COMMIT;'))
      .toThrow('单一BEGIN/COMMIT事务')
  })

  it('removes the legacy product JSON write adapter from the normalized runtime', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '056')
    expect(migration?.sql).toMatch(/DROP TRIGGER IF EXISTS products_operational_rollback_compatibility/)
    expect(migration?.sql).toMatch(/DROP FUNCTION IF EXISTS mbox\.sync_product_operational_rollback_compatibility/)
    expect(migration?.sql).toMatch(/Historical display snapshots\s+-- remain available/)
  })

  it('keeps provider refund submission identity and timing out of free JSON evidence', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '057')
    expect(migration?.sql).toMatch(/ADD COLUMN merchant_refund_id text/)
    expect(migration?.sql).toMatch(/ADD COLUMN provider_submission_started_at timestamptz/)
    expect(migration?.sql).toMatch(/provider_submission_state='manual_review'[\s\S]*WHERE status='processing'/)
    expect(migration?.sql).not.toMatch(/provider_snapshot\s*->>?\s*'merchantRefundId'/)
  })

  it('keeps the payment settlement rail strong without promoting historical JSON', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '058')
    expect(migration?.sql).toMatch(/ADD COLUMN settlement_channel text/)
    expect(migration?.sql).toMatch(/settlement_channel IN \('wechat', 'alipay', 'unionpay'\)/)
    expect(migration?.sql).not.toMatch(/UPDATE mbox\.payments[\s\S]*provider_snapshot/)
  })

  it('requires a single-use strong provider observation instead of JSON verification flags', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '065')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.verified_provider_observations/)
    expect(migration?.sql).toMatch(/verification_kind IN \('callback_signature', 'active_query_binding'\)/)
    expect(migration?.sql).toMatch(/observed_status text NOT NULL/)
    expect(migration?.sql).toMatch(/reported_amount_minor bigint NOT NULL/)
    expect(migration?.sql).toMatch(/consumed_operation text/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).not.toMatch(/jsonb/)
  })

  it('requires versioned three-person membership terms and append-only typed acceptances', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '081')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_terms_versions/)
    expect(migration?.sql).toMatch(/status IN \('draft','approved','published'\)/)
    expect(migration?.sql).toMatch(/published_by_employee_id<>approved_by_employee_id/)
    expect(migration?.sql).toMatch(/membership_terms_versions_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_terms_acceptances/)
    expect(migration?.sql).toMatch(/acknowledgement_source IN \('mini_menu','mini_profile'\)/)
    expect(migration?.sql).toMatch(/membership_terms_acceptances_append_only/)
    expect(migration?.sql).toMatch(/membership\.terms\.publish/)
    expect(migration?.sql).not.toMatch(/jsonb/)
  })

  it('records the Superhigh membership invitation as its own mini-program entry', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '104')
    expect(migration?.sql).toMatch(/'mini_community'/)
    expect(migration?.sql).toMatch(/schema_version='104'/)
  })

  it('tracks every loyalty refund application as a strong append-only idempotency fact', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '082')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_award_refund_applications/)
    expect(migration?.sql).toMatch(/eligible_refund_amount_minor bigint NOT NULL/)
    expect(migration?.sql).toMatch(/UNIQUE \(tenant_id, store_id, refund_id\)/)
    expect(migration?.sql).toMatch(/loyalty_award_refund_applications_append_only/)
    expect(migration?.sql).toMatch(/refund facts do not reconcile with loyalty award aggregates/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).not.toMatch(/jsonb/)
  })

  it('keeps WeChat loyalty notification eligibility, timing, values and receipts strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '083')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_notification_policies/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_notification_authorizations/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_customer_notification_jobs/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_notification_receipts/)
    expect(migration?.sql).toMatch(/authorization_purpose text NOT NULL/)
    expect(migration?.sql).toMatch(/authorization_context text NOT NULL/)
    expect(migration?.sql).toMatch(/quiet_hours_start time/)
    expect(migration?.sql).toMatch(/max_per_customer_per_24h integer NOT NULL/)
    expect(migration?.sql).not.toMatch(/\b(?:payload|snapshot|metadata)\s+jsonb\b/i)
    expect(migration?.sql).toMatch(/schema_version='083'/)
  })

  it('keeps customer product restrictions and live performance phase gates strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '085')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.customer_product_restrictions/)
    expect(migration?.sql).toMatch(/restriction_type IN \('dislike','allergy_or_cannot_consume'\)/)
    expect(migration?.sql).toMatch(/source_customer_id uuid NOT NULL/)
    expect(migration?.sql).toMatch(/customer_product_restrictions_assert_family/)
    expect(migration?.sql).toMatch(/customer_product_restrictions_active_uq[\s\S]*customer_id, product_id/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.product_performance_phase_eligibilities/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.schedule_performance_phase_events/)
    expect(migration?.sql).toMatch(/schedule_performance_phase_events_store_active_uq/)
    expect(migration?.sql).toMatch(/performance\.phase\.manage/)
    expect(migration?.sql).toMatch(/recommendation\.phase\.configure/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/g)
    expect(migration?.sql).not.toMatch(/jsonb|->>?/)
    expect(migration?.sql).toMatch(/schema_version='085'/)
  })

  it('keeps loyalty emergency controls and deferred paid-order accrual strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '087')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_operational_control_events/)
    expect(migration?.sql).toMatch(/capability IN \([\s\S]*'points_accrual'[\s\S]*'points_redemption'[\s\S]*'wechat_notification'/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_accrual_deferred_orders/)
    expect(migration?.sql).toMatch(/payment_succeeded_at timestamptz NOT NULL/)
    expect(migration?.sql).toMatch(/loyalty_operational_control_events_append_only/)
    expect(migration?.sql).toMatch(/loyalty\.operations\.control/)
    expect(migration?.sql).toMatch(/role\.code='OWNER'/)
    expect(migration?.sql).not.toMatch(/jsonb/)
    expect(migration?.sql).toMatch(/schema_version='087'/)
  })

  it('keeps activity waitlist promotion, payment intent and promise locking strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '088')
    expect(migration?.sql).toMatch(/ADD COLUMN requested_payment_choice text/)
    expect(migration?.sql).toMatch(/ADD COLUMN requested_payment_method text/)
    expect(migration?.sql).toMatch(/ADD COLUMN requested_amount_due_minor bigint/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.activity_waitlist_release_events/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.activity_waitlist_promotions/)
    expect(migration?.sql).toMatch(/FOREIGN KEY \(tenant_id,store_id,payment_id\)/)
    expect(migration?.sql).toMatch(/FOREIGN KEY \(tenant_id,store_id,notification_id\)/)
    expect(migration?.sql).toMatch(/published activity promises are immutable/)
    expect(migration?.sql).toMatch(/points_reward=0/)
    expect(migration?.sql).not.toMatch(/requested_payment_\w+\s+jsonb/)
    expect(migration?.sql).toMatch(/schema_version='088'/)
  })

  it('keeps checkout upgrades versioned, three-person released and strongly attributed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '089')
    expect(migration?.sql).toMatch(/checkout_upgrade_rules_code_revision_uq/)
    expect(migration?.sql).toMatch(/checkout_upgrade_rule_release_protect/)
    expect(migration?.sql).toMatch(/third independent publisher/)
    expect(migration?.sql).toMatch(/converted_order_item_id uuid/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.checkout_upgrade_offer_events/)
    expect(migration?.sql).toMatch(/event_type IN \('offered','viewed','declined','accepted','converted','invalidated'\)/)
    expect(migration?.sql).toMatch(/ADD COLUMN related_order_id uuid/)
    expect(migration?.sql).toMatch(/status IN \('draft','approved','published','retired'\)/)
    expect(migration?.sql).toMatch(/fulfillment\.capacity\.publish/)
    expect(migration?.sql).toMatch(/rollout_state='disabled'/)
    expect(migration?.sql).toMatch(/schema_version='089'/)
    expect(migration?.sql).not.toMatch(/(?:capacity_limit|minimum_party_size|priority|status)\w*\s+jsonb/i)
  })

  it('keeps performance revisions, reservation decisions and contextual messages strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '090')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.performance_schedule_revisions/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.reservation_performance_impacts/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.reservation_performance_acknowledgements/)
    expect(migration?.sql).toMatch(/guard_performance_schedule_revision/)
    expect(migration?.sql).toMatch(/guard_reservation_performance_acknowledgement/)
    expect(migration?.sql).toMatch(/authorization_context='reservation'/)
    expect(migration?.sql).toMatch(/notification_type='reservation_performance_revised'/)
    expect(migration?.sql).toMatch(/reservation_performance_notification_authorization_uses/)
    expect(migration?.sql).toMatch(/performance\.schedule\.revise/)
    expect(migration?.sql).not.toMatch(/(?:revision|impact|acknowledgement|authorization|job)_snapshot\s+jsonb/i)
    expect(migration?.sql).not.toMatch(/reservation_snapshot\s*->|->>?/)
    expect(migration?.sql).toMatch(/schema_version='090'/)
  })

  it('keeps promotion rules, authoritative triggers, budgets and reversals strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '091')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_promotion_policy_versions/)
    expect(migration?.sql).toMatch(/status IN \([\s\S]*'draft'[\s\S]*'approved'[\s\S]*'published'/)
    expect(migration?.sql).toMatch(/published_by_employee_id<>approved_by_employee_id/)
    expect(migration?.sql).toMatch(/store_budget_points integer NOT NULL/)
    expect(migration?.sql).toMatch(/per_member_points_limit integer NOT NULL/)
    expect(migration?.sql).toMatch(/stacking_mode text NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_promotion_trigger_facts/)
    expect(migration?.sql).toMatch(/'activity_payment','activity_check_in','activity_completion'/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_promotion_refund_applications/)
    expect(migration?.sql).toMatch(/payments_capture_loyalty_promotion_trigger/)
    expect(migration?.sql).toMatch(/community_activity_registrations_capture_promotion_check_in/)
    expect(migration?.sql).toMatch(/community_activities_capture_promotion_completion/)
    expect(migration?.sql).toMatch(/points_accrual_paused/)
    expect(migration?.sql).toMatch(/loyalty\.promotion\.publish/)
    expect(migration?.sql).toMatch(/points_reward stays disabled/)
    expect(migration?.sql).not.toMatch(/(?:policy|rule|trigger|award|refund)_snapshot\s+jsonb/i)
    expect(migration?.sql).toMatch(/schema_version='091'/)
  })

  it('keeps canonical preferences, decay and paid experience-plan activation strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '086')
    expect(migration?.sql).toMatch(/preference_half_life_days integer NOT NULL/)
    expect(migration?.sql).toMatch(/preference_min_effective_score integer NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.customer_preference_declarations/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.customer_preference_withdrawals/)
    expect(migration?.sql).toMatch(/allowed_for_recommendation boolean NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.experience_plan_activation_events/)
    expect(migration?.sql).toMatch(/activation_gate IN \('deferred_order','verified_payment'\)/)
    expect(migration?.sql).toMatch(/experience_plan_cues_require_activation/)
    expect(migration?.sql).toMatch(/legacy_unverified_order_binding/)
    expect(migration?.sql).toMatch(/customer_experience_plans_require_order_binding/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/g)
    expect(migration?.sql).not.toMatch(/(?:configuration|metadata|evidence)_snapshot\s*->|->>?/)
    expect(migration?.sql).toMatch(/schema_version='086'/)
  })

  it('keeps redemption timeout recovery, original-lot restoration and inventory returns strongly typed', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '084')
    expect(migration?.sql).toMatch(/ADD COLUMN recovery_state text NOT NULL DEFAULT 'not_required'/)
    expect(migration?.sql).toMatch(/recovery_state IN \('not_required','manual_review','restored'\)/)
    expect(migration?.sql).toMatch(/ADD COLUMN points_restored integer NOT NULL DEFAULT 0/)
    expect(migration?.sql).toMatch(/ADD COLUMN restoration_movement_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN return_movement_id uuid/)
    expect(migration?.sql).toMatch(/status IN \('reserved','consumed','released','returned'\)/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY|member_redemptions_recovery_shape_check/)
    expect(migration?.sql).not.toMatch(/\b(?:configuration|metadata|snapshot|evidence)\s+jsonb\b|->>?/i)
  })

  it('models fulfillment capacity entirely with strong version, window, unit and state fields', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '060')
    expect(migration?.sql).toMatch(/ADD COLUMN capacity_units integer NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.fulfillment_capacity_policy_versions/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.fulfillment_capacity_windows/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.fulfillment_capacity_reservations/)
    expect(migration?.sql).toMatch(/status text NOT NULL DEFAULT 'reserved'[\s\S]*reserved[\s\S]*active[\s\S]*released/)
    expect(migration?.sql).toMatch(/NEW\.status IN \('ready','cancelled','failed'\)/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/g)
    expect(migration?.sql).not.toMatch(/jsonb|configuration_snapshot|metadata json/)
  })

  it('stores WeChat notification authorization results in typed fields instead of free JSON keys', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '076')
    expect(migration?.sql).toMatch(/ADD COLUMN template_id text/)
    expect(migration?.sql).toMatch(/ADD COLUMN authorization_context text/)
    expect(migration?.sql).toMatch(/ADD COLUMN platform_result text/)
    expect(migration?.sql).toMatch(/platform_result IN \('accept','reject','ban'\)/)
    expect(migration?.sql).not.toMatch(/evidence_snapshot\s*->/)
  })

  it('versions automatic tier benefits and preserves fulfilled or reserved rights on downgrade', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '078')
    expect(migration?.sql).toMatch(/membership_tier_events_transition_semantics_ck/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_tier_benefit_policy_versions/)
    expect(migration?.sql).toMatch(/approved_by_employee_id<>drafted_by_employee_id/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.loyalty_tier_benefit_rules/)
    expect(migration?.sql).toMatch(/revocation_policy IN \('revoke_unreserved','protect_until_expiry'\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_tier_benefit_grants/)
    expect(migration?.sql).toMatch(/status IN \('active','revocation_pending','revoked','fulfilled','expired'\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_tier_benefit_events/)
    expect(migration?.sql).toMatch(/membership_tier_benefit_events_append_only/)
    expect(migration?.sql).toMatch(/OLD\.status IN \('revoked','fulfilled','expired'\)/)
    expect(migration?.sql).toMatch(/NEW\.quantity_redeemed>0[\s\S]*THEN 'fulfilled'/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).not.toMatch(/jsonb|configuration_snapshot|metadata json|->>?/)
  })

  it('keeps membership recovery evidence strong, private and maker-checker controlled', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '079')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.customer_verified_contacts/)
    expect(migration?.sql).toMatch(/contact_hash char\(64\) NOT NULL/)
    expect(migration?.sql).toMatch(/encrypted_value bytea NOT NULL/)
    expect(migration?.sql).toMatch(/verification_source IN \('wechat_phone_authorization', 'staff_controlled'\)/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_recovery_challenges/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_recovery_candidates/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_recovery_verifications/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.membership_merge_cases/)
    expect(migration?.sql).toMatch(/selected_by_employee_id IS NULL OR selected_by_employee_id<>approved_by_employee_id/)
    expect(migration?.sql).toMatch(/membership_merge_actions_append_only/)
    expect(migration?.sql).not.toMatch(/jsonb|phone_snapshot|candidate_snapshot|merge_snapshot|->>?/)
  })

  it('separates loyalty approval from publication without future-effective gaps or overlaps', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '080')
    expect(migration?.sql).toMatch(/status IN \('draft','approved','published','paused','retired'\)/)
    expect(migration?.sql).toMatch(/published_by_employee_id uuid/)
    expect(migration?.sql).toMatch(/publication_mode IN \('legacy_combined','separated'\)/)
    expect(migration?.sql).toMatch(/legacy_combined preserves historical combined approvals/)
    expect(migration?.sql).toMatch(/loyalty_policy_versions_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/loyalty_tier_policy_versions_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/redemption_catalog_versions_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/loyalty_tier_benefit_policy_no_published_overlap_excl/)
    expect(migration?.sql).toMatch(/DEFERRABLE INITIALLY IMMEDIATE/g)
    expect(migration?.sql).toMatch(/publication would create an effective-time gap/)
    expect(migration?.sql).toMatch(/'loyalty\.policy\.publish'/)
    expect(migration?.sql).toMatch(/'loyalty\.redemption\.catalog\.publish'/)
    expect(migration?.sql).not.toMatch(/jsonb|configuration_snapshot|metadata json|->>?/)
  })

  it('moves audience eligibility and reservation seat preference out of runtime JSON', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '061')
    expect(migration?.sql).toMatch(/community_activities[\s\S]*ADD COLUMN audience_member_levels text\[\]/)
    expect(migration?.sql).toMatch(/ADD COLUMN audience_lifecycle_stages text\[\]/)
    expect(migration?.sql).toMatch(/member_content_cards[\s\S]*ADD COLUMN audience_visibility text/)
    expect(migration?.sql).toMatch(/ADD COLUMN seat_preference text NOT NULL/)
    expect(migration?.sql).toMatch(/seat_preference IN \([\s\S]*stage_atmosphere[\s\S]*outdoor_view/)
    expect(migration?.sql).toMatch(/UPDATE mbox\.community_activities[\s\S]*audience_rule/)
    expect(migration?.sql).toMatch(/UPDATE mbox\.reservations[\s\S]*reservation_snapshot->>'seatPreference'/)
  })

  it('publishes and acknowledges activities from strong policy fields', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '062')
    expect(migration?.sql).toMatch(/ADD COLUMN safety_policy_version text/)
    expect(migration?.sql).toMatch(/ADD COLUMN safety_requirements text\[\]/)
    expect(migration?.sql).toMatch(/ADD COLUMN refund_policy_version text/)
    expect(migration?.sql).toMatch(/ADD COLUMN activity_details text/)
    expect(migration?.sql).toMatch(/community_activities_published_contract_check/)
    expect(migration?.sql).toMatch(/UPDATE mbox\.community_activities[\s\S]*safety_snapshot/)
  })

  it('uses a scoped relation instead of benefit snapshot keys for gift products', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '063')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.benefit_allowed_products/)
    expect(migration?.sql).toMatch(/FOREIGN KEY \(tenant_id, store_id, benefit_id\)/)
    expect(migration?.sql).toMatch(/FOREIGN KEY \(tenant_id, store_id, product_id\)/)
    expect(migration?.sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/INSERT INTO mbox\.benefit_allowed_products[\s\S]*benefit_snapshot/)
  })

  it('moves staff data scopes and approval calculations to strong columns', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '064')
    expect(migration?.sql).toMatch(/role_data_scopes[\s\S]*ADD COLUMN value_kind text/)
    expect(migration?.sql).toMatch(/ADD COLUMN text_values text\[\]/)
    expect(migration?.sql).toMatch(/role_data_scopes_strong_value_check/)
    expect(migration?.sql).toMatch(/role_approval_limits[\s\S]*ADD COLUMN calculation_mode text/)
    expect(migration?.sql).toMatch(/ADD COLUMN discount_basis_points integer/)
    expect(migration?.sql).toMatch(/ADD COLUMN allow_full_gift boolean/)
    expect(migration?.sql).toMatch(/role_approval_limits_strong_calculation_check/)
  })

  it('freezes order submission cost in strong columns and quarantines uncertain history', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '066')
    expect(migration?.sql).toMatch(/ADD COLUMN unit_cost_minor_at_submission bigint/)
    expect(migration?.sql).toMatch(/ADD COLUMN total_cost_minor_at_submission bigint/)
    expect(migration?.sql).toMatch(/ADD COLUMN cost_source text NOT NULL DEFAULT 'unavailable'/)
    expect(migration?.sql).toMatch(/ADD COLUMN cost_reference_product_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN cost_reference_order_item_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN cost_reference_product_updated_at timestamptz/)
    expect(migration?.sql).toMatch(/order_items_submission_cost_ck/)
    expect(migration?.sql).toMatch(/'catalog_product', 'legacy_snapshot', 'included_in_parent', 'unavailable'/)
    expect(migration?.sql).toMatch(/WHEN accepted\.accepted_total IS NULL[\s\S]*THEN 'unavailable'/)
    expect(migration?.sql).toMatch(/unit_cost_present AND unit_cost IS NULL/)
    expect(migration?.sql).toMatch(/total_cost_present AND total_cost IS NULL/)
    expect(migration?.sql).toMatch(/runtime cost and contribution calculations must use strong columns/)
    expect(migration?.sql).toMatch(/CREATE TRIGGER order_items_submission_costs_immutable/)
    expect(migration?.sql).toMatch(/Order item submission cost evidence is immutable/)
  })

  it('stores WeChat identity and bearer sessions as encrypted strong facts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '071')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_auth_challenges/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_identities/)
    expect(migration?.sql).toMatch(/openid_sha256 char\(64\) NOT NULL/)
    expect(migration?.sql).toMatch(/openid_ciphertext bytea NOT NULL/)
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.wechat_identity_sessions/)
    expect(migration?.sql).toMatch(/access_token_sha256 varchar\(43\) NOT NULL/)
    expect(migration?.sql).toMatch(/principal_ciphertext bytea NOT NULL/)
    expect(migration?.sql).toMatch(/REFERENCES mbox\.customer_memberships/)
    expect(migration?.sql).toMatch(/FORCE ROW LEVEL SECURITY/g)
    expect(migration?.sql).not.toMatch(/openid text|unionid text|access_token text|jsonb/)
  })

  it('records activity safety and refund terms in strong registration fields', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '067')
    expect(migration?.sql).toMatch(/ADD COLUMN acknowledged_safety_policy_version text/)
    expect(migration?.sql).toMatch(/ADD COLUMN acknowledged_refund_policy_version text/)
    expect(migration?.sql).toMatch(/ADD COLUMN terms_acknowledged_at timestamptz/)
    expect(migration?.sql).toMatch(/ADD COLUMN terms_acknowledgement_source text/)
    expect(migration?.sql).toMatch(/community_activity_registrations_active_terms_check/)
    expect(migration?.sql).toMatch(/legacy_combined_ui/)
  })

  it('keeps reservation hold and arrival grace configurable through the strong policy version', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '068')
    expect(migration?.sql).toMatch(/hold_minutes BETWEEN 1 AND 120/)
    expect(migration?.sql).toMatch(/initialize_reservation_runtime_policy_fields/)
    expect(migration?.sql).toMatch(/Reservation policy is not configured/)
    expect(migration?.sql).not.toMatch(/configured_hold integer := 20|configured_grace integer := 10/)
  })

  it('binds experience plans to normalized recommendation options and frozen amounts', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '069')
    expect(migration?.sql).toMatch(/ADD COLUMN recommendation_option_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN selected_amount_minor bigint/)
    expect(migration?.sql).toMatch(/ADD COLUMN selected_currency char\(3\)/)
    expect(migration?.sql).toMatch(/customer_experience_plans_option_selection_fk/)
    expect(migration?.sql).toMatch(/recommendation_options_plan_reference_uq/)
  })

  it('freezes checkout offer amounts and presentation outside the snapshot', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '070')
    expect(migration?.sql).toMatch(/ADD COLUMN source_name_at_offer text/)
    expect(migration?.sql).toMatch(/ADD COLUMN target_name_at_offer text/)
    expect(migration?.sql).toMatch(/ADD COLUMN target_included_items text\[\]/)
    expect(migration?.sql).toMatch(/ADD COLUMN prompt_title_at_offer text/)
    expect(migration?.sql).toMatch(/checkout_upgrade_offers_active_presentation_check/)
  })

  it('binds recommendation payment and refund evidence to the exact financial objects', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '059')
    expect(migration?.sql).toMatch(/ADD COLUMN payment_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN refund_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN order_item_id uuid/)
    expect(migration?.sql).toMatch(/ADD COLUMN attributed_amount_minor bigint/)
    expect(migration?.sql).toMatch(/ADD COLUMN attributed_currency char\(3\)/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_payment_order_fk[\s\S]*REFERENCES mbox\.payments/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_refund_payment_fk[\s\S]*REFERENCES mbox\.refunds/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_item_order_fk[\s\S]*REFERENCES mbox\.order_items/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_refund_item_fk[\s\S]*REFERENCES mbox\.refund_items/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_financial_links_ck/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_ordered_uq/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_paid_uq/)
    expect(migration?.sql).toMatch(/recommendation_behavior_events_refunded_uq/)
    expect(migration?.sql).toMatch(/attributed_amount_minor > 0/)
    expect(migration?.sql).toMatch(/attributed_currency ~ '\^\[A-Z\]\{3\}\$'/)
    expect(migration?.sql).not.toMatch(/provider_snapshot\s*->>?.*(?:payment|refund)/)
  })

  it('protects every access configuration that existed before item-level authority', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '039')
    expect(migration?.sql).toMatch(/authority_source IN \('runtime', 'migration_backfill'\)/)
    expect(migration?.sql).toMatch(/configured_by_employee_id uuid[,\s]/)
    expect(migration?.sql).toMatch(/FROM mbox\.role_permission_assignments/)
    expect(migration?.sql).toMatch(/FROM mbox\.role_data_scopes/)
    expect(migration?.sql).toMatch(/FROM mbox\.role_approval_limits/)
    expect(migration?.sql).toMatch(/FROM mbox\.role_navigation_items/)
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
      'role_access_configuration_authorities', 'staff_access_configuration_definitions',
      'payment_provider_actions', 'wechat_payment_identities',
      'customer_experience_features', 'customer_memberships', 'loyalty_point_ledger',
      'recommendation_sessions', 'customer_experience_plans', 'experience_plan_cues',
      'checkout_upgrade_rules', 'checkout_upgrade_offers', 'community_activities',
      'community_activity_registrations', 'member_content_cards', 'customer_followup_tasks',
      'customer_experience_feedback',
      'table_session_customer_participations', 'recommendation_policy_versions',
      'recommendation_options', 'recommendation_behavior_events', 'observation_inputs',
      'observation_parse_runs', 'observation_match_candidates', 'observation_events',
      'observation_revisions', 'preference_evidence', 'customer_preference_facts',
      'fulfillment_capacity_policy_versions', 'fulfillment_capacity_windows',
      'fulfillment_capacity_reservations', 'benefit_allowed_products',
      'verified_provider_observations',
      'loyalty_tier_benefit_policy_versions', 'loyalty_tier_benefit_rules',
      'membership_tier_benefit_grants', 'membership_tier_benefit_events',
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
    expect(sql).toMatch(/registration_payment_mode[\s\S]*deposit_optional[\s\S]*deposit_required[\s\S]*full_required/)
    expect(sql).toMatch(/fee_basis[\s\S]*per_person[\s\S]*per_registration/)
    expect(sql).toMatch(/payment_status[\s\S]*not_required[\s\S]*pending[\s\S]*paid[\s\S]*expired[\s\S]*refunded/)
    expect(sql).toMatch(/community_activity_registration_contact_versions[\s\S]*contact_hash char\(64\)[\s\S]*encrypted_contact bytea[\s\S]*masked_contact text/)
    expect(sql).toMatch(/notifications_delivery_claim_idx[\s\S]*status IN \('pending', 'failed', 'sending'\)/)
    expect(sql).toMatch(/notifications_attempt_limit_ck/)
    expect(sql).toMatch(/pricing_authorizations_benefit_once_per_table_uq/)
    expect(sql).toMatch(/payments_one_active_intent_per_order_uq[\s\S]*status IN \('created', 'pending'\)/)
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
    expect(sql).toMatch(/checkout_upgrade_rules_active_idx/)
    expect(sql).toMatch(/checkout_upgrade_offers_active_idx/)
    expect(sql).toMatch(/target_amount_minor = source_amount_minor \+ amount_to_add_minor/)
    expect(sql).toMatch(/never refunds a paid drink/)
    expect(sql).toMatch(/loyalty_point_ledger_append_only/)
    expect(sql).toMatch(/customer_experience_feedback_append_only/)
    expect(sql).toMatch(/benefit_redemptions[\s\S]*authorization_source/)
    expect(sql).toMatch(/'order\.create'[\s\S]*'kds\.prepare'[\s\S]*'payment\.initiate\.staff'/)
    expect(sql).not.toMatch(/\b(?:real|double precision)\b/i)
  })

  it('keeps an explicitly released online payment auditable while permitting a staff replacement attempt', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '139')
    expect(migration?.sql).toMatch(/ADD COLUMN retry_released_at timestamptz/)
    expect(migration?.sql).toMatch(/retry_released_by_employee_id uuid/)
    expect(migration?.sql).toMatch(/payments_retry_release_idempotency_uq/)
    expect(migration?.sql).toMatch(/schema_version='139'/)
  })

  it('records customer-left turnover as an append-only exception rather than fabricating payment success', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '140')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.table_customer_left_turnover_events/)
    expect(migration?.sql).toMatch(/customer_left/)
    expect(migration?.sql).toMatch(/close_table_after_customer_left/)
    expect(migration?.sql).toMatch(/table\.turnover_unsettled/)
    expect(migration?.sql).toMatch(/DROP INDEX IF EXISTS mbox\.payments_one_active_intent_per_order_uq/)
    expect(migration?.sql).toMatch(/CREATE UNIQUE INDEX payments_one_active_intent_per_order_uq[\s\S]*retry_released_at IS NULL/)
    expect(migration?.sql).toMatch(/schema_version='140'/)
  })

  it('repairs customer-left hashing without assuming pgcrypto lives in public', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '141')
    expect(migration?.filename).toBe('141_customer_left_turnover_digest_portability.sql')
    expect(migration?.sql).toMatch(/mbox\.customer_left_turnover_digest/)
    expect(migration?.sql).toMatch(/mbox\.personal_contact_sha256/)
    expect(migration?.sql).toMatch(/schema_version='141'/)
    expect(migration?.sql).not.toMatch(/CREATE FUNCTION public\.digest/)
  })

  it('restores the customer-left turnover default grant after older provisioning runs', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '142')
    expect(migration?.filename).toBe('142_customer_left_turnover_default_role_grants.sql')
    expect(migration?.sql).toMatch(/table\.turnover_unsettled/)
    expect(migration?.sql).toMatch(/role_permission_assignments/)
    expect(migration?.sql).toMatch(/schema_version='142'/)
  })

  it('allows physical turnover without rewriting settled customer history', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '143')
    expect(migration?.filename).toBe('143_customer_left_turnover_preserve_settled_history.sql')
    expect(migration?.sql).toMatch(/pg_get_functiondef/)
    expect(migration?.sql).toMatch(/settled order, payment or refund/)
    expect(migration?.sql).toMatch(/schema_version='143'/)
  })

  it('adds a store-configured, two-level customer menu hierarchy without rewriting product categories', async () => {
    const migration = (await loadNormalizedMigrations()).find((entry) => entry.version === '144')
    expect(migration?.filename).toBe('144_menu_category_hierarchy.sql')
    expect(migration?.sql).toMatch(/CREATE TABLE mbox\.menu_categories/)
    expect(migration?.sql).toMatch(/parent_code text/)
    expect(migration?.sql).toMatch(/menu_categories_two_levels/)
    expect(migration?.sql).toMatch(/seed_default_menu_categories_for_store/)
    expect(migration?.sql).toMatch(/stores_seed_default_menu_categories/)
    expect(migration?.sql).toMatch(/'cocktail','鸡尾酒','drinks',10,true/)
    expect(migration?.sql).toMatch(/INSERT INTO mbox\.menu_categories[\s\S]*?FROM mbox\.products AS product/)
    expect(migration?.sql).toMatch(/ALTER TABLE mbox\.menu_categories ENABLE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/ALTER TABLE mbox\.menu_categories FORCE ROW LEVEL SECURITY/)
    expect(migration?.sql).toMatch(/GRANT SELECT,INSERT,UPDATE ON TABLE mbox\.menu_categories TO mbox_runtime/)
    expect(migration?.sql).toMatch(/schema_version='144'/)
    expect(migration?.sql).not.toMatch(/UPDATE mbox\.products\s+SET category_code/)
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
