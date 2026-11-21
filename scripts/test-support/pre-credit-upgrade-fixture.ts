import {orderHasPendingTableCreditSql} from '../../server/normalized/verified-capture-sql.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction,StoreScope,TransactionOptions} from '../../server/normalized/transaction-runner.js'

/** Only for seeding a schema-263 upgrade fixture with today's command classes.
 * That historical schema has neither table prepayments nor their order links.
 * Project the absent feature as false until migration; keep every historical
 * payment/permission/financial SQL statement and database guard in force.
 * Never install this adapter in application code or after the upgrade. */
export async function installPreCreditFixtureProjection(runner:ScopedPostgresTransactionRunner,scope:StoreScope){
 const absent=await runner.run(scope,tx=>tx.query<{version:string;links:string|null}>("SELECT (SELECT max(version) FROM mbox.normalized_schema_migrations) AS version,to_regclass('mbox.table_credit_order_links')::text AS links"))
 if(absent.rows[0]?.version!=='263'||absent.rows[0]?.links!==null)throw new Error('Legacy projection requires the unmodified schema-263 fixture')
 const original=runner.run.bind(runner)
 const predicate=`${orderHasPendingTableCreditSql} AS pending_table_credit`
 let projected=0
 runner.run=<Result>(scope:Readonly<StoreScope>,operation:(tx:ScopedTransaction)=>Promise<Result>,options:Readonly<TransactionOptions>={})=>original(scope,tx=>operation({scope:tx.scope,query:(text,values)=>{
  if(text.includes(predicate)){projected++;text=text.replace(predicate,'false AS pending_table_credit')}
  return tx.query(text,values)
 }}),options)
 return()=>{runner.run=original;if(!projected)throw new Error('Legacy fixture did not exercise its payment projection')}
}
