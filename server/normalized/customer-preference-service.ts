import { createHash } from 'node:crypto'
import type { JsonCodec, JsonObject } from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  CustomerPreferenceRepository,
  type CustomerPreferenceSnapshot,
  type PreferencePolarity,
} from './customer-preference-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface PublicCustomerPreferenceContext {
  scope: Readonly<StoreScope>
  customerId: string
  actorRef: string
  businessDate: string
}

export class CustomerPreferenceService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  list(context: PublicCustomerPreferenceContext): Promise<CustomerPreferenceSnapshot> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerPreferenceRepository(transaction).recompute(context.customerId)
    ))
  }

  declare(context: PublicCustomerPreferenceContext, input: Readonly<{
    key: string
    value: string
    polarity: PreferencePolarity
    validUntil: string | null
    idempotencyKey: string
  }>) {
    const publicId=deterministicPublicId('preference-declaration',context.scope.storeId,input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.preference.declare',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ customerId: context.customerId, ...input }),
      resultCodec: objectCodec<CustomerPreferenceSnapshot>(),
    }, async (transaction) => {
      const result=await new CustomerPreferenceRepository(transaction).declare({
        ...input,publicId,customerId:context.customerId,
      })
      return {
        result,
        auditEvents: [{
          actor:{type:'guest' as const,ref:context.actorRef},
          action:'customer.preference.declared',objectType:'customer_preference_declaration',
          objectId:publicId,businessDate:context.businessDate,
          afterData:{key:input.key,value:input.value,polarity:input.polarity,validUntil:input.validUntil},
        }],
        outboxMessages:[],
      }
    })
  }

  withdraw(context: PublicCustomerPreferenceContext, input: Readonly<{
    sourcePublicId: string
    reason: string
    idempotencyKey: string
  }>) {
    const publicId=deterministicPublicId('preference-withdrawal',context.scope.storeId,input.idempotencyKey)
    return this.commands.execute({
      scope:context.scope,
      operationScope:'customer.preference.withdraw',
      idempotencyKey:input.idempotencyKey,
      requestFingerprint:fingerprint({customerId:context.customerId,...input}),
      resultCodec:objectCodec<CustomerPreferenceSnapshot>(),
    },async(transaction)=>{
      const result=await new CustomerPreferenceRepository(transaction).withdraw({
        ...input,publicId,customerId:context.customerId,
      })
      return {
        result,
        auditEvents:[{
          actor:{type:'guest' as const,ref:context.actorRef},
          action:'customer.preference.withdrawn',objectType:'customer_preference_source',
          objectId:input.sourcePublicId,businessDate:context.businessDate,reason:input.reason,
        }],
        outboxMessages:[],
      }
    })
  }
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode:(value)=>value as unknown as JsonObject,
    decode:(value)=>{
      if (typeof value!=='object'||value===null||Array.isArray(value)) {
        throw new TypeError('Stored customer preference result is invalid')
      }
      return value as Value
    },
  }
}

function deterministicPublicId(kind:string,storeId:string,idempotencyKey:string):string {
  return `${kind}-${createHash('sha256').update(`${kind}:${storeId}:${idempotencyKey}`).digest('hex').slice(0,24)}`
}

function fingerprint(value:unknown):string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if(typeof value==='object'&&value!==null){
    const source=value as Record<string,unknown>
    return `{${Object.keys(source).toSorted().map((key)=>`${JSON.stringify(key)}:${stableJson(source[key])}`).join(',')}}`
  }
  return JSON.stringify(value)??'null'
}
