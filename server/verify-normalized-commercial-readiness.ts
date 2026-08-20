import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { Client } from 'pg'

export interface CommercialReadinessSnapshot {
  schemaFlavor: string | null
  schemaVersion: string | null
  storeActive: boolean
  configurationApplications: number
  latestConfigVersion: string | null
  latestConfigSha256: string | null
  latestSourceCommitSha: string | null
  catalogApplications: number
  latestCatalogVersion: string | null
  latestCatalogSha256: string | null
  latestCatalogSourceCommitSha: string | null
  reservationPolicies: number
  activeTables: number
  activeEmployees: number
  activeProducts: number
  guestVisibleProducts: number
  recommendationProducts: number
  productsMissingCurrentPrice: number
  productsMissingCost: number
  bundlesMissingComponents: number
  invalidBundleComponents: number
  financialRolesMissingLimits: string[]
  kdsRolesMissingStationScopes: string[]
  operationalRolesMissingPermissions: string[]
  tablesMissingMinimumSpend: number
  tablesMissingLayout: number
}

export interface CommercialReadinessIssue {
  severity: 'blocker' | 'warning'
  code: string
  message: string
}

export interface CommercialReadinessReport {
  status: 'ready' | 'blocked'
  checkedAt: string
  snapshot: CommercialReadinessSnapshot
  external: {
    miniProgramRelease: MiniProgramReleaseVerification | null
  }
  issues: CommercialReadinessIssue[]
}

export interface MiniProgramReleaseVerification {
  format: 'mbox.wechat-miniprogram-release-verification.v1'
  status: 'ready' | 'blocked'
  stage: 'candidate' | 'upload' | 'release'
  checkedAt: string
  sourceCommitSha: string
  appId: string
  apiBaseUrl: string
  evidenceSha256: string
  evidencePayloadSha256: string
  candidateManifestSha256: string
  evidenceTrust: 'local_integrity_only' | 'trusted_external_attestation'
  attestationKeyId: string
  attestationSha256: string
  attestationPayloadBase64: string
  attestationSignature: string
  failures: string[]
}

export interface MiniProgramReleaseTrust {
  keyId: string
  publicKeyBase64: string
}

