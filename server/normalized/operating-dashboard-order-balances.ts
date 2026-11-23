import {orderCollectionBalancesCtesSql} from './order-collection-balances-sql.js'

// Include earlier outstanding orders in the same currency as the report.
export const operatingDashboardOrderBalancesSql = `
  WITH ${orderCollectionBalancesCtesSql}
  SELECT public_id,'order' source_type,business_date::text,COALESCE(submitted_at,created_at)::text occurred_at,
    amount::text,payment_status IN('paid','partially_refunded','refunded') paid
  FROM collection_balances WHERE currency=$5 AND (status<>'cancelled' OR amount>0)
    AND (business_date BETWEEN $3::date AND $4::date OR amount>0)
`
