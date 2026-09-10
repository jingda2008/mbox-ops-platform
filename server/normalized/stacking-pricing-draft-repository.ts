import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'
import { appendAuditEvent } from './command-executor.js'
import { parseStackingPolicy, StackingPricingError, type StackingPolicy } from './stacking-pricing.js'
import {StaffAccessRepository} from './staff-access-repository.js'

type Decision={action:'approve'|'publish'|'stop_issuing';employeeId:string;reason:string;createdAt:string}

interface DraftRow extends Record<string, unknown> {
  id: string; policy_code: string; version: number; allow_member_price: boolean; allow_bundle_price: boolean
  allow_other_coupons: boolean; allow_points: boolean; max_coupons: number; calculation_order: StackingPolicy['calculationOrder']
  maximum_discount_minor: string | null; minimum_payable_minor: string; created_at: string; request_fingerprint: string
  allow_checkout_upgrade:boolean;created_by_employee_id:string;decisions?:Decision[]
}
const columns = `id,policy_code,version,allow_member_price,allow_bundle_price,allow_other_coupons,allow_points,max_coupons,
  calculation_order,maximum_discount_minor::text,minimum_payable_minor::text,created_at::text,request_fingerprint,allow_checkout_upgrade,created_by_employee_id`
const selected=`${columns},COALESCE((SELECT jsonb_agg(jsonb_build_object('action',d.action,'employeeId',d.employee_id,'reason',d.reason,'createdAt',d.created_at) ORDER BY d.created_at,d.id) FROM mbox.stacking_pricing_decisions d WHERE d.tenant_id=stacking_pricing_drafts.tenant_id AND d.store_id=stacking_pricing_drafts.store_id AND d.version_id=stacking_pricing_drafts.id),'[]'::jsonb) AS decisions`
function view(row: DraftRow) {
  const decisions=row.decisions??[]
  const status:'draft'|'approved'|'published'|'stopped'=decisions.some(d=>d.action==='stop_issuing')?'stopped':decisions.some(d=>d.action==='publish')?'published':decisions.some(d=>d.action==='approve')?'approved':'draft'
  return { id: row.id, code: row.policy_code, version: row.version, status, createdAt: row.created_at,createdByEmployeeId:row.created_by_employee_id,decisions,
    policy: parseStackingPolicy({ allowMemberPrice: row.allow_member_price, allowBundlePrice: row.allow_bundle_price,
      allowOtherCoupons: row.allow_other_coupons, allowPoints: row.allow_points, maxCoupons: row.max_coupons,
      allowCheckoutUpgrade:row.allow_checkout_upgrade,
      calculationOrder: row.calculation_order, maximumDiscountMinor: row.maximum_discount_minor === null ? null : Number(row.maximum_discount_minor), minimumPayableMinor: Number(row.minimum_payable_minor) }) }
}
export class StackingDraftConflictError extends Error {}
export class StackingPricingDraftRepository {
  constructor(private readonly transaction: ScopedTransaction) {}
  async list() {
    const rows = await this.transaction.query<DraftRow>(`SELECT ${selected} FROM mbox.stacking_pricing_drafts
      WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return rows.rows.map(view)
  }
  async find(versionId:string){
    if(typeof versionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId))throw new StackingPricingError('规则版本编号无效')
    const row=(await this.transaction.query<DraftRow>(`SELECT ${selected} FROM mbox.stacking_pricing_drafts WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,versionId])).rows[0]
    if(!row)throw new StackingPricingError('规则版本不存在')
    return view(row)
  }
  private async lockVersion(versionId:string){
    const lock=await this.transaction.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`stacking-release:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${versionId}`])
    if(!lock.rows[0]?.ok)throw new StackingDraftConflictError('规则正在处理，请刷新核对')
  }
  async publishedForIssuance(versionId:string){
    await this.lockVersion(versionId)
    const policy=await this.find(versionId)
    if(policy.status!=='published')throw new StackingPricingError('叠加规则尚未发布或已停发')
    return policy
  }
  async decide(input:{versionId:string;action:Decision['action'];employeeId:string;businessDate:string;reason:string}){
    if(!['approve','publish','stop_issuing'].includes(input.action)||typeof input.reason!=='string'||input.reason.trim().length<2||input.reason.length>500)throw new StackingPricingError('请填写有效操作和原因')
    await new StaffAccessRepository(this.transaction).assertPermission(input.employeeId,input.action==='approve'?'loyalty.configuration.approve':'loyalty.policy.publish')
    await this.lockVersion(input.versionId)
    const policy=await this.find(input.versionId),reason=input.reason.trim()
    const previous=policy.decisions.find(d=>d.action===input.action)
    if(previous){if(previous.employeeId!==input.employeeId||previous.reason!==reason)throw new StackingDraftConflictError('此决定已由另一操作完成，请刷新查看');return policy}
    if(input.action==='approve'&&(policy.status!=='draft'||policy.createdByEmployeeId===input.employeeId))throw new StackingPricingError('只有非编辑人可以审核草稿')
    if(input.action==='publish'&&(policy.status!=='approved'||policy.createdByEmployeeId===input.employeeId||policy.decisions.some(d=>d.action==='approve'&&d.employeeId===input.employeeId)))throw new StackingPricingError('须由不同于编辑和审核人的授权员工发布')
    if(input.action==='stop_issuing'&&policy.status!=='published')throw new StackingPricingError('只有已发布规则可以停发；已发券不会撤销')
    await this.transaction.query('INSERT INTO mbox.stacking_pricing_decisions(tenant_id,store_id,version_id,action,employee_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[this.transaction.scope.tenantId,this.transaction.scope.storeId,input.versionId,input.action,input.employeeId,reason])
    await appendAuditEvent(this.transaction,{actor:{type:'employee',employeeId:input.employeeId},businessDate:input.businessDate,action:`stacking_pricing.${input.action}`,objectType:'stacking_pricing_draft',objectId:input.versionId,reason})
    return this.find(input.versionId)
  }
  async save(input: { code: string; policy: unknown; employeeId: string; businessDate: string; reason: string; requestKey: string; expectedVersion: number }) {
    if (typeof input.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(input.code)) throw new StackingPricingError('规则编号须为2至40位大写字母、数字或下划线')
    if (typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.length > 500) throw new StackingPricingError('请填写2至500字的修改原因')
    if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(input.requestKey)) throw new StackingPricingError('保存操作编号无效')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2_147_483_646) throw new StackingPricingError('草稿版本无效')
    const policy = parseStackingPolicy(input.policy)
    const fingerprint = createHash('sha256').update(JSON.stringify({ code: input.code, policy, employeeId: input.employeeId, reason: input.reason.trim(), expectedVersion: input.expectedVersion })).digest('hex')
    const ids = [this.transaction.scope.tenantId, this.transaction.scope.storeId]
    // Short local transaction lock only; no network/provider call while held.
    await this.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stacking-draft:${ids.join(':')}`])
    const previous = await this.transaction.query<DraftRow>(`SELECT ${columns} FROM mbox.stacking_pricing_drafts WHERE tenant_id=$1 AND store_id=$2 AND request_key=$3`, [...ids, input.requestKey])
    if (previous.rows[0]) {
      if (previous.rows[0].request_fingerprint !== fingerprint) throw new StackingDraftConflictError('同一保存操作的内容已变化，请重新读取草稿')
      return { ...await this.find(previous.rows[0].id), replayed: true }
    }
    const latest = await this.transaction.query<{ version: number }>('SELECT COALESCE(max(version),0)::integer AS version FROM mbox.stacking_pricing_drafts WHERE tenant_id=$1 AND store_id=$2 AND policy_code=$3', [...ids, input.code])
    if (latest.rows[0]!.version !== input.expectedVersion) throw new StackingDraftConflictError('其他员工已保存新版本，请重新读取后修改')
    const inserted = await this.transaction.query<DraftRow>(`INSERT INTO mbox.stacking_pricing_drafts(
      tenant_id,store_id,policy_code,version,allow_member_price,allow_bundle_price,allow_other_coupons,allow_points,max_coupons,
      calculation_order,maximum_discount_minor,minimum_payable_minor,created_by_employee_id,reason,request_key,request_fingerprint,allow_checkout_upgrade
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${columns}`,
    [...ids, input.code, input.expectedVersion + 1, policy.allowMemberPrice, policy.allowBundlePrice, policy.allowOtherCoupons, policy.allowPoints,
      policy.maxCoupons, policy.calculationOrder, policy.maximumDiscountMinor, policy.minimumPayableMinor, input.employeeId, input.reason.trim(), input.requestKey, fingerprint,policy.allowCheckoutUpgrade])
    const row = inserted.rows[0]!
    await appendAuditEvent(this.transaction, { actor: { type: 'employee', employeeId: input.employeeId }, businessDate: input.businessDate,
      action: 'stacking_pricing.draft_saved', objectType: 'stacking_pricing_draft', objectId: row.id, reason: input.reason.trim(),
      afterData: { code: input.code, version: row.version, status: 'draft' } })
    return { ...view(row), replayed: false }
  }
}
