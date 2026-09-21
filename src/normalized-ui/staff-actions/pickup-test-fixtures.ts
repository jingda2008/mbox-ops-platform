import type {PickupBoardData,PickupReceipt,PickupUnit} from '../../shared/pickup-workflow'

export const pickupFixtureId=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
export function pickupFixtureUnit(n=1,patch:Partial<PickupUnit>={}):PickupUnit{
  return {kind:'original',unitId:pickupFixtureId(n),originalUnitId:pickupFixtureId(n),taskId:pickupFixtureId(100),itemId:pickupFixtureId(101),orderId:pickupFixtureId(102),
    version:1,tableId:pickupFixtureId(200),tableCode:'A01',tableSessionId:pickupFixtureId(201),locationVersion:1,
    productName:'莫吉托',specification:'',itemNote:'',orderNote:'',station:'bar',pickupLocation:'酒水吧台',readyAt:'2026-09-21T10:00:00.000Z',...patch}
}
export function pickupFixtureReceipt(units:PickupUnit[]=[pickupFixtureUnit()],patch:Partial<PickupReceipt>={}):PickupReceipt{
  return {receiptId:pickupFixtureId(300),revision:1,tableId:units[0]!.tableId,tableCode:units[0]!.tableCode,tableSessionId:units[0]!.tableSessionId,
    takenAt:'2026-09-21T10:01:00.000Z',deliveryConfirmedAt:'2026-09-21T10:01:00.000Z',deliverySource:'pickup',source:{kind:'shared_pickup_device',deviceId:pickupFixtureId(400),label:'吧台取餐屏'},
    pickerEmployeeId:null,units,quantity:units.length,undo:null,canUndo:true,undoBlockedReason:null,...patch}
}
export function pickupFixtureBoard(units:PickupUnit[]=[pickupFixtureUnit()],patch:Partial<PickupBoardData>={}):PickupBoardData{
  const tables=new Map<string,PickupBoardData['tables'][number]>()
  for(const unit of units){const table=tables.get(unit.tableId)??{tableId:unit.tableId,tableCode:unit.tableCode,tableSessionId:unit.tableSessionId,locationVersion:unit.locationVersion,units:[]};table.units.push(unit);tables.set(unit.tableId,table)}
  return {revision:1,generatedAt:'2026-09-21T10:01:00.000Z',commandScope:'scope-A',device:{id:pickupFixtureId(400),label:'吧台取餐屏',mode:'shared_pickup'},recoveryAvailable:patch.device!==null&&patch.actor?.canPickup!==false,
    setup:{enabled:true,configured:true,canConfigure:true},actor:{actionSessionValid:true,canPickup:true,canUndo:true,canConfigure:true},tables:[...tables.values()],history:[],attention:[],...patch}
}
