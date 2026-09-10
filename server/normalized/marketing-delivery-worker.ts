import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import {MarketingDeliveryRepository,type MarketingChannelEvidence,type MarketingDeliveryReceipt} from './marketing-delivery-repository.js'
import type {MarketingChannel,MarketingPurpose} from './marketing-contact-policy.js'
import {CustomerRepository} from './customer-repository.js'
export interface MarketingDeliveryAdapter{
  /** Resolve actual account capability, verified address and platform-specific
   * authority on the server. Never derive these from a contact preference. */
  verify(input:{scope:Readonly<StoreScope>;customerId:string;channel:MarketingChannel;purpose:MarketingPurpose}):Promise<MarketingChannelEvidence>
  deliver(input:{scope:Readonly<StoreScope>;attemptId:string;customerId:string;channel:MarketingChannel;purpose:MarketingPurpose;content:string;signal:AbortSignal}):Promise<MarketingDeliveryReceipt>
}
export interface MarketingDeliveryBatch{workerId:string;submitted:number;sent:number;blocked:number;cancelled:number;unknown:number;failed:number}
export class MarketingDeliveryWorker{
  constructor(private readonly transactions:ScopedPostgresTransactionRunner,private readonly adapter:MarketingDeliveryAdapter|null=null){}
  async runBatch(scope:Readonly<StoreScope>,workerId:string,batchSize=25):Promise<MarketingDeliveryBatch>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)||!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('Invalid marketing worker batch')
    const result:MarketingDeliveryBatch={workerId,submitted:0,sent:0,blocked:0,cancelled:0,unknown:0,failed:0}
    const deadline=Date.now()+10000
    // A crashed worker may already have contacted a provider. Preserve unknown
    // and its frequency cost rather than releasing it for automatic resend.
    const abandoned=await this.transactions.run(scope,async tx=>(await tx.query<{id:string}>("SELECT id FROM mbox.marketing_delivery_attempts WHERE tenant_id=$1 AND store_id=$2 AND state='dispatching' AND created_at<clock_timestamp()-interval '5 minutes' ORDER BY created_at LIMIT $3",[scope.tenantId,scope.storeId,batchSize])).rows)
    for(const row of abandoned){try{await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).finish(row.id,{state:'unknown'}));result.unknown++}catch{result.failed++}}
    const due=await this.transactions.run(scope,async tx=>(await tx.query<{id:string}>("SELECT id FROM mbox.marketing_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND status IN('queued','blocked') AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT $3",[scope.tenantId,scope.storeId,batchSize])).rows)
    for(const row of due){
      if(Date.now()>=deadline)break
      let attemptId:string|undefined
      try{
        const job=await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).get(row.id),{readOnly:true})
        const customerId=await this.transactions.run(scope,async tx=>(await new CustomerRepository(tx).resolveCanonical(job.customer_id)).id,{readOnly:true})
        const context={scope,customerId,channel:job.channel,purpose:job.purpose}
        const evidence=this.adapter?await timeout(this.adapter.verify(context),2000):null
        const prepared=await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).prepare(row.id,evidence))
        if(!prepared)continue
        if(prepared.status==='blocked'){result.blocked++;continue}
        if(prepared.status==='cancelled'){result.cancelled++;continue}
        if(prepared.status!=='dispatching')continue
        attemptId=prepared.attemptId
        if(!this.adapter||!evidence)throw new Error('Marketing adapter missing after claim')
        const fresh=await timeout(this.adapter.verify({...context,customerId:prepared.customerId}),2000)
        const allowed=await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).beforeDispatch(prepared.attemptId,fresh))
        if(!allowed){result.cancelled++;continue}
        const controller=new AbortController()
        const timer=setTimeout(()=>controller.abort(),5000)
        let receipt:MarketingDeliveryReceipt
        try{receipt=await timeout(this.adapter.deliver({...context,customerId:prepared.customerId,attemptId:prepared.attemptId,content:prepared.content,signal:controller.signal}),5000)}
        catch{receipt={state:'unknown'}}finally{clearTimeout(timer)}
        await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).finish(prepared.attemptId,receipt))
        result[receipt.state]++
      }catch{
        result.failed++
        try{
          if(attemptId)await this.transactions.run(scope,tx=>new MarketingDeliveryRepository(tx).finish(attemptId!,{state:'unknown'}))
          else await this.transactions.run(scope,tx=>tx.query("UPDATE mbox.marketing_delivery_jobs SET status='blocked',blocked_reason='verification_unavailable',checks=checks+1,next_check_at=clock_timestamp()+(LEAST(86400,900*power(2,LEAST(checks,7)))*interval '1 second'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('queued','blocked') AND next_check_at<=clock_timestamp()",[scope.tenantId,scope.storeId,row.id]))
        }catch{/* Health result remains failed; committed attempt cannot resend. */}
      }
    }
    return result
  }
}
async function timeout<T>(promise:Promise<T>,milliseconds:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('marketing_adapter_timeout')),milliseconds)})])}
  finally{if(timer)clearTimeout(timer)}
}
