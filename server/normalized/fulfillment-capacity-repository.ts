import type { ScopedTransaction } from './transaction-runner.js'

export type FulfillmentCapacityErrorCode =
  | 'FULFILLMENT_CAPACITY_EXCEEDED'
  | 'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE'
  | 'FULFILLMENT_CAPACITY_STATE_CONFLICT'

export class FulfillmentCapacityUnavailableError extends Error {
  constructor(readonly code: FulfillmentCapacityErrorCode, message: string) {
    super(message)
    this.name = 'FulfillmentCapacityUnavailableError'
  }
}

interface CapacityFunctionRow extends Record<string, unknown> {
  affected_count: string | number
}

export class FulfillmentCapacityRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  reserveForImmediatePaymentOrder(orderId: string): Promise<number> {
    return this.runCapacityFunction(
      'reserve_order_fulfillment_capacity',
      orderId,
    )
  }

  activateForPaidOrder(orderId: string): Promise<number> {
    return this.runCapacityFunction(
      'activate_order_fulfillment_capacity',
      orderId,
    )
  }

  releaseReservedForOrder(orderId: string, reason: string): Promise<number> {
    requireUuid(orderId)
    const normalizedReason = reason.trim()
    if (normalizedReason.length === 0 || normalizedReason.length > 1_000) {
      throw new TypeError('capacity release reason must contain between 1 and 1000 characters')
    }
    return this.queryCount(`
      SELECT mbox.release_reserved_order_fulfillment_capacity(
        $1::uuid, $2::uuid, $3::uuid, $4::text
      ) AS affected_count
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      orderId,
      normalizedReason,
    ])
  }

  private runCapacityFunction(functionName: string, orderId: string): Promise<number> {
    requireUuid(orderId)
    if (!['reserve_order_fulfillment_capacity', 'activate_order_fulfillment_capacity'].includes(functionName)) {
      throw new TypeError('unsupported capacity operation')
    }
    return this.queryCount(`
      SELECT mbox.${functionName}($1::uuid, $2::uuid, $3::uuid) AS affected_count
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
  }

  private async queryCount(sql: string, values: readonly unknown[]): Promise<number> {
    try {
      const result = await this.transaction.query<CapacityFunctionRow>(sql, values)
      const value = result.rows[0]?.affected_count
      const count = typeof value === 'number' ? value : Number(value)
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Capacity operation returned an invalid affected count')
      }
      return count
    } catch (error) {
      const mapped = mapCapacityError(error)
      if (mapped !== null) throw mapped
      throw error
    }
  }
}

function mapCapacityError(error: unknown): FulfillmentCapacityUnavailableError | null {
  if (!isDatabaseError(error) || error.code !== '23514') return null
  if (error.message.includes('capacity exceeded')) {
    return new FulfillmentCapacityUnavailableError(
      'FULFILLMENT_CAPACITY_EXCEEDED',
      capacityFailureDetails(error),
    )
  }
  if (error.message.includes('published capacity policy')
    || error.message.includes('order due time')) {
    return new FulfillmentCapacityUnavailableError(
      'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE',
      `出品工作站${capacityStation(error.message)}未配置覆盖所选时间的已发布产能窗口，请由值班经理核对该站产能规则和商品出品时间`,
    )
  }
  if (error.message.includes('capacity reservation')
    || error.message.includes('capacity activation')) {
    return new FulfillmentCapacityUnavailableError(
      'FULFILLMENT_CAPACITY_STATE_CONFLICT',
      '出品产能状态已经变化，请刷新后重试',
    )
  }
  return null
}

function isDatabaseError(value: unknown): value is { code: string; message: string;detail?:unknown } {
  return typeof value === 'object' && value !== null
    && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string'
}

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError('orderId must be a UUID')
  }
}

function capacityStation(message:string):string{return message.endsWith('station bar')?'吧台':message.endsWith('station kitchen')?'后厨':'（原记录未指出）'}
function capacityFailureDetails(error:{message:string;detail?:unknown}):string{
 try{const facts=typeof error.detail==='string'?JSON.parse(error.detail):null
 if(facts&&['bar','kitchen'].includes(facts.station)&&[facts.capacity,facts.used,facts.required].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0)&&Number.isFinite(Date.parse(facts.startsAt))&&Number.isFinite(Date.parse(facts.endsAt))){const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});return `${facts.station==='bar'?'吧台':'后厨'} ${time(facts.startsAt)}至${time(facts.endsAt)}产能不足：已占用${facts.used}，本次需${facts.required}，容量${facts.capacity}（产能单位）；请调整商品或由员工另选可用时段。后续时段是否有余量尚未核对。`}
 }catch{/* Never expose unvalidated database detail. */}
 return `${capacityStation(error.message)}出品时段产能不足，原记录未包含具体占用数字；请刷新产能安排后调整商品或时段`
}
