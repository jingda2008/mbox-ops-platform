import type {ScopedTransaction} from './transaction-runner.js'

/** Same scoped key-share lock as fulfillment, without granting map UPDATE. */
export async function loadGiftBenefitProducts(transaction:ScopedTransaction,benefitId:string) {
  return transaction.query<{
          product_id: string; original_product_id: string | null; configured_reason: string | null
        }>(`
          SELECT allowed.product_id,definition.product_id AS original_product_id,
            substitute.reason AS configured_reason
          FROM mbox.lock_benefit_allowed_products($3::uuid) allowed
          LEFT JOIN mbox.membership_annual_benefit_grants grant_row
            ON grant_row.tenant_id=allowed.tenant_id AND grant_row.store_id=allowed.store_id
           AND grant_row.benefit_id=allowed.benefit_id
          LEFT JOIN mbox.loyalty_annual_benefit_rules rule
            ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id AND rule.id=grant_row.rule_id
          LEFT JOIN mbox.loyalty_benefit_definitions definition
            ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
           AND definition.id=rule.benefit_definition_id
          LEFT JOIN mbox.loyalty_annual_benefit_rule_substitutes substitute
            ON substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
           AND substitute.rule_id=rule.id AND substitute.product_id=allowed.product_id
          WHERE allowed.tenant_id=$1::uuid AND allowed.store_id=$2::uuid AND allowed.benefit_id=$3::uuid
          ORDER BY (allowed.product_id=definition.product_id) DESC,substitute.priority,allowed.product_id
        `, [transaction.scope.tenantId, transaction.scope.storeId, benefitId])
}