export function evaluateCommercialReadiness(
  snapshot: Readonly<CommercialReadinessSnapshot>,
  expectedCommitSha?: string,
  miniProgramRelease: Readonly<MiniProgramReleaseVerification> | null = null,
  miniProgramTrust: Readonly<MiniProgramReleaseTrust> | null = null,
): CommercialReadinessIssue[] {
  const issues: CommercialReadinessIssue[] = []
  const blocker = (code: string, message: string) => issues.push({ severity: 'blocker', code, message })

  if (!validMiniProgramRelease(miniProgramRelease, miniProgramTrust)) {
    blocker('miniprogram.release_evidence_missing', '缺少release阶段、无失败项且经独立签名复核的小程序正式发布证明')
  } else if (expectedCommitSha && miniProgramRelease.sourceCommitSha !== expectedCommitSha.toLowerCase()) {
    blocker('miniprogram.commit_mismatch', '小程序候选证据提交与应用候选提交不一致')
  }

  if (snapshot.schemaFlavor !== 'normalized-core-v1' || Number(snapshot.schemaVersion ?? 0) < 45) {
    blocker('schema.unavailable', '规范化数据库版本必须为046或更高')
  }
  if (!snapshot.storeActive) blocker('store.inactive', '目标门店不存在或未启用')
  if (snapshot.configurationApplications < 1 || !snapshot.latestConfigVersion || !snapshot.latestConfigSha256) {
    blocker('configuration.unversioned', '尚未应用可追溯的版本化门店配置')
  }
  if (expectedCommitSha && snapshot.configurationApplications > 0
    && snapshot.latestSourceCommitSha?.toLowerCase() !== expectedCommitSha.toLowerCase()) {
    blocker('configuration.commit_mismatch', '门店配置来源提交与候选镜像提交不一致')
  }
  if (snapshot.catalogApplications < 1 || !snapshot.latestCatalogVersion || !snapshot.latestCatalogSha256) {
    blocker('catalog.unversioned', '尚未应用可追溯的版本化商品目录')
  }
  if (expectedCommitSha && snapshot.catalogApplications > 0
    && snapshot.latestCatalogSourceCommitSha?.toLowerCase() !== expectedCommitSha.toLowerCase()) {
    blocker('catalog.commit_mismatch', '商品目录来源提交与候选镜像提交不一致')
  }
  if (snapshot.reservationPolicies !== 1) blocker('reservation.policy_missing', '预约策略必须且只能配置一份')
  if (snapshot.activeTables < 1) blocker('tables.empty', '没有可营业桌台')
  if (snapshot.activeEmployees < 1) blocker('employees.empty', '没有可登录员工')
  if (snapshot.activeProducts < 1) blocker('catalog.empty', '商品目录为空')
  if (snapshot.guestVisibleProducts < 1) blocker('catalog.guest_empty', '没有客户可见商品')
  if (snapshot.productsMissingCurrentPrice > 0) {
    blocker('catalog.price_missing', `${snapshot.productsMissingCurrentPrice}个在售商品缺少当前标准价`)
  }
  if (snapshot.productsMissingCost > 0) {
    blocker('catalog.cost_missing', `${snapshot.productsMissingCost}个在售商品缺少有效成本`)
  }
  if (snapshot.bundlesMissingComponents > 0) {
    blocker('catalog.bundle_empty', `${snapshot.bundlesMissingComponents}个在售组合没有结构化组成商品`)
  }
  if (snapshot.invalidBundleComponents > 0) {
    blocker('catalog.bundle_invalid', `${snapshot.invalidBundleComponents}个组合引用了无效或非单品商品`)
  }
  if (snapshot.recommendationProducts < 3) {
    blocker('catalog.recommendations_insufficient', '客户推荐区至少需要3个已配置且可售的推荐商品')
  }
  if (snapshot.financialRolesMissingLimits.length > 0) {
    blocker('access.financial_limit_missing', `以下岗位有财务权限但没有有效额度：${snapshot.financialRolesMissingLimits.join('、')}`)
  }
  if (snapshot.kdsRolesMissingStationScopes.length > 0) {
    blocker('access.kds_scope_missing', `以下制作岗位没有出品站点范围：${snapshot.kdsRolesMissingStationScopes.join('、')}`)
  }
  if (snapshot.operationalRolesMissingPermissions.length > 0) {
    blocker(
      'access.operational_permission_missing',
      `以下经营岗位缺少版本化默认权限：${snapshot.operationalRolesMissingPermissions.join('、')}`,
    )
  }
  if (snapshot.tablesMissingMinimumSpend > 0) {
    blocker('tables.minimum_spend_unconfirmed', `${snapshot.tablesMissingMinimumSpend}张桌台未明确配置最低消费（无低消也必须明确配置为0）`)
  }
  if (snapshot.tablesMissingLayout > 0) {
    blocker('tables.layout_unconfirmed', `${snapshot.tablesMissingLayout}张桌台未配置可视化座位坐标`)
  }
  return issues
}

