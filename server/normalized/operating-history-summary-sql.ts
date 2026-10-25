import { orderCollectionBalancesCtesSql } from './order-collection-balances-sql.js'
import { currentRefundAttemptSql } from './refund-attempt-sql.js'

/**
 * Same daily contract as mbox.operating_day_summary; aggregate the range once.
 * Refunds count once per business day, including a batch spanning several days.
 * Keep empty days and the caller's single-day versus combined-summary shape.
 * Parameters: tenant, store, start date, end date.
 */
export const operatingHistorySummariesSql = `
  WITH ${orderCollectionBalancesCtesSql}, daily_amounts AS (
    SELECT business_date,count(*) order_count,sum(original_minor) original_minor,
      sum(original_minor-effective_minor) stopped_minor,sum(effective_minor) effective_minor,
      count(*) FILTER(WHERE amount>0) unsettled_count,sum(amount) outstanding
    FROM collection_balances
    WHERE status NOT IN('draft','cancelled') AND business_date BETWEEN $3::date AND $4::date
    GROUP BY business_date
  ), pending_refund_days AS (
    SELECT DISTINCT refund.id,ordering.business_date
    FROM mbox.refunds refund
    JOIN mbox.order_payment_facts payment ON (payment.tenant_id,payment.store_id,payment.id)=(refund.tenant_id,refund.store_id,refund.payment_id)
      AND (refund.order_id IS NULL OR refund.order_id=payment.order_id)
    JOIN mbox.orders ordering ON (ordering.tenant_id,ordering.store_id,ordering.id)=(payment.tenant_id,payment.store_id,payment.order_id)
    WHERE refund.tenant_id=$1 AND refund.store_id=$2 AND refund.status IN('requested','approved','processing','failed')
      AND ${currentRefundAttemptSql('refund')} AND ordering.business_date BETWEEN $3::date AND $4::date
  ), daily_refunds AS (
    SELECT business_date,count(*) pending FROM pending_refund_days GROUP BY business_date
  )
  SELECT jsonb_build_object(
    'orderCount',COALESCE(amounts.order_count,0),
    'originalOrderAmountMinor',COALESCE(amounts.original_minor,0)::text,
    'stoppedAmountMinor',COALESCE(amounts.stopped_minor,0)::text,
    'orderAmountMinor',COALESCE(amounts.effective_minor,0)::text,
    'unsettledCount',COALESCE(amounts.unsettled_count,0),
    'outstandingMinor',COALESCE(amounts.outstanding,0)::text,
    'pendingPaymentCount',0,'pendingRefundCount',COALESCE(refunds.pending,0)) AS summary
  FROM generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') day
  LEFT JOIN daily_amounts amounts ON amounts.business_date=day::date
  LEFT JOIN daily_refunds refunds ON refunds.business_date=day::date
  ORDER BY day`
