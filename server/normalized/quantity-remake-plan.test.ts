import {describe,it,expect} from 'vitest'
import {planQuantityRemake,type RemakeUnitFact} from './quantity-remake-plan.js'
const unit=(index:number,change:Partial<RemakeUnitFact>={}):RemakeUnitFact=>({id:`unit-${index}`,index,productionState:'ready',held:false,stopped:false,hasActiveRemake:false,hasActiveRedelivery:false,inventoryEvidence:'allocated',materials:[{id:`stock-${index}`,inventoryItemId:'spirit',quantity:'45.000001',status:'consumed',consumptionMovementId:`movement-${index}`}],...change})
const plan=(units:RemakeUnitFact[],quantity=1,originalGoodsLost=true)=>planQuantityRemake({units,quantity,originalGoodsLost})
describe('new quantity production batch factual plan',()=>{
  it('uses exact historical per-unit material quantities and preserves original facts and financial amounts',()=>{
    const units=[unit(2),unit(1)],snapshot=JSON.stringify(units),result=plan(units,2)
    expect(result).toMatchObject({unitIds:['unit-1','unit-2'],quantity:2,originalLossStockIds:['stock-1','stock-2'],financialAction:'none',inventoryAction:'reserve_new_batch'})
    expect(result.materials.map(row=>row.quantity)).toEqual(['45.000001','45.000001'])
    expect(JSON.stringify(units)).toBe(snapshot)
  })
  it('keeps already recorded old loss and reserves another batch without charging the old consumption twice',()=>{
    const original=unit(1);original.materials=[{...original.materials[0]!,status:'used_loss'}]
    expect(plan([original])).toMatchObject({originalLossStockIds:[],materials:[{sourceStockId:'stock-1',originalConsumptionMovementId:'movement-1'}]})
  })
  it.each([{held:true},{stopped:true},{hasActiveRemake:true},{hasActiveRedelivery:true},{productionState:'unmade' as const}])('does not replace a paused, stopped, active remedy or unmade unit %j',change=>{
    const result=plan([unit(1,change),unit(2)])
    expect(result.unitIds).toEqual(['unit-2'])
    expect(()=>plan([unit(1,change)])).toThrow('当前可重新制作 0 份')
  })
  it.each(['started','ready','delivered'] as const)('records a separate batch for original %s history',productionState=>expect(plan([unit(1,{productionState})]).unitIds).toEqual(['unit-1']))
  it('does not infer loss when original goods may still be available',()=>expect(()=>plan([unit(1)],1,false)).toThrow('原实物仍在'))
  it('accepts explicitly untracked goods without inventing materials',()=>expect(plan([unit(1,{inventoryEvidence:'untracked',materials:[]})]).materials).toEqual([]))
  it.each(['reserved','released','returned'] as const)('rejects %s material as consumed source evidence',status=>{
    const original=unit(1);original.materials=[{...original.materials[0]!,status}]
    expect(()=>plan([original])).toThrow('不能再次认定损耗')
  })
  it.each(['0','0.000000','-1','1.0000001','NaN','1e2','1.2.3'])('does not round or invent source quantity %s',quantity=>{
    const original=unit(1);original.materials=[{...original.materials[0]!,quantity}];expect(()=>plan([original])).toThrow('数量无效')
  })
  it.each([0,-1,1.5,NaN,1000])('rejects invalid requested quantity %s',quantity=>expect(()=>plan([unit(1)],quantity)).toThrow('实际重新制作'))
  it('rejects duplicate units or stock facts rather than counting them twice',()=>{
    expect(()=>plan([unit(1),unit(1)])).toThrow('标识不完整')
    const second=unit(2);second.materials=unit(1).materials
    expect(()=>plan([unit(1),second],2)).toThrow('重复归入')
  })
  it('rejects incomplete or contradictory inventory evidence',()=>{
    expect(()=>plan([unit(1,{inventoryEvidence:'unresolved'})])).toThrow('不能猜测')
    expect(()=>plan([unit(1,{materials:[]})])).toThrow('不能猜测')
    expect(()=>plan([unit(1,{inventoryEvidence:'untracked'})])).toThrow('不能猜测')
    const original=unit(1);original.materials=[{...original.materials[0]!,consumptionMovementId:null}]
    expect(()=>plan([original])).toThrow('实际消耗')
  })
})