export async function inspectCommercialReadiness(input: {
  databaseUrl: string
  tenantId: string
  storeId: string
  expectedCommitSha?: string
  miniProgramRelease?: MiniProgramReleaseVerification | null
  miniProgramTrust?: MiniProgramReleaseTrust | null
}): Promise<CommercialReadinessReport> {
  requireUuid(input.tenantId, 'tenantId')
  requireUuid(input.storeId, 'storeId')
  const client = new Client({
    connectionString: input.databaseUrl,
    application_name: 'mbox-normalized-commercial-readiness',
  })
  await client.connect()
  try {
    const result = await client.query<ReadinessRow>(readinessSql(), [input.tenantId, input.storeId])
    const row = result.rows[0]
    if (!row) throw new Error('Unable to inspect normalized commercial readiness')
    const snapshot: CommercialReadinessSnapshot = {
      schemaFlavor: row.schema_flavor,
      schemaVersion: row.schema_version,
      storeActive: row.store_active,
      configurationApplications: number(row.configuration_applications),
      latestConfigVersion: row.latest_config_version,
      latestConfigSha256: row.latest_config_sha256,
      latestSourceCommitSha: row.latest_source_commit_sha,
      catalogApplications: number(row.catalog_applications),
      latestCatalogVersion: row.latest_catalog_version,
      latestCatalogSha256: row.latest_catalog_sha256,
      latestCatalogSourceCommitSha: row.latest_catalog_source_commit_sha,
      reservationPolicies: number(row.reservation_policies),
      activeTables: number(row.active_tables),
      activeEmployees: number(row.active_employees),
      activeProducts: number(row.active_products),
      guestVisibleProducts: number(row.guest_visible_products),
      recommendationProducts: number(row.recommendation_products),
      productsMissingCurrentPrice: number(row.products_missing_current_price),
      productsMissingCost: number(row.products_missing_cost),
      bundlesMissingComponents: number(row.bundles_missing_components),
      invalidBundleComponents: number(row.invalid_bundle_components),
      financialRolesMissingLimits: textArray(row.financial_roles_missing_limits),
      kdsRolesMissingStationScopes: textArray(row.kds_roles_missing_station_scopes),
      operationalRolesMissingPermissions: textArray(row.operational_roles_missing_permissions),
      tablesMissingMinimumSpend: number(row.tables_missing_minimum_spend),
      tablesMissingLayout: number(row.tables_missing_layout),
    }
    const miniProgramRelease = input.miniProgramRelease ?? null
    const issues = evaluateCommercialReadiness(
      snapshot, input.expectedCommitSha, miniProgramRelease, input.miniProgramTrust ?? null,
    )
    return {
      status: issues.some((issue) => issue.severity === 'blocker') ? 'blocked' : 'ready',
      checkedAt: new Date().toISOString(),
      snapshot,
      external: { miniProgramRelease },
      issues,
    }
  } finally {
    await client.end()
  }
}

interface ReadinessRow extends Record<string, unknown> {
  schema_flavor: string | null
  schema_version: string | null
  store_active: boolean
  configuration_applications: string
  latest_config_version: string | null
  latest_config_sha256: string | null
  latest_source_commit_sha: string | null
  catalog_applications: string
  latest_catalog_version: string | null
  latest_catalog_sha256: string | null
  latest_catalog_source_commit_sha: string | null
  reservation_policies: string
  active_tables: string
  active_employees: string
  active_products: string
  guest_visible_products: string
  recommendation_products: string
  products_missing_current_price: string
  products_missing_cost: string
  bundles_missing_components: string
  invalid_bundle_components: string
  financial_roles_missing_limits: unknown
  kds_roles_missing_station_scopes: unknown
  operational_roles_missing_permissions: unknown
  tables_missing_minimum_spend: string
  tables_missing_layout: string
}

