import {randomUUID} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {parseKitchenCommand} from './kitchen-production-api.js'

describe('production command intent parsing',()=>{
  it('keeps legacy kitchen release payloads byte-compatible without inventing a default field',()=>{
    const body={action:'release',batchId:randomUUID()}
    expect(JSON.stringify(parseKitchenCommand(body))).toBe(JSON.stringify(body))
    expect(parseKitchenCommand({...body,expectedOwnershipVersion:2})).toEqual({...body,expectedOwnershipVersion:2})
  })
  it('requires an explicit physical check and complete unique expected ownership and task vectors',()=>{
    const batchId=randomUUID(),body={action:'handoff',batchId,expectedBatches:[{batchId,expectedCurrentOwnerId:randomUUID(),expectedOwnershipVersion:1}],expectedTasks:[{taskId:randomUUID(),expectedEmployeeId:null}],physicalChecked:true,reason:'实际接班'}
    expect(parseKitchenCommand(body)).toEqual(body)
    expect(()=>parseKitchenCommand({...body,physicalChecked:false})).toThrow()
    expect(()=>parseKitchenCommand({...body,expectedBatches:[...body.expectedBatches,...body.expectedBatches]})).toThrow()
    expect(()=>parseKitchenCommand({...body,expectedTasks:[]})).toThrow()
    expect(()=>parseKitchenCommand({...body,expectedTasks:[...body.expectedTasks,...body.expectedTasks]})).toThrow()
    expect(()=>parseKitchenCommand({...body,reason:''})).toThrow()
    expect(()=>parseKitchenCommand({...body,expectedBatches:[{...body.expectedBatches[0],expectedOwnershipVersion:Number.MAX_SAFE_INTEGER}]})).toThrow()
  })
})
