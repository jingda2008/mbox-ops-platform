import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { itemAfterSalesApiPlugin } from './item-after-sales-api.js'
import { InventoryReturnCostProjectionBusyError } from './inventory-return-cost-projection.js'
import type { NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

describe('item after-sales retryable inventory cost projection',()=>{
 it.each(['web-return-key','native-physical-return-key'])('preserves retryable error for %s',async key=>{
  const app=Fastify()
  try{
   const execute=vi.fn().mockRejectedValueOnce(new InventoryReturnCostProjectionBusyError())
   await app.register(itemAfterSalesApiPlugin,{
    transactions:{} as ScopedPostgresTransactionRunner,commands:{execute} as unknown as NormalizedCommandExecutor,
    resolveContext:()=>({scope:{tenantId:randomUUID(),storeId:randomUUID()},employeeId:randomUUID(),businessDate:'2026-10-05',capabilities:[]}),
   })
   const response=await app.inject({method:'POST',url:`/commerce/item-after-sales/${randomUUID()}/physical`,headers:{'idempotency-key':key},payload:{unitIds:[randomUUID()],disposition:'returned_unopened',unopenedReceived:true,reason:'实际商品未开封收回'}})
   expect(response.statusCode).toBe(503)
   expect(response.json()).toMatchObject({error:{code:'INVENTORY_RETURN_COST_RETRY',retryable:true}})
   expect(execute).toHaveBeenCalledTimes(1)
  }finally{await app.close()}
 })
})