function readinessSql(): string {
  return `
    SELECT
      (SELECT schema_flavor FROM mbox.normalized_schema_metadata WHERE singleton=true) AS schema_flavor,
      (SELECT schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true) AS schema_version,
      EXISTS (SELECT 1 FROM mbox.stores WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='active') AS store_active,
      (SELECT count(*)::text FROM mbox.store_configuration_applications WHERE tenant_id=$1::uuid AND store_id=$2::uuid) AS configuration_applications,
      latest.config_version AS latest_config_version,
      latest.config_sha256 AS latest_config_sha256,
      latest.source_commit_sha AS latest_source_commit_sha,
      (SELECT count(*)::text FROM mbox.product_catalog_applications WHERE tenant_id=$1::uuid AND store_id=$2::uuid) AS catalog_applications,
      latest_catalog.catalog_version AS latest_catalog_version,
      latest_catalog.catalog_sha256 AS latest_catalog_sha256,
      latest_catalog.source_commit_sha AS latest_catalog_source_commit_sha,
      (SELECT count(*)::text FROM mbox.public_reservation_policies WHERE tenant_id=$1::uuid AND store_id=$2::uuid) AS reservation_policies,
      (SELECT count(*)::text FROM mbox.tables WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='available') AS active_tables,
      (SELECT count(*)::text FROM mbox.employees WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active') AS active_employees,
      (SELECT count(*)::text FROM mbox.products WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active') AS active_products,
      (SELECT count(*)::text FROM mbox.products WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
        AND guest_visible) AS guest_visible_products,
      (SELECT count(*)::text FROM mbox.products WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
        AND guest_visible AND recommendation_enabled) AS recommendation_products,
      (SELECT count(*)::text FROM mbox.products product WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
        AND product.status='active' AND NOT EXISTS (
          SELECT 1 FROM mbox.product_prices price WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
            AND price.product_id=product.id AND price.price_type='standard' AND price.valid_from <= clock_timestamp()
            AND (price.valid_until IS NULL OR price.valid_until > clock_timestamp()))) AS products_missing_current_price,
      (SELECT count(*)::text FROM mbox.products product WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
        AND product.status='active' AND product.cost_amount_minor IS NULL) AS products_missing_cost,
      (SELECT count(*)::text FROM mbox.products product WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
        AND product.status='active' AND product.product_kind='bundle' AND NOT EXISTS (
          SELECT 1 FROM mbox.product_bundle_components component WHERE component.tenant_id=product.tenant_id
            AND component.store_id=product.store_id AND component.bundle_product_id=product.id)) AS bundles_missing_components,
      (SELECT count(*)::text FROM mbox.product_bundle_components component
        JOIN mbox.products bundle ON bundle.tenant_id=component.tenant_id AND bundle.store_id=component.store_id
          AND bundle.id=component.bundle_product_id
        JOIN mbox.products item ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
          AND item.id=component.component_product_id
        WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid AND bundle.status='active'
          AND (bundle.product_kind<>'bundle' OR item.product_kind<>'single' OR item.status<>'active')) AS invalid_bundle_components,
      COALESCE((SELECT jsonb_agg(missing.role_code || ':' || missing.permission_code ORDER BY missing.role_code, missing.permission_code)
        FROM (SELECT role.code AS role_code, permission.code AS permission_code
          FROM mbox.roles role
          JOIN mbox.role_permission_assignments assignment ON assignment.tenant_id=role.tenant_id
            AND assignment.store_id=role.store_id AND assignment.role_id=role.id
          JOIN mbox.staff_permission_definitions permission ON permission.tenant_id=assignment.tenant_id
            AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id AND permission.status='active'
          WHERE role.tenant_id=$1::uuid AND role.store_id=$2::uuid AND role.status='active'
            AND permission.code IN ('order.gift','order.discount','refund.request','refund.approve','benefit.issue')
            AND NOT EXISTS (SELECT 1 FROM mbox.role_approval_limits approval WHERE approval.tenant_id=role.tenant_id
              AND approval.store_id=role.store_id AND approval.role_id=role.id AND approval.approval_code=permission.code
              AND approval.enabled=true AND approval.currency='CNY' AND approval.amount_minor IS NOT NULL)
        ) missing), '[]'::jsonb) AS financial_roles_missing_limits,
      COALESCE((SELECT jsonb_agg(role.code ORDER BY role.code) FROM mbox.roles role
        WHERE role.tenant_id=$1::uuid AND role.store_id=$2::uuid AND role.status='active'
          AND EXISTS (SELECT 1 FROM mbox.role_permission_assignments assignment
            JOIN mbox.staff_permission_definitions permission ON permission.tenant_id=assignment.tenant_id
              AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id
            WHERE assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id
              AND assignment.role_id=role.id AND permission.code='kds.prepare' AND permission.status='active')
          AND NOT EXISTS (SELECT 1 FROM mbox.role_data_scopes scope WHERE scope.tenant_id=role.tenant_id
            AND scope.store_id=role.store_id AND scope.role_id=role.id AND scope.scope_key='kds.station_codes'
            AND scope.effect='include' AND scope.enabled=true
            AND scope.value_kind='text_set' AND cardinality(scope.text_values)>0)), '[]'::jsonb) AS kds_roles_missing_station_scopes,
      COALESCE((SELECT jsonb_agg(missing.role_code || ':' || missing.permission_code
          ORDER BY missing.role_code,missing.permission_code)
        FROM (
          SELECT expected.role_code,expected.permission_code
          FROM (VALUES
            ('OWNER','checkout.upgrade.rule.view'),('OWNER','checkout.upgrade.rule.publish'),
            ('OWNER','fulfillment.capacity.view'),('OWNER','fulfillment.capacity.publish'),
            ('OWNER','performance.schedule.revise'),
            ('OWNER','loyalty.promotion.view'),('OWNER','loyalty.promotion.publish'),
            ('OWNER','membership.terms.view'),('OWNER','membership.terms.publish'),
            ('OWNER','loyalty.operations.view'),('OWNER','loyalty.operations.control'),
            ('OPS_LEAD','checkout.upgrade.rule.view'),('OPS_LEAD','checkout.upgrade.rule.approve'),
            ('OPS_LEAD','fulfillment.capacity.view'),('OPS_LEAD','fulfillment.capacity.approve'),
            ('OPS_LEAD','performance.schedule.revise'),
            ('OPS_LEAD','loyalty.promotion.view'),('OPS_LEAD','loyalty.promotion.approve'),
            ('OPS_LEAD','membership.terms.view'),('OPS_LEAD','membership.terms.approve'),
            ('MANAGER','checkout.upgrade.rule.view'),('MANAGER','checkout.upgrade.rule.draft'),
            ('MANAGER','fulfillment.capacity.view'),('MANAGER','fulfillment.capacity.draft'),
            ('MANAGER','performance.schedule.revise'),
            ('MANAGER','loyalty.promotion.view'),('MANAGER','loyalty.promotion.manage'),
            ('MANAGER','membership.terms.view'),('MANAGER','membership.terms.manage'),
            ('DEPUT_MANAGER','membership.terms.view')
          ) expected(role_code,permission_code)
          LEFT JOIN mbox.roles role ON role.tenant_id=$1::uuid AND role.store_id=$2::uuid
            AND role.code=expected.role_code AND role.status='active'
          LEFT JOIN mbox.staff_permission_definitions permission
            ON permission.tenant_id=$1::uuid AND permission.store_id=$2::uuid
           AND permission.code=expected.permission_code AND permission.status='active'
          LEFT JOIN mbox.role_permission_assignments assignment
            ON assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid
           AND assignment.role_id=role.id AND assignment.permission_id=permission.id
          WHERE assignment.role_id IS NULL
        ) missing), '[]'::jsonb) AS operational_roles_missing_permissions,
      (SELECT count(*)::text FROM mbox.tables WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND status='available' AND minimum_spend_minor IS NULL) AS tables_missing_minimum_spend,
      (SELECT count(*)::text FROM mbox.tables WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND status='available' AND layout_snapshot='{}'::jsonb) AS tables_missing_layout
    FROM (SELECT config_version, config_sha256, source_commit_sha FROM mbox.store_configuration_applications
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid ORDER BY applied_at DESC, id DESC LIMIT 1) latest
    RIGHT JOIN (SELECT 1) singleton ON true
    LEFT JOIN LATERAL (SELECT catalog_version, catalog_sha256, source_commit_sha
      FROM mbox.product_catalog_applications WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY applied_at DESC, id DESC LIMIT 1) latest_catalog ON true
  `
}

