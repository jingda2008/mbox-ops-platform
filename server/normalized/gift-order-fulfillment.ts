import { createHash } from 'node:crypto'
import type { CommerceCommandService } from './commerce-command-service.js'
import type { GiftOrderPort } from './benefit-repository.js'
import { loadGiftBenefitProducts } from './gift-benefit-products.js'
import { PaymentFulfillmentRepository } from './payment-fulfillment-repository.js'
import { appendAuditEvent, appendOutboxMessage } from './command-executor.js'

/** The existing counted gift reservation creates the same zero-value order and inventory flow. */
export function createGiftOrderPort(commerce: CommerceCommandService): GiftOrderPort {
  return {
      createGiftOrder: async (transaction, input) => {
        if (input.redeemedByEmployeeId === null || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
          throw new Error('Gift benefit fulfillment requires an authenticated employee and business date')
        }
        const products = await loadGiftBenefitProducts(transaction,input.benefitId)
        const selected = input.selectedProductId === null
          ? (products.rows.length === 1 ? products.rows[0] : undefined)
          : products.rows.find((row) => row.product_id === input.selectedProductId)
        if (!selected) {
          throw new Error(products.rows.length > 1
            ? 'Gift benefit fulfillment requires an explicit allowed product selection'
            : 'Gift benefit fulfillment has no authoritative allowed product')
        }
        const substituted = selected.original_product_id !== null && selected.product_id !== selected.original_product_id
        const substitutionReason = input.substitutionReason?.trim() || selected.configured_reason
        if (substituted && (!substitutionReason || substitutionReason.length < 2)) {
          throw new Error('Gift benefit substitute selection requires a reason')
        }
        // A daily-snack claim already owns a short recipe hold. Release that
        // hold inside this same transaction immediately before the zero-value
        // order reserves the identical recipe, so no competing request can
        // take the inventory between the two authoritative states.
        await transaction.query(
          'SELECT mbox.convert_annual_daily_snack_inventory_hold($1::uuid)',
          [input.benefitId],
        )
        const publicId = `benefit-gift-${createHash('sha256')
          .update(`${input.benefitId}:${input.benefitReservationId}`).digest('hex').slice(0, 40)}`
        const orderOutcome = await commerce.submitOrderInTransaction(transaction, {
          scope: transaction.scope,
          actor: { type: 'employee', employeeId: input.redeemedByEmployeeId },
          businessDate: input.businessDate,
          idempotencyKey: `benefit-gift-order:${input.benefitReservationId}`,
          tableSessionId: input.tableSessionId,
          publicId,
          channel: 'cashier',
          settlementMode: 'immediate_payment',
          lines: [{ productId: selected.product_id, quantity: input.quantity, bundleSelections: input.bundleSelections }],
          note: substituted
            ? `会员权益核销：${input.benefitId}；替代商品：${selected.original_product_id} → ${selected.product_id}；原因：${substitutionReason}`
            : `会员权益核销：${input.benefitId}`,
          createdByEmployeeId: input.redeemedByEmployeeId,
          pricingAuthorization: { sourceType: 'benefit', sourceId: input.benefitId },
          benefitFulfillmentReservationId: input.benefitReservationId,
        })
        await new PaymentFulfillmentRepository(transaction)
          .activateComplimentaryBenefitOrder(orderOutcome.result.order.id,input.benefitId)
        for (const audit of orderOutcome.auditEvents) await appendAuditEvent(transaction, audit)
        for (const outbox of orderOutcome.outboxMessages) await appendOutboxMessage(transaction, outbox)
        await appendAuditEvent(transaction, {
          actor:{ type:'employee',employeeId:input.redeemedByEmployeeId },
          action:substituted ? 'benefit.gift_substitute_selected' : 'benefit.gift_product_selected',
          objectType:'order',objectId:orderOutcome.result.order.id,businessDate:input.businessDate,
          afterData:{ benefitId:input.benefitId,originalProductId:selected.original_product_id,
            selectedProductId:selected.product_id,substituted,substitutionReason:substitutionReason ?? null,
            inventoryState:'reserved_until_production_start' },
          reason:substitutionReason ?? undefined,
        })
        await appendOutboxMessage(transaction, {
          businessEventKey:`benefit-gift-fulfillment-requested:${orderOutcome.result.order.id}`,
          aggregateType:'order',aggregateId:orderOutcome.result.order.id,aggregateVersion:1,
          eventType:'benefit.gift.fulfillment-requested.v1',
          payload:{ orderId:orderOutcome.result.order.id,benefitId:input.benefitId,
            status:'pending',source:'benefit_gift' },
        })
        return { reference: orderOutcome.result.order.publicId }
      },
  }
}
