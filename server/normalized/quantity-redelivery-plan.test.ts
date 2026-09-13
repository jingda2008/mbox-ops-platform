import {describe,expect,it} from 'vitest'
import {planOriginalGoodsRedelivery,type RedeliveryUnitFact} from './quantity-redelivery-plan.js'
const delivered=(id:string,index:number,changes:Partial<RedeliveryUnitFact>={}):RedeliveryUnitFact=>({id,index,productionState:'delivered',held:false,stopped:false,hasActiveRedelivery:false,...changes})
describe('original-goods redelivery selection',()=>{
  it('selects only actual delivered records in stable original order and never requests new stock',()=>{
    const units=[delivered('second',1),delivered('first',0),delivered('third',2)]
    expect(planOriginalGoodsRedelivery({units,quantity:2,originalGoodsAvailable:true})).toEqual({unitIds:['first','second'],quantity:2,inventoryAction:'reuse_original'})
    expect(units.map(unit=>unit.id)).toEqual(['second','first','third'])
  })
  for(const state of ['unmade','started','ready'] as const)it(`does not create a duplicate redelivery for existing ${state} work`,()=>{
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('original',0,{productionState:state})],quantity:1,originalGoodsAvailable:true})).toThrow('原取送任务')
  })
  for(const changes of [{held:true},{stopped:true},{hasActiveRedelivery:true}])it(`does not deliver held, stopped or already-requested goods: ${JSON.stringify(changes)}`,()=>{
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('blocked',0,changes),delivered('available',1)],quantity:2,originalGoodsAvailable:true})).toThrow('可登记原实物补送 1 份')
  })
  it('requires confirmation of actual goods instead of silently making another batch',()=>{
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('original',0)],quantity:1,originalGoodsAvailable:false})).toThrow('重新制作')
  })
  for(const quantity of [0,-1,1.5,NaN,1000])it(`rejects invalid redelivery quantity ${quantity}`,()=>{
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('original',0)],quantity,originalGoodsAvailable:true})).toThrow('实际需要补送')
  })
  it('rejects duplicated original unit identities',()=>{
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('same',0),delivered('same',1)],quantity:1,originalGoodsAvailable:true})).toThrow('记录不一致')
    expect(()=>planOriginalGoodsRedelivery({units:[delivered('first',0),delivered('second',0)],quantity:1,originalGoodsAvailable:true})).toThrow('记录不一致')
  })
})
