import {describe,it,expect} from 'vitest'
import {pickupOnlyEntry,productionEntry,threeScreenMode} from './three-screen-route'

describe('screen entry permissions and legacy escape',()=>{
  it('routes pickup-only accounts without granting dashboard or configuration access',()=>{
    expect(pickupOnlyEntry('/staff/fulfillment','',['kds.deliver'])).toBe('pickup')
    expect(pickupOnlyEntry('/staff/fulfillment','',['kds.deliver','dashboard.view'])).toBeNull()
    expect(pickupOnlyEntry('/staff/fulfillment','',[])).toBeNull()
    expect(pickupOnlyEntry('/staff/live','',['kds.deliver'])).toBeNull()
    expect(pickupOnlyEntry('/staff/fulfillment','?screen=kitchen',['kds.deliver'])).toBeNull()
    expect(threeScreenMode('/staff/fulfillment','?screen=kitchen')).toBe('kitchen')
  })
  it('opens each production role only after the feature and station are authorized',()=>{
    const actor={roleCodes:['KITCHEN'],allowedStations:['kitchen'],threeScreenWorkflowEnabled:true}
    expect(productionEntry('',actor)).toBe('kitchen')
    expect(productionEntry('',{...actor,roleCodes:['BARTENDER','DEPUT_MANAGER'],allowedStations:['bar','kitchen']})).toBe('bar')
    expect(productionEntry('',{...actor,threeScreenWorkflowEnabled:false})).toBeNull()
    expect(productionEntry('',{...actor,allowedStations:[]})).toBeNull()
    expect(productionEntry('',{...actor,roleCodes:['BARTENDER','KITCHEN']})).toBeNull()
    expect(productionEntry('?view=all',actor)).toBeNull()
    expect(productionEntry('?factId=old-task',actor)).toBeNull()
  })
})
