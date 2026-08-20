import { createHash } from 'node:crypto'
import type { AuditEvent, JsonCodec, JsonValue, NormalizedCommandExecutor } from './command-executor.js'
import {
  MemberContentCardRepository,
  type MemberContentCardDraft,
  type MemberContentCardView,
} from './member-content-card-repository.js'
import type { ActivityOperationsStaffContext } from './activity-operations-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export class MemberContentCardService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>,
    private readonly commands: NormalizedCommandExecutor,
  ) {}

  list(context: ActivityOperationsStaffContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new MemberContentCardRepository(transaction).list()
    ), { readOnly:true })
  }

  create(context: ActivityOperationsStaffContext, input: Readonly<{
    draft:MemberContentCardDraft;reason:string;idempotencyKey:string
  }>) {
    return this.commands.execute({
      scope:context.scope,operationScope:'home.content.create',idempotencyKey:input.idempotencyKey,
      requestFingerprint:fingerprint(input),resultCodec:codec(),
    }, async (transaction) => {
      const result=await new MemberContentCardRepository(transaction).create(input.draft)
      return outcome(context,result,'home.content.draft_created',input.reason)
    })
  }

  update(context: ActivityOperationsStaffContext, input: Readonly<{
    code:string;draft:MemberContentCardDraft;reason:string;idempotencyKey:string
  }>) {
    return this.commands.execute({
      scope:context.scope,operationScope:'home.content.update',idempotencyKey:input.idempotencyKey,
      requestFingerprint:fingerprint(input),resultCodec:codec(),
    }, async (transaction) => {
      const result=await new MemberContentCardRepository(transaction).update(input.code,input.draft)
      return outcome(context,result,'home.content.draft_updated',input.reason)
    })
  }

  publish(context: ActivityOperationsStaffContext, input: Readonly<{
    code:string;reason:string;idempotencyKey:string
  }>) {
    return this.commands.execute({
      scope:context.scope,operationScope:'home.content.publish',idempotencyKey:input.idempotencyKey,
      requestFingerprint:fingerprint(input),resultCodec:codec(),
    }, async (transaction) => {
      const result=await new MemberContentCardRepository(transaction).publish(input.code,context.employeeId)
      return outcome(context,result,'home.content.published',input.reason)
    })
  }

  pause(context: ActivityOperationsStaffContext, input: Readonly<{
    code:string;reason:string;idempotencyKey:string
  }>) {
    return this.commands.execute({
      scope:context.scope,operationScope:'home.content.pause',idempotencyKey:input.idempotencyKey,
      requestFingerprint:fingerprint(input),resultCodec:codec(),
    }, async (transaction) => {
      const result=await new MemberContentCardRepository(transaction).pause(input.code)
      return outcome(context,result,'home.content.paused',input.reason)
    })
  }
}

function outcome(context:ActivityOperationsStaffContext,result:MemberContentCardView,action:string,reason:string){
  const audit:AuditEvent={
    actor:{type:'employee',employeeId:context.employeeId},businessDate:context.businessDate,
    action,objectType:'member_content_card',objectId:result.code,reason,
    afterData:{status:result.status,type:result.type,title:result.title,validFrom:result.validFrom,validUntil:result.validUntil},
  }
  return {result,auditEvents:[audit],outboxMessages:[]}
}

function fingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
function codec():JsonCodec<MemberContentCardView>{return{
  encode:(value)=>value as unknown as JsonValue,
  decode:(value)=>{
    if(typeof value!=='object'||value===null||Array.isArray(value))throw new TypeError('home content replay payload is invalid')
    return value as MemberContentCardView
  },
}}
