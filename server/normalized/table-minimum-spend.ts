import type { ScopedTransaction } from './transaction-runner.js'

export interface TableMinimumSpend {
  minimumMinor: number
  consumedMinor: number
  cartMinor: number
  shortfallMinor: number
  message: string
}
export function minimumSpendSummary(minimumMinor:number, consumedMinor:number, cartMinor:number):TableMinimumSpend {
  for (const value of [minimumMinor,consumedMinor,cartMinor]) {
    if (!Number.isSafeInteger(value)||value<0) throw new TypeError('最低消费金额无效')
  }
  const shortfallMinor=Math.max(0,minimumMinor-consumedMinor-cartMinor)
  const money=(value:number)=>(value/100).toFixed(2)
  return {minimumMinor,consumedMinor,cartMinor,shortfallMinor,message:minimumMinor===0?'':shortfallMinor>0
    ? `本桌最低消费 ¥${money(minimumMinor)}，还差 ¥${money(shortfallMinor)}。再选几款喜欢的商品即可提交。`
    : `本桌最低消费 ¥${money(minimumMinor)}，已达标，可以提交订单。`}
}
export class TableMinimumSpendNotMetError extends Error {
  constructor(readonly details:TableMinimumSpend){super(details.message);this.name='TableMinimumSpendNotMetError'}
}
export async function readTableMinimumSpend(tx:ScopedTransaction,sessionId:string,cartMinor:number,knownMinimum?:number):Promise<TableMinimumSpend> {
  const minimum=knownMinimum??Number((await tx.query<{minimum_spend_minor:string}>(`
    SELECT (minimum_spend_minor-minimum_spend_waiver_minor)::text AS minimum_spend_minor FROM mbox.table_sessions
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[tx.scope.tenantId,tx.scope.storeId,sessionId])).rows[0]?.minimum_spend_minor??0)
  if(minimum===0)return minimumSpendSummary(0,0,cartMinor)
  // Both modes share the database authority, including approved bundle returns.
  const result=await tx.query<{consumed_minor:string}>(
    'SELECT mbox.table_qualifying_goods($1,$2,$3)::text consumed_minor',
    [tx.scope.tenantId,tx.scope.storeId,sessionId])
  return minimumSpendSummary(minimum,Number(result.rows[0]?.consumed_minor??0),cartMinor)
}