function number(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid readiness counter')
  return result
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error('Invalid readiness issue list')
  }
  return value
}

function requireUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${field} must be a UUID`)
  }
}

function validMiniProgramRelease(
  value: Readonly<MiniProgramReleaseVerification> | null,
  trust: Readonly<MiniProgramReleaseTrust> | null,
): value is Readonly<MiniProgramReleaseVerification> {
  if (value === null || trust === null
    || value.format !== 'mbox.wechat-miniprogram-release-verification.v1'
    || value.status !== 'ready' || value.stage !== 'release'
    || value.evidenceTrust !== 'trusted_external_attestation'
    || value.failures.length !== 0 || !/^[0-9a-f]{40}$/.test(value.sourceCommitSha)
    || !/^wx[0-9a-f]{16}$/.test(value.appId)
    || !validHttpsDomainOrigin(value.apiBaseUrl)
    || !/^[0-9a-f]{64}$/.test(value.evidenceSha256)
    || !/^[0-9a-f]{64}$/.test(value.evidencePayloadSha256)
    || !/^[0-9a-f]{64}$/.test(value.candidateManifestSha256)
    || !/^[0-9a-f]{64}$/.test(value.attestationSha256)
    || value.attestationKeyId.length < 3 || value.attestationKeyId !== trust.keyId) return false
  const checkedAt = Date.parse(value.checkedAt)
  if (!Number.isFinite(checkedAt) || checkedAt > Date.now() + 300_000) return false
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.attestationPayloadBase64)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.attestationSignature)) return false
    const payload = Buffer.from(value.attestationPayloadBase64, 'base64')
    const signature = Buffer.from(value.attestationSignature, 'base64')
    if (signature.length !== 64 || createHash('sha256').update(payload).digest('hex') !== value.attestationSha256) return false
    const attestation = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    if (attestation.format !== 'mbox.wechat-miniprogram-platform-attestation.v1'
      || attestation.stage !== 'release' || attestation.keyId !== trust.keyId
      || attestation.evidencePayloadSha256 !== value.evidencePayloadSha256
      || attestation.candidateManifestSha256 !== value.candidateManifestSha256
      || attestation.sourceCommitSha !== value.sourceCommitSha
      || attestation.appId !== value.appId || attestation.apiBaseUrl !== value.apiBaseUrl) return false
    const issuedAt = Date.parse(typeof attestation.issuedAt === 'string' ? attestation.issuedAt : '')
    const expiresAt = Date.parse(typeof attestation.expiresAt === 'string' ? attestation.expiresAt : '')
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() + 300_000
      || expiresAt <= Date.now() || expiresAt <= issuedAt || expiresAt - issuedAt > 72 * 60 * 60 * 1000) return false
    const pem = Buffer.from(trust.publicKeyBase64, 'base64').toString('utf8')
    const publicKey = createPublicKey(pem)
    return publicKey.asymmetricKeyType === 'ed25519' && verifySignature(null, payload, publicKey, signature)
  } catch {
    return false
  }
}

function validHttpsDomainOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash
      && isIP(url.hostname) === 0 && url.hostname.includes('.')
  } catch {
    return false
  }
}

async function readMiniProgramReleaseVerification(path: string | undefined): Promise<MiniProgramReleaseVerification | null> {
  const normalized = path?.trim()
  if (!normalized) return null
  const value = JSON.parse(await readFile(resolve(normalized), 'utf8')) as MiniProgramReleaseVerification
  return value
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  const tenantId = process.env.MBOX_TENANT_ID?.trim()
  const storeId = process.env.MBOX_STORE_ID?.trim()
  if (!databaseUrl || !tenantId || !storeId) {
    throw new Error('DATABASE_URL, MBOX_TENANT_ID and MBOX_STORE_ID are required')
  }
  const expectedCommitSha = process.env.APP_COMMIT_SHA?.trim()
  const miniProgramRelease = await readMiniProgramReleaseVerification(
    process.env.MBOX_MINIPROGRAM_RELEASE_REPORT,
  )
  const miniProgramTrust = process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_KEY_ID?.trim()
    && process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_PUBLIC_KEY_BASE64?.trim()
    ? {
        keyId: process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_KEY_ID.trim(),
        publicKeyBase64: process.env.MBOX_MINIPROGRAM_RELEASE_TRUSTED_PUBLIC_KEY_BASE64.trim(),
      }
    : null
  const report = await inspectCommercialReadiness({
    databaseUrl, tenantId, storeId, expectedCommitSha, miniProgramRelease, miniProgramTrust,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'ready') process.exitCode = 1
}
