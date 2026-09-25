import {approvedTableCodeAliases} from '../../src/shared/table-code-alias.js'

// Only constant, reviewed table aliases are embedded here; caller input is bound.
const aliasesJson=JSON.stringify(approvedTableCodeAliases).replaceAll("'","''")

// Resolve a complete code within the authenticated store. An actual code wins
// over a legacy alias, so two distinct tables can never be merged by a rename.
export function historyTableIdSql(value: string, canonical=`COALESCE('${aliasesJson}'::jsonb->>upper(${value}),upper(${value}))`): string {
  return `(SELECT candidate.id FROM mbox.tables candidate
    WHERE candidate.tenant_id=$1::uuid AND candidate.store_id=$2::uuid
      AND ${value}<>'' AND upper(candidate.code) IN (upper(${value}),${canonical})
    ORDER BY (upper(candidate.code)=upper(${value})) DESC,candidate.id LIMIT 1)`
}
