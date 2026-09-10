import {createHash} from 'node:crypto'
import {GiftProductBudgetRepository} from './gift-product-budget-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {CustomerRepository} from './customer-repository.js'
import {CouponCalendarRepository} from './coupon-calendar-repository.js'
import {BenefitRepository} from './benefit-repository.js'
import {StackingPricingDraftRepository} from './stacking-pricing-draft-repository.js'
import {appendAuditEvent} from './command-executor.js'
import {matchesCardAudience} from './member-card-policy.js'
import {parseMemberGiftCampaign,assessGiftBudget,giftBudgetDate,MemberGiftCampaignError,type MemberGiftCampaignRule} from './member-gift-campaign-policy.js'

interface Campaign extends Record<string,unknown>{id:string;code:string;name:string;status:string;created_by_employee_id:string;approved_by_employee_id:string|null;rule:MemberGiftCampaignRule}
interface Product extends Record<string,unknown>{id:string;product_kind:'single'|'bundle';cost:string|null;price:string|null;currency:string|null}
interface Job extends Record<string,unknown>{id:string;campaign_version_id:string;campaign_code:string;cycle_key:string;customer_id:string;status:string;quantity:number;benefit_id:string|null;attempts:number}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function id(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new MemberGiftCampaignError('记录编号无效')}
function reason(value:string){if(typeof value!=='string'||value.trim().length<2||value.length>500)throw new MemberGiftCampaignError('请输入2至500字的操作原因')}
export class MemberGiftCampaignRepository{
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
  private async lock(code:string){
    const result=await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`member-gift:${this.scope.join(':')}:${code}`])
    if(!result.rows[0]?.locked)throw new MemberGiftCampaignError('活动正在处理，请稍后重试；不影响点单和收款')
  }
  private async identity(customerId:string){
    id(customerId)
    const result=await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[`table-customer-movement:${this.scope.join(':')}`])
    if(!result.rows[0]?.locked)throw new MemberGiftCampaignError('客户身份正在同步，请稍后重试')
    return(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id
  }
  private async now(){return new Date((await this.tx.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)}
  private async audit(action:string,objectId:string,employeeId:string|undefined,businessDate:string,why:string){
    await appendAuditEvent(this.tx,{actor:employeeId?{type:'employee',employeeId}:{type:'system',ref:'member-gift-worker'},businessDate,action:`member_gift.${action}`,objectType:'member_gift_campaign',objectId,reason:why,afterData:{operation:action}})
  }
  async list(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.configuration.view');if(cursor)id(cursor)
    const rows=(await this.tx.query<{id:string}>(`SELECT id FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21`,[...this.scope,cursor])).rows
    const items=[];for(const row of rows.slice(0,20))items.push(await this.find(row.id))
    return{items,nextCursor:rows.length>20?items.at(-1)!.id:null}
  }
  async options(employeeId:string,kind:string,search='',cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.configuration.view');if(cursor)id(cursor)
    if(search.length>80)throw new MemberGiftCampaignError('搜索内容最多80字')
    const like=`%${search.replace(/[\\%_]/g,'\\$&')}%`
    let sql:string
    if(kind==='products')sql=`SELECT id,name,code FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status='active' AND (name ILIKE $3 OR code ILIKE $3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 51`
    else if(kind==='projects'||kind==='audience-cards')sql=`SELECT id,name,code FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 ${kind==='projects'?"AND status<>'closed'":''} AND (name ILIKE $3 OR code ILIKE $3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 51`
    else if(kind==='calendars')sql=`SELECT v.id,v.code||' · 第'||v.version::text||'版' AS name,v.code FROM mbox.coupon_calendar_versions v WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.code ILIKE $3 AND ($4::uuid IS NULL OR v.id>$4) AND EXISTS(SELECT 1 FROM mbox.coupon_calendar_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.version_id=v.id AND d.action='publish') AND NOT EXISTS(SELECT 1 FROM mbox.coupon_calendar_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.version_id=v.id AND d.action='stop_issuing') ORDER BY v.id LIMIT 51`
    else if(kind==='stacking')sql=`SELECT v.id,v.policy_code||' · 第'||v.version::text||'版' AS name,v.policy_code AS code FROM mbox.stacking_pricing_drafts v WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.policy_code ILIKE $3 AND ($4::uuid IS NULL OR v.id>$4) AND EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.version_id=v.id AND d.action='publish') AND NOT EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions d WHERE d.tenant_id=v.tenant_id AND d.store_id=v.store_id AND d.version_id=v.id AND d.action='stop_issuing') ORDER BY v.id LIMIT 51`
    else if(kind==='customers'){
      if(search.trim().length<2)throw new MemberGiftCampaignError('请输入至少2字的会员号或客户编号，不能无条件导出客户')
      sql=`SELECT c.id,m.member_no AS name,c.public_id AS code FROM mbox.customers c JOIN LATERAL(SELECT member_no FROM mbox.customer_memberships WHERE tenant_id=c.tenant_id AND store_id=c.store_id AND customer_id=c.id AND status='active' ORDER BY joined_at DESC,id LIMIT 1) m ON true WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.merged_into_customer_id IS NULL AND (m.member_no ILIKE $3 OR c.public_id ILIKE $3) AND ($4::uuid IS NULL OR c.id>$4) ORDER BY c.id LIMIT 51`
    }else throw new MemberGiftCampaignError('查询类型无效')
    const rows=(await this.tx.query<{id:string;name:string;code:string}>(sql,[...this.scope,like,cursor])).rows
    return{items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null}
  }
  async jobs(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.configuration.view');if(cursor)id(cursor)
    const rows=(await this.tx.query<Record<string,unknown>&{id:string}>(`SELECT j.id,j.campaign_code,v.name,j.status,j.benefit_id,j.quantity,j.estimated_cost_minor::text,j.attempts,j.next_attempt_at::text,j.last_error_code,j.created_at::text,j.completed_at::text,c.public_id AS customer_reference FROM mbox.member_gift_delivery_jobs j JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=j.tenant_id AND v.store_id=j.store_id AND v.id=j.campaign_version_id JOIN mbox.customers c ON c.tenant_id=j.tenant_id AND c.store_id=j.store_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.store_id=$2 AND ($3::uuid IS NULL OR j.id>$3) ORDER BY j.id LIMIT 51`,[...this.scope,cursor])).rows
    return{items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null}
  }
  async selfJobs(customerId:string,cursor:string|null=null){
    id(customerId);if(cursor)id(cursor)
    const canonical=(await new CustomerRepository(this.tx).resolveCanonical(customerId)).id
    const rows=(await this.tx.query<Record<string,unknown>&{id:string}>(`SELECT j.id,v.name,j.status,j.benefit_id,j.quantity,j.created_at::text,j.completed_at::text FROM mbox.member_gift_delivery_jobs j JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=j.tenant_id AND v.store_id=j.store_id AND v.id=j.campaign_version_id WHERE j.tenant_id=$1 AND j.store_id=$2 AND mbox.canonical_customer_id(j.tenant_id,j.store_id,j.customer_id)=$3 AND ($4::uuid IS NULL OR j.id>$4) ORDER BY j.id LIMIT 51`,[...this.scope,canonical,cursor])).rows
    return{items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null}
  }
  async target(input:{versionId:string;customerIds:string[];cycleKey:string;employeeId:string;businessDate:string;reason:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'loyalty.policy.publish');reason(input.reason)
    if(!Array.isArray(input.customerIds)||input.customerIds.length<1||input.customerIds.length>50||new Set(input.customerIds).size!==input.customerIds.length)throw new MemberGiftCampaignError('每批请选择1至50名不重复客户')
    if((await this.find(input.versionId)).rule.trigger!=='targeted')throw new MemberGiftCampaignError('入卡礼只能由真实申请审核触发')
    const items=[]
    // One command is atomic: invalid recipients reject the whole batch rather
    // than silently presenting a partially submitted job list as complete.
    for(const customerId of input.customerIds)items.push(await this.enqueue({versionId:input.versionId,customerId,cycleKey:input.cycleKey}))
    await this.audit('target_queued',input.versionId,input.employeeId,input.businessDate,input.reason)
    return{items}
  }
  async controlJob(input:{jobId:string;action:'retry'|'cancel';employeeId:string;businessDate:string;reason:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'loyalty.policy.publish');id(input.jobId);reason(input.reason)
    if(!['retry','cancel'].includes(input.action))throw new MemberGiftCampaignError('任务操作无效')
    const job=(await this.tx.query<Job>('SELECT * FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,input.jobId])).rows[0]
    if(!job)throw new MemberGiftCampaignError('发券任务不存在')
    if(['issued','duplicate','cancelled'].includes(job.status))throw new MemberGiftCampaignError('已结束任务不能重新发放或取消；已发券另走原核销规则')
    if(input.action==='retry'){
      if((await this.find(job.campaign_version_id)).status!=='published')throw new MemberGiftCampaignError('活动已经停止，不能通过重试绕过规则；需单独审批补偿')
      await this.tx.query("UPDATE mbox.member_gift_delivery_jobs SET next_attempt_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,job.id])
    }else await this.tx.query("UPDATE mbox.member_gift_delivery_jobs SET status='cancelled',completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,job.id])
    await this.audit(`job_${input.action}`,job.id,input.employeeId,input.businessDate,input.reason)
    return{jobId:job.id,status:input.action==='cancel'?'cancelled':job.status,scheduled:input.action==='retry'}
  }
  async find(versionId:string):Promise<Campaign>{
    id(versionId)
    const row=(await this.tx.query<Record<string,unknown>>(`SELECT v.*,calendar.code AS calendar_code,calendar.version AS calendar_version,project.name AS card_project_name FROM mbox.member_gift_campaign_versions v JOIN mbox.coupon_calendar_versions calendar ON calendar.tenant_id=v.tenant_id AND calendar.store_id=v.store_id AND calendar.id=v.coupon_calendar_version_id LEFT JOIN mbox.member_card_projects project ON project.tenant_id=v.tenant_id AND project.store_id=v.store_id AND project.id=v.card_project_id WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.id=$3`,[...this.scope,versionId])).rows[0]
    if(!row)throw new MemberGiftCampaignError('活动不存在或不属于当前门店')
    const products=await this.tx.query<{product_id:string;name:string;unit_cost_minor:string}>(`SELECT pool.product_id,p.name,pool.unit_cost_minor::text FROM mbox.member_gift_campaign_products pool JOIN mbox.products p ON p.tenant_id=pool.tenant_id AND p.store_id=pool.store_id AND p.id=pool.product_id WHERE pool.tenant_id=$1 AND pool.store_id=$2 AND pool.campaign_version_id=$3 ORDER BY pool.product_id`,[...this.scope,versionId])
    return{...row,products:products.rows,id:String(row.id),code:String(row.code),name:String(row.name),status:String(row.status),created_by_employee_id:String(row.created_by_employee_id),approved_by_employee_id:row.approved_by_employee_id?String(row.approved_by_employee_id):null,
      rule:parseMemberGiftCampaign({trigger:row.trigger_kind,cardProjectId:row.card_project_id,audience:{minimumTier:row.minimum_tier,cardCodes:row.card_codes,cardMatch:row.card_match,tierAndCards:row.tier_and_cards},
        pricingKind:row.pricing_kind,fixedPriceMinor:row.fixed_price_minor===null?null:Number(row.fixed_price_minor),stackingVersionId:row.stacking_version_id,
        quantityPerCustomer:Number(row.quantity_per_customer),maximumQuantity:Number(row.maximum_quantity),maximumDailyQuantity:Number(row.maximum_daily_quantity),maximumCostMinor:Number(row.maximum_cost_minor),maximumDailyCostMinor:Number(row.maximum_daily_cost_minor),maximumUnitCostMinor:Number(row.maximum_unit_cost_minor),budgetDateBasis:row.budget_date_basis,budgetDayStartMinute:Number(row.budget_day_start_minute),currency:row.currency,
        availableFrom:new Date(row.available_from as string).toISOString(),availableUntil:new Date(row.available_until as string).toISOString(),couponCalendarVersionId:row.coupon_calendar_version_id,productIds:products.rows.map(p=>p.product_id)})}
  }
  private async products(productIds:string[]){
    const result=await this.tx.query<Product>(`SELECT p.id,p.product_kind,p.cost_amount_minor::text AS cost,price.amount_minor::text AS price,price.currency FROM mbox.products p
      LEFT JOIN LATERAL(SELECT amount_minor,currency FROM mbox.product_prices WHERE tenant_id=p.tenant_id AND store_id=p.store_id AND product_id=p.id AND price_type='standard' AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) ORDER BY valid_from DESC,id DESC LIMIT 1) price ON true
      WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=ANY($3::uuid[]) AND p.status='active'`,[...this.scope,productIds])
    if(result.rows.length!==productIds.length||result.rows.some(p=>p.cost===null||p.price===null||p.currency!=='CNY'||!Number.isSafeInteger(Number(p.cost))||!Number.isSafeInteger(Number(p.price))||Number(p.cost)<0||Number(p.price)<0))throw new MemberGiftCampaignError('商品已停用、缺少有效售价或成本未知，不能发券')
    const budget=new GiftProductBudgetRepository(this.tx)
    for(const product of result.rows)product.cost=String(await budget.maximumCost(product.id,Number(product.cost),product.product_kind))
    return result.rows
  }
  async create(input:{code:string;name:string;rule:unknown;employeeId:string;businessDate:string;reason:string;requestKey:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'loyalty.configuration.edit')
    reason(input.reason)
    if(!/^[A-Z][A-Z0-9_]{1,39}$/.test(input.code)||input.name.trim().length<2||input.name.length>120||input.requestKey.length<8||input.requestKey.length>128)throw new MemberGiftCampaignError('活动名称、代码或请求编号无效')
    const rule=parseMemberGiftCampaign(input.rule),fingerprint=hash({...input,rule,requestKey:undefined})
    await this.lock(input.code)
    const old=(await this.tx.query<{id:string;request_fingerprint:string}>('SELECT id,request_fingerprint FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND request_key=$3',[...this.scope,input.requestKey])).rows[0]
    if(old){if(old.request_fingerprint!==fingerprint)throw new MemberGiftCampaignError('同一请求不能修改活动内容');return{versionId:old.id,replayed:true}}
    const previous=(await this.tx.query<{budget_date_basis:string;budget_day_start_minute:number;trigger_kind:string;card_project_id:string|null}>('SELECT budget_date_basis,budget_day_start_minute,trigger_kind,card_project_id FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3 ORDER BY version DESC LIMIT 1',[...this.scope,input.code])).rows[0]
    if(previous&&(previous.budget_date_basis!==rule.budgetDateBasis||previous.budget_day_start_minute!==rule.budgetDayStartMinute||previous.trigger_kind!==rule.trigger||previous.card_project_id!==rule.cardProjectId))throw new MemberGiftCampaignError('同活动换日及触发身份不能改写，请使用新活动编号')
    if(rule.audience.cardCodes.length){
      const cards=await this.tx.query('SELECT id FROM mbox.member_card_projects WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($3::text[])',[...this.scope,rule.audience.cardCodes])
      if(cards.rows.length!==rule.audience.cardCodes.length)throw new MemberGiftCampaignError('目标兴趣卡包含不存在或其他门店的项目')
    }
    const products=await this.products(rule.productIds)
    if(rule.pricingKind==='fixed_price'){
      await new StackingPricingDraftRepository(this.tx).find(rule.stackingVersionId!)
      if(products.some(p=>Number(p.price)<=rule.fixedPriceMinor!))throw new MemberGiftCampaignError('固定兑换价须低于商品池内每款商品的标准价')
    }
    if(!assessGiftBudget(rule,{quantity:0,dailyQuantity:0,costMinor:0,dailyCostMinor:0},Math.max(...products.map(p=>Number(p.cost)))).allowed)throw new MemberGiftCampaignError('预算不足以兑现单人赠送承诺')
    await new CouponCalendarRepository(this.tx).find(rule.couponCalendarVersionId)
    const version=Number((await this.tx.query<{n:number}>('SELECT COALESCE(max(version),0)+1 AS n FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3',[...this.scope,input.code])).rows[0]!.n)
    const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.member_gift_campaign_versions(tenant_id,store_id,code,version,name,trigger_kind,card_project_id,minimum_tier,card_codes,card_match,tier_and_cards,quantity_per_customer,maximum_quantity,maximum_daily_quantity,maximum_cost_minor,maximum_daily_cost_minor,maximum_unit_cost_minor,budget_date_basis,budget_day_start_minute,available_from,available_until,coupon_calendar_version_id,created_by_employee_id,reason,request_key,request_fingerprint,pricing_kind,fixed_price_minor,stacking_version_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,[...this.scope,input.code,version,input.name.trim(),rule.trigger,rule.cardProjectId,rule.audience.minimumTier,rule.audience.cardCodes,rule.audience.cardMatch,rule.audience.tierAndCards,rule.quantityPerCustomer,rule.maximumQuantity,rule.maximumDailyQuantity,rule.maximumCostMinor,rule.maximumDailyCostMinor,rule.maximumUnitCostMinor,rule.budgetDateBasis,rule.budgetDayStartMinute,rule.availableFrom,rule.availableUntil,rule.couponCalendarVersionId,input.employeeId,input.reason.trim(),input.requestKey,fingerprint,rule.pricingKind,rule.fixedPriceMinor,rule.stackingVersionId])).rows[0]!
    for(const p of products)await this.tx.query('INSERT INTO mbox.member_gift_campaign_products(tenant_id,store_id,campaign_version_id,product_id,unit_cost_minor,unit_price_minor) VALUES($1,$2,$3,$4,$5,$6)',[...this.scope,row.id,p.id,p.cost,p.price])
    await this.audit('created',row.id,input.employeeId,input.businessDate,input.reason)
    return{versionId:row.id,replayed:false}
  }
  async decide(input:{versionId:string;action:'approve'|'publish'|'stop';employeeId:string;businessDate:string;reason:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,input.action==='approve'?'loyalty.configuration.approve':'loyalty.policy.publish')
    reason(input.reason)
    if(!['approve','publish','stop'].includes(input.action))throw new MemberGiftCampaignError('活动操作无效')
    let campaign=await this.find(input.versionId);await this.lock(campaign.code)
    await this.tx.query('SELECT id FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,campaign.id]);campaign=await this.find(input.versionId)
    const status={approve:'approved',publish:'published',stop:'stopped'}[input.action]
    if(campaign.status===status)return{versionId:campaign.id,status,replayed:true}
    if(campaign.status!=={approve:'draft',publish:'approved',stop:'published'}[input.action])throw new MemberGiftCampaignError('当前活动状态不支持此操作')
    if(input.action!=='stop'){
      if(campaign.created_by_employee_id===input.employeeId||(input.action==='publish'&&campaign.approved_by_employee_id===input.employeeId))throw new MemberGiftCampaignError('规则创建、审核、发布须由不同授权人员操作')
      const products=await this.products(campaign.rule.productIds)
      if(campaign.rule.pricingKind==='fixed_price'&&products.some(p=>Number(p.price)<=campaign.rule.fixedPriceMinor!))throw new MemberGiftCampaignError('商品现价已不高于固定兑换价，请重新配置活动')
      if(Date.parse(campaign.rule.availableUntil)<=(await this.now()).getTime())throw new MemberGiftCampaignError('活动发放期限已结束')
      if(input.action==='publish'&&(await new CouponCalendarRepository(this.tx).find(campaign.rule.couponCalendarVersionId)).status!=='published')throw new MemberGiftCampaignError('券时间规则尚未发布或已停止发放')
      if(input.action==='publish'&&campaign.rule.pricingKind==='fixed_price')await new StackingPricingDraftRepository(this.tx).publishedForIssuance(campaign.rule.stackingVersionId!)
    }
    const prefix={approve:'approved',publish:'published',stop:'stopped'}[input.action]
    await this.tx.query(`UPDATE mbox.member_gift_campaign_versions SET status=$4,${prefix}_by_employee_id=$5,${prefix}_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,campaign.id,status,input.employeeId])
    await this.audit(input.action,campaign.id,input.employeeId,input.businessDate,input.reason)
    return{versionId:campaign.id,status,replayed:false}
  }
  private async eligible(customerId:string,rule:MemberGiftCampaignRule){
    const row=(await this.tx.query<{status:string;tier:string;account_status:string}>(`SELECT m.status,COALESCE(period.tier,'member') AS tier,COALESCE(account.redemption_status,'active') AS account_status FROM mbox.customer_memberships m
      LEFT JOIN mbox.loyalty_accounts account ON account.tenant_id=m.tenant_id AND account.store_id=m.store_id AND account.membership_id=m.id AND account.customer_id=m.customer_id
      LEFT JOIN LATERAL(SELECT tier FROM mbox.membership_tier_periods WHERE tenant_id=m.tenant_id AND store_id=m.store_id AND membership_id=m.id AND starts_at<=clock_timestamp() AND status IN('active','grace') AND CASE WHEN status='grace' THEN grace_ends_at>clock_timestamp() ELSE ends_at IS NULL OR ends_at>clock_timestamp() END ORDER BY starts_at DESC,id DESC LIMIT 1) period ON account.id IS NOT NULL
      WHERE m.tenant_id=$1 AND m.store_id=$2 AND mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)=$3 AND EXISTS(SELECT 1 FROM mbox.customers c WHERE c.tenant_id=m.tenant_id AND c.store_id=m.store_id AND c.id=$3 AND c.status='active') ORDER BY (m.customer_id=$3) DESC,m.joined_at DESC,m.id LIMIT 1`,[...this.scope,customerId])).rows[0]
    if(!row||row.status!=='active'||row.account_status!=='active')return false
    const cards=await this.tx.query<{code:string}>(`SELECT p.code FROM mbox.member_cards c JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id WHERE c.tenant_id=$1 AND c.store_id=$2 AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=$3 AND c.status='active' AND c.valid_until>clock_timestamp()`,[...this.scope,customerId])
    return matchesCardAudience(rule.audience,{tier:row.tier,activeCardCodes:cards.rows.map(c=>c.code)})
  }
  async enqueue(input:{versionId:string;customerId:string;cycleKey:string;applicationId?:string}){
    const customerId=await this.identity(input.customerId)
    let campaign=await this.find(input.versionId);await this.lock(campaign.code);campaign=await this.find(input.versionId)
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(input.cycleKey))throw new MemberGiftCampaignError('发放批次编号无效')
    // Campaign code, not version, owns once-per-cycle eligibility after upgrades
    // and identity merges. A cancelled/blocked job is not a fresh entitlement.
    const existing=(await this.tx.query<{id:string;status:string}>(`SELECT id,status FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND campaign_code=$3 AND cycle_key=$4 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$5 ORDER BY created_at,id LIMIT 1`,[...this.scope,campaign.code,input.cycleKey,customerId])).rows[0]
    if(existing)return{jobId:existing.id,status:existing.status,replayed:true}
    const now=await this.now()
    if(campaign.rule.trigger==='targeted'&&(campaign.status!=='published'||now.getTime()<Date.parse(campaign.rule.availableFrom)||now.getTime()>=Date.parse(campaign.rule.availableUntil)))throw new MemberGiftCampaignError('活动当前不接受新发券任务')
    // Card-entry intent is based on the committed approval instant, not worker
    // uptime. The database validates that the campaign was open at that time.
    if(campaign.rule.trigger==='card_entry'&&(!input.applicationId||input.cycleKey!=='entry'))throw new MemberGiftCampaignError('入卡礼须对应真实审核记录')
    if(campaign.rule.trigger==='targeted'&&!await this.eligible(customerId,campaign.rule))throw new MemberGiftCampaignError('客户当前不符合活动目标人群')
    const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.member_gift_delivery_jobs(tenant_id,store_id,campaign_version_id,campaign_code,cycle_key,customer_id,source_application_id,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[...this.scope,campaign.id,campaign.code,input.cycleKey,customerId,input.applicationId??null,campaign.rule.quantityPerCustomer])).rows[0]!
    return{jobId:row.id,status:'pending',replayed:false}
  }
  async deliver(jobId:string){
    id(jobId)
    const found=(await this.tx.query<Job>('SELECT * FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,jobId])).rows[0]
    if(!found)throw new MemberGiftCampaignError('发券任务不存在')
    const customerId=await this.identity(found.customer_id);await this.lock(found.campaign_code)
    const job=(await this.tx.query<Job>('SELECT * FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,jobId])).rows[0]!
    if(['issued','cancelled','duplicate'].includes(job.status))return{jobId,status:job.status,benefitId:job.benefit_id,replayed:true}
    const campaign=await this.find(job.campaign_version_id),now=await this.now(),date=giftBudgetDate(campaign.rule,now)
    const blocked=async(code:string)=>{
      const delay=['campaign_closed','coupon_calendar_closed','campaign_quantity_exceeded','campaign_cost_exceeded'].includes(code)?30*86400:Math.min(86400,900*2**Math.min(job.attempts,7))
      await this.tx.query("UPDATE mbox.member_gift_delivery_jobs SET status='blocked',attempts=attempts+1,last_error_code=$4,next_attempt_at=clock_timestamp()+($5::int*interval '1 second') WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,jobId,code,delay])
      return{jobId,status:'blocked',reason:code,replayed:false}
    }
    if(campaign.status!=='published'||now.getTime()>=Date.parse(campaign.rule.availableUntil))return blocked('campaign_closed')
    if(!await this.eligible(customerId,campaign.rule))return blocked('audience_changed')
    const duplicate=(await this.tx.query<{id:string}>(`SELECT id FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND campaign_code=$3 AND cycle_key=$4 AND id<>$5 AND status='issued' AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$6 LIMIT 1`,[...this.scope,campaign.code,job.cycle_key,jobId,customerId])).rows[0]
    if(duplicate){await this.tx.query("UPDATE mbox.member_gift_delivery_jobs SET status='duplicate',completed_at=clock_timestamp(),last_error_code='same_family_already_issued' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,jobId]);return{jobId,status:'duplicate',replayed:false}}
    let products:Product[]
    try{products=await this.products(campaign.rule.productIds)}catch(error){if(error instanceof MemberGiftCampaignError)return blocked('product_unavailable_or_cost_unknown');throw error}
    const usage=(await this.tx.query<{quantity:string;daily_quantity:string;cost:string;daily_cost:string}>(`SELECT COALESCE(sum(quantity),0)::text AS quantity,COALESCE(sum(quantity) FILTER(WHERE budget_date=$4::date),0)::text AS daily_quantity,COALESCE(sum(estimated_cost_minor),0)::text AS cost,COALESCE(sum(estimated_cost_minor) FILTER(WHERE budget_date=$4::date),0)::text AS daily_cost FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND campaign_code=$3 AND status='issued'`,[...this.scope,campaign.code,date])).rows[0]!
    const budget=assessGiftBudget(campaign.rule,{quantity:Number(usage.quantity),dailyQuantity:Number(usage.daily_quantity),costMinor:Number(usage.cost),dailyCostMinor:Number(usage.daily_cost)},Math.max(...products.map(p=>Number(p.cost))))
    if(!budget.allowed)return blocked(budget.reason)
    if((await new CouponCalendarRepository(this.tx).find(campaign.rule.couponCalendarVersionId)).status!=='published')return blocked('coupon_calendar_closed')
    if(campaign.rule.pricingKind==='fixed_price'&&(await new StackingPricingDraftRepository(this.tx).find(campaign.rule.stackingVersionId!)).status!=='published')return blocked('stacking_policy_closed')
    const benefit=await new BenefitRepository(this.tx).issue({customerId,benefitCode:campaign.code,quantity:job.quantity,couponCalendarVersionId:campaign.rule.couponCalendarVersionId,
      ...(campaign.rule.pricingKind==='fixed_price'?{benefitType:'discount' as const,valueAmountMinor:0,currency:'CNY',couponPriceCampaignVersionId:campaign.id}:{benefitType:'gift_product' as const,allowedProductIds:campaign.rule.productIds}),
      benefitSnapshot:{name:campaign.name},authorizationSource:{kind:'member_gift_campaign',campaignVersionId:campaign.id,jobId},reason:'已审核发布的活动发放',issuanceIdempotencyKey:`member-gift:${jobId}`,issuanceFingerprint:hash({jobId,campaignVersionId:campaign.id})})
    await this.tx.query("UPDATE mbox.member_gift_delivery_jobs SET status='issued',benefit_id=$4,budget_date=$5,estimated_cost_minor=$6,attempts=attempts+1,last_error_code=NULL,completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,jobId,benefit.id,date,budget.estimatedCostMinor])
    await this.audit('issued',jobId,undefined,date,'发券成功，记录预算承诺，不计营业收入')
    return{jobId,status:'issued',benefitId:benefit.id,replayed:false}
  }
}
