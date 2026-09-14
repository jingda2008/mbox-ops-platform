import {describe,it,expect} from 'vitest'
import {packagedReturnEligibility} from './packaged-return-evidence.js'
const bottle={unit_id:'unit',quantity:'500.000000',base_unit:'ml',item_type:'bottle',package_volume_ml:'500.000000',trusted:true,sales_spec:'whole_bottle'}
describe('packaged return evidence',()=>{
  it('uses exact original whole-package quantities',()=>{
    expect(packagedReturnEligibility([bottle]).canReturn).toBe(true)
    expect(packagedReturnEligibility([{...bottle,quantity:'1000.000000'}]).canReturn).toBe(true)
    expect(packagedReturnEligibility([{...bottle,quantity:'499.999999'}]).canReturn).toBe(false)
    expect(packagedReturnEligibility([{...bottle,quantity:'0'}]).canReturn).toBe(false)
    expect(packagedReturnEligibility([{...bottle,quantity:'1e3'}]).canReturn).toBe(false)
  })
  it('explains 500 versus 330 as a stock conflict, not a recipe classification',()=>{
    expect(packagedReturnEligibility([{...bottle,package_volume_ml:'330'}])).toMatchObject({canReturn:false,reason:expect.stringMatching(/500.*330.*库存负责人/)})
  })
  it('refuses to infer a historical package when configuration provenance is missing',()=>{
    expect(packagedReturnEligibility([{...bottle,trusted:false}])).toMatchObject({canReturn:false,reason:expect.stringContaining('原批次')})
    expect(packagedReturnEligibility([{...bottle,package_volume_ml:null}]).canReturn).toBe(false)
    expect(packagedReturnEligibility([]).canReturn).toBe(false)
  })
  it('does not restore recipe ingredients or split servings as unopened packages',()=>{
    expect(packagedReturnEligibility([bottle,bottle]).canReturn).toBe(false)
    for(const sales_spec of ['glass','cup','shot','pitcher','custom'])expect(packagedReturnEligibility([{...bottle,sales_spec}]).canReturn).toBe(false)
  })
  it('preserves counted whole-package goods and rejects fractional packages',()=>{
    expect(packagedReturnEligibility([{...bottle,base_unit:'piece',item_type:'food',quantity:'1',package_volume_ml:null,sales_spec:null}]).canReturn).toBe(true)
    expect(packagedReturnEligibility([{...bottle,base_unit:'piece',item_type:'food',quantity:'0.5'}]).canReturn).toBe(false)
  })
})
