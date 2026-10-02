import {createHash} from 'node:crypto'
import {IdempotencyConflictError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {NormalizedOperationsRequestContext} from './normalized-operations-api.js'
import {StaffAccessRepository} from './staff-access-repository.js'

type Context=NormalizedOperationsRequestContext
interface Ledger {net:number;count:number}
interface Count {countedMinor:number;expectedMinor:number;differenceMinor:number;ledgerNet:number;ledgerCount:number;employeeId:string;reason:string;denominations:Record<string,number>;submittedAt:string}
interface Row extends Record<string,unknown> {id:string;business_date:string;opened_by:string;opened_at:string;opening_minor:string;opening_ledger_net:string;opening_ledger_count:string;opening_difference_minor:string|null;opening_reason:string;movement_minor:string;status:string;revision:number;count_snapshot:Count|null;closed_by:string|null;closed_at:string|null}
export interface CashHandoverCommand {action:'open'|'movement'|'count'|'withdraw'|'approve';id?:string;expectedRevision?:number;amountMinor?:number;direction?:'in'|'out';reason:string;reference?:string;denominations?:Record<string,number>;reviewCountedMinor?:number}
export class CashHandoverError extends Error {notCommitted=false;constructor(message:string){super(message)}}
export const cashDenominations=[10000,5000,2000,1000,500,100,50,10,5,2,1] as const
export function countCash(values:Record<string,number>):number {let total=0;for(const [key,quantity]of Object.entries(values)){const value=Number(key);if(!cashDenominations.includes(value as never)||!Number.isInteger(quantity)||quantity<0||quantity>99999)throw new CashHandoverError('面额或张数无效');total+=value*quantity}if(!Number.isSafeInteger(total)||total>10000000000)throw new CashHandoverError('盘点金额超限');return total}
export class CashHandoverService {
 constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>,private readonly commands:Pick<NormalizedCommandExecutor,'execute'>){}
 async view(c:Context){return this.transactions.run(c.scope,async tx=>{
  const access=await new StaffAccessRepository(tx).resolve(c.employeeId)
  if(!access.permissions.includes('reconciliation.view'))throw new CashHandoverError('没有现金账本查询权限')
  const ledger=await this.ledger(tx)
  const rows=(await tx.query<Row>(`SELECT *,business_date::text,opened_at::text,closed_at::text FROM mbox.cash_handovers h WHERE tenant_id=$1 AND store_id=$2 ORDER BY h.opened_at DESC,id DESC LIMIT 30`,[c.scope.tenantId,c.scope.storeId])).rows
  const active=rows.find(r=>r.status!=='closed')
  const events=active?(await tx.query(`SELECT id,employee_id AS "employeeId",action,evidence,occurred_at::text AS "occurredAt" FROM mbox.cash_handover_events WHERE tenant_id=$1 AND store_id=$2 AND handover_id=$3 ORDER BY occurred_at,id`,[c.scope.tenantId,c.scope.storeId,active.id])).rows:[]
  return {businessDate:c.businessDate,ledger,handovers:rows.map(r=>this.dto(r,ledger)),events,
   canCount:access.permissions.includes('payment.manual.cash.record')||access.permissions.includes('reconciliation.manage'),canManage:access.permissions.includes('reconciliation.manage')}
 },{readOnly:true,isolation:'repeatable-read'})}
 async execute(c:Context,key:string,input:CashHandoverCommand){
  const reason=input.reason.trim()
  if(reason.length<4||reason.length>500)throw new CashHandoverError('请填写4—500字实际原因或交接说明')
  await this.transactions.run(c.scope,async tx=>{
    const access=await new StaffAccessRepository(tx).resolve(c.employeeId)
    if(!access.permissions.includes('reconciliation.view')||!(access.permissions.includes('payment.manual.cash.record')||access.permissions.includes('reconciliation.manage'))||['movement','approve'].includes(input.action)&&!access.permissions.includes('reconciliation.manage'))throw new CashHandoverError('现金交接权限已撤销')
  },{readOnly:true})
  const fingerprint=createHash('sha256').update(JSON.stringify({employeeId:c.employeeId,input:{...input,reason}})).digest('hex')
  return this.commands.execute({scope:c.scope,operationScope:'cash.handover.'+input.action,idempotencyKey:key,requestFingerprint:fingerprint,resultCodec:{encode:(v:JsonObject)=>v,decode:(v)=>v as JsonObject}},async tx=>{
   try {
   const access=await new StaffAccessRepository(tx).resolve(c.employeeId)
   if(!access.permissions.includes('reconciliation.view')||!(access.permissions.includes('payment.manual.cash.record')||access.permissions.includes('reconciliation.manage')))throw new CashHandoverError('现金盘点权限已撤销')
   if(['movement','approve'].includes(input.action)&&!access.permissions.includes('reconciliation.manage'))throw new CashHandoverError('需要财务管理权限')
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${c.scope.tenantId}:${c.scope.storeId}:cash-handover`])
   const original=(await tx.query<{evidence:JsonObject}>(`SELECT evidence FROM mbox.cash_handover_events WHERE tenant_id=$1 AND store_id=$2 AND evidence->>'key'=$3 ORDER BY occurred_at,id LIMIT 1`,[c.scope.tenantId,c.scope.storeId,key])).rows[0]
   if(original){if(original.evidence.fingerprint!==fingerprint)throw new IdempotencyConflictError('cash.handover.'+input.action,key);return {result:original.evidence.result as JsonObject,auditEvents:[],outboxMessages:[]}}
   const ledger=await this.ledger(tx);let row:Row
   if(input.action==='open'){
    const existing=(await tx.query<Row>(`SELECT *,business_date::text,opened_at::text,closed_at::text FROM mbox.cash_handovers h WHERE tenant_id=$1 AND store_id=$2 ORDER BY h.opened_at DESC,id DESC LIMIT 1 FOR UPDATE`,[c.scope.tenantId,c.scope.storeId])).rows[0]
    if(existing&&existing.status!=='closed')throw new CashHandoverError('门店已有进行中的现金交接，请处理原记录')
    const opening=minor(input.amountMinor)
    const difference=existing?.count_snapshot?opening-(existing.count_snapshot.countedMinor+ledger.net-existing.count_snapshot.ledgerNet):null
    row=(await tx.query<Row>(`INSERT INTO mbox.cash_handovers(tenant_id,store_id,business_date,opened_by,opening_minor,opening_ledger_net,opening_ledger_count,opening_difference_minor,opening_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,business_date::text,opened_at::text,closed_at::text`,[c.scope.tenantId,c.scope.storeId,c.businessDate,c.employeeId,opening,ledger.net,ledger.count,difference,reason])).rows[0]!
   }else{
    row=(await tx.query<Row>(`SELECT *,business_date::text,opened_at::text,closed_at::text FROM mbox.cash_handovers WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[c.scope.tenantId,c.scope.storeId,input.id])).rows[0]!
    if(!row||row.status==='closed'||row.revision!==input.expectedRevision)throw new CashHandoverError('交接状态或版本已变化，请刷新原记录')
    let movement=Number(row.movement_minor),count=row.count_snapshot,status=row.status
    if(input.action==='movement'){
     if(status!=='open'||!['in','out'].includes(input.direction??'')||!input.reference||input.reference.trim().length<3||input.reference.length>256)throw new CashHandoverError('请在盘点前登记实际取存款及独立凭证')
     const amount=minor(input.amountMinor);if(amount<=0)throw new CashHandoverError('取存金额必须大于零')
     movement+=input.direction==='in'?amount:-amount
     if(Number(row.opening_minor)+ledger.net-Number(row.opening_ledger_net)+movement<0)throw new CashHandoverError('取出额超过当前账面现金，请先核对漏记的备用金或存入')
    }else if(input.action==='count'){
     if(status!=='open'||!input.denominations)throw new CashHandoverError('请先撤回原盘点再重新实点')
     const counted=countCash(input.denominations),expected=Number(row.opening_minor)+ledger.net-Number(row.opening_ledger_net)+movement
     count={countedMinor:counted,expectedMinor:expected,differenceMinor:counted-expected,ledgerNet:ledger.net,ledgerCount:ledger.count,employeeId:c.employeeId,reason,denominations:input.denominations,submittedAt:new Date().toISOString()};status='count_submitted'
    }else if(input.action==='withdraw'){
     if(status!=='count_submitted'||count?.employeeId!==c.employeeId)throw new CashHandoverError('只能由原盘点人撤回尚未交接的盘点')
     count=null;status='open'
    }else if(input.action==='approve'){
     if(status!=='count_submitted'||!count||count.employeeId===c.employeeId||minor(input.reviewCountedMinor)!==count.countedMinor)throw new CashHandoverError('须由另一名财务人员独立实点，并与原盘点金额一致')
     if(count.ledgerCount!==ledger.count||count.ledgerNet!==ledger.net)throw new CashHandoverError('盘点后现金收退款发生变化，原盘点人须撤回并重新实点')
     status='closed'
    }else throw new CashHandoverError('未知现金交接操作')
    row=(await tx.query<Row>(`UPDATE mbox.cash_handovers SET status=$4,movement_minor=$5,count_snapshot=$6::jsonb,revision=revision+1,closed_by=CASE WHEN $4='closed' THEN $7::uuid ELSE NULL END,closed_at=CASE WHEN $4='closed' THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING *,business_date::text,opened_at::text,closed_at::text`,[c.scope.tenantId,c.scope.storeId,row.id,status,movement,JSON.stringify(count),c.employeeId])).rows[0]!
   }
   const result=this.dto(row,ledger)
   await tx.query(`INSERT INTO mbox.cash_handover_events(tenant_id,store_id,handover_id,employee_id,action,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[c.scope.tenantId,c.scope.storeId,row.id,c.employeeId,input.action,JSON.stringify({key,fingerprint,input:{...input,reason},result})])
   return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:c.employeeId},action:'cash.handover.'+input.action,objectType:'cash_handover',objectId:row.id,businessDate:c.businessDate,reason,afterData:result}],outboxMessages:[]}
   } catch(error){if(error instanceof CashHandoverError)error.notCommitted=true;throw error}
  })
 }
 private async ledger(tx:ScopedTransaction):Promise<Ledger>{const row=(await tx.query<{net:string;count:string;foreign_count:string}>(`SELECT COALESCE(SUM(amount_minor),0)::text AS net,count(*)::text AS count,count(*) FILTER(WHERE currency<>'CNY')::text AS foreign_count FROM mbox.reconciliation_entries WHERE tenant_id=$1 AND store_id=$2 AND provider='cash' AND entry_type IN('payment','refund')`,[tx.scope.tenantId,tx.scope.storeId])).rows[0]!;if(Number(row.foreign_count)>0)throw new CashHandoverError('存在其他币种现金，不能混合成人民币盘点');const net=Number(row.net),count=Number(row.count);if(!Number.isSafeInteger(net)||!Number.isSafeInteger(count))throw new CashHandoverError('现金账本超过安全计数范围');return {net,count}}
 private dto(row:Row,ledger:Ledger):JsonObject{return {id:row.id,businessDate:row.business_date,openedBy:row.opened_by,openedAt:row.opened_at,openingMinor:Number(row.opening_minor),openingDifferenceMinor:row.opening_difference_minor===null?null:Number(row.opening_difference_minor),openingReason:row.opening_reason,movementMinor:Number(row.movement_minor),expectedMinor:row.status==='closed'?row.count_snapshot?.expectedMinor??0:Number(row.opening_minor)+ledger.net-Number(row.opening_ledger_net)+Number(row.movement_minor),status:row.status,revision:row.revision,count:row.count_snapshot as unknown as JsonObject|null,closedBy:row.closed_by,closedAt:row.closed_at}}
}
function minor(value:number|undefined){if(value===undefined||!Number.isSafeInteger(value)||value<0||value>10000000000)throw new CashHandoverError('金额须为非负整数分且不超过系统上限');return value}
