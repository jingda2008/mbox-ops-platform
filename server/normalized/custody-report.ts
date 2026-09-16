import {z} from 'zod'
import type {ScopedTransaction} from './transaction-runner.js'
export const custodyReportFilters=z.object({scope:z.enum(['custody','sales','all']).default('custody'),memberNo:z.string().trim().max(64).optional(),category:z.string().trim().max(64).optional(),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict()
export type CustodyReportFilter=z.infer<typeof custodyReportFilters>
export interface CustodyReportRow extends Record<string,unknown>{id:string;type:string;public_id:string;member_no:string|null;category:string;item_name:string;occurred_at:string;status:string;amount_minor:string|null;amount_basis:string;currency:string}
export async function custodyReport(tx:ScopedTransaction,filter:CustodyReportFilter,limit=100){
 const values=[tx.scope.tenantId,tx.scope.storeId,filter.scope,filter.memberNo||null,filter.category||null,filter.from??null,filter.to??null]
 const query=`WITH report AS (
  SELECT o.id,'custody'::text AS type,o.public_id,o.member_no,c.name AS category,o.item_name,o.stored_at AS occurred_at,o.status,o.declared_value_minor AS amount_minor,'存酒登记价值（非收入）'::text AS amount_basis,'CNY'::text AS currency
  FROM mbox.bottle_custody_orders o JOIN mbox.bottle_custody_categories c ON c.tenant_id=o.tenant_id AND c.store_id=o.store_id AND c.id=o.category_id
  WHERE o.tenant_id=$1 AND o.store_id=$2 AND $3 IN('custody','all') AND ($4::text IS NULL OR o.member_no=$4) AND ($5::text IS NULL OR c.name=$5 OR c.code=$5)
  UNION ALL
  SELECT o.id,'sales',o.public_id,m.member_no,'消费订单','消费订单',COALESCE(o.submitted_at,o.created_at),o.payment_status,o.total_amount_minor,'消费订单应付金额（非实收）',o.currency
  FROM mbox.orders o LEFT JOIN LATERAL(SELECT member_no FROM mbox.customer_memberships WHERE tenant_id=o.tenant_id AND store_id=o.store_id AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=mbox.canonical_customer_id(o.tenant_id,o.store_id,o.created_by_customer_id) ORDER BY joined_at,id LIMIT 1) m ON true
  WHERE o.tenant_id=$1 AND o.store_id=$2 AND $3 IN('sales','all') AND ($4::text IS NULL OR m.member_no=$4)
   AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM mbox.order_items i JOIN mbox.products p ON p.tenant_id=i.tenant_id AND p.store_id=i.store_id AND p.id=i.product_id WHERE i.tenant_id=o.tenant_id AND i.store_id=o.store_id AND i.order_id=o.id AND i.parent_order_item_id IS NULL AND COALESCE(i.product_snapshot->>'categoryCode',p.category_code)=$5))
 ), filtered AS (SELECT * FROM report WHERE ($6::timestamptz IS NULL OR occurred_at>=$6) AND ($7::timestamptz IS NULL OR occurred_at<$7)) `
 const items=(await tx.query<CustodyReportRow>(query+'SELECT *,occurred_at::text FROM filtered ORDER BY filtered.occurred_at DESC,type,id LIMIT $8 OFFSET $9',[...values,limit+1,filter.offset])).rows
 const summary=(await tx.query<{type:string;currency:string;count:string;amount_minor:string;unknown_amount_count:string}>(query+'SELECT type,currency,count(*)::text AS count,COALESCE(sum(amount_minor),0)::text AS amount_minor,count(*) FILTER(WHERE amount_minor IS NULL)::text AS unknown_amount_count FROM filtered GROUP BY type,currency ORDER BY type,currency',values)).rows
 return{items:items.slice(0,limit),nextOffset:items.length>limit?filter.offset+limit:null,summary}
}
