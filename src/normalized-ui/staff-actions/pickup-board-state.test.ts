import {describe,expect,it} from 'vitest'
import {adjustPickupAmount,pickupDraft,pickupDraftCount,pickupDraftCurrent,pickupDraftOverLimit,pickupLines,pickupLocation,pickupNeedsReview,pickupSelectionCurrent,pickupTables,pickupTakeCommand,pickupUndoCommand,pickupWaitLabel} from './pickup-board-state'
import {pickupFixtureBoard as board,pickupFixtureId as id,pickupFixtureReceipt as receipt,pickupFixtureUnit as unit} from './pickup-test-fixtures'

describe('shared pickup physical selection',()=>{
  it('keeps bar and adjacent kitchen pickup locations separate',()=>{
    const lines=pickupLines([unit(),unit(2,{station:'kitchen',pickupLocation:'后厨取餐口'})])
    expect(lines.map(line=>line.location)).toEqual(['酒水吧台','后厨取餐口'])
    expect(pickupLocation(unit(3,{station:'kitchen',pickupLocation:'kitchen'}))).toBe('后厨取餐口')
  })
  it('does not group different notes or specifications',()=>{
    expect(pickupLines([unit(),unit(2,{itemNote:'不加薄荷'}),unit(3,{specification:'无酒精'}),unit(4,{orderNote:'坚果过敏'})])).toHaveLength(4)
  })
  it('selects only frozen original units when the same table receives another wave',()=>{
    const initial=board([unit(),unit(2)]),draft=pickupDraft(initial.tables[0]!)
    const current=board([unit(),unit(2),unit(3)])
    const body=pickupTakeCommand(draft)!
    expect(body.units.map(row=>row.unitId)).toEqual([id(1),id(2)])
    expect(pickupSelectionCurrent(body,current.tables)).toBe(true)
  })
  it('freezes quantity and notes without mutating its source snapshot',()=>{
    const source=board(),draft=pickupDraft(source.tables[0]!)
    source.tables[0]!.units[0]!.itemNote='后到变更'
    expect(draft.lines[0]!.units[0]!.itemNote).toBe('')
  })
  it('partial collection chooses deterministic oldest physical units and leaves the other units',()=>{
    const draft=pickupDraft(board([unit(2,{readyAt:'2026-09-21T10:00:10Z'}),unit(1),unit(3,{readyAt:'2026-09-21T10:00:20Z'})]).tables[0]!)
    const adjusted=adjustPickupAmount(draft,draft.lines[0]!.key,-1)
    expect(pickupTakeCommand(adjusted)!.units.map(row=>row.unitId)).toEqual([id(1),id(2)])
    expect(draft.amounts[draft.lines[0]!.key]).toBe(3)
  })
  it('big steps clamp to the frozen available quantity',()=>{
    let draft=pickupDraft(board().tables[0]!),key=draft.lines[0]!.key
    draft=adjustPickupAmount(draft,key,1);expect(draft.amounts[key]).toBe(1)
    draft=adjustPickupAmount(adjustPickupAmount(draft,key,-1),key,-1);expect(draft.amounts[key]).toBe(0);expect(pickupTakeCommand(draft)).toBeNull()
  })
  it.each([NaN,1.5,-1,2])('rejects malformed frozen quantity %s',count=>{
    const draft=pickupDraft(board().tables[0]!);draft.amounts[draft.lines[0]!.key]=count;expect(pickupTakeCommand(draft)).toBeNull()
  })
  it('does not silently omit lines beyond the compact card',()=>{
    const units=Array.from({length:7},(_,index)=>unit(index+1,{productName:`餐品${index+1}`}))
    expect(pickupTakeCommand(pickupDraft(board(units).tables[0]!))!.units).toHaveLength(7)
    expect(pickupNeedsReview(pickupLines(units))).toBe(true)
  })
  it.each(['version','locationVersion','tableSessionId'] as const)('invalidates a selection after %s changes',field=>{
    const initial=board(),body=pickupTakeCommand(pickupDraft(initial.tables[0]!))!
    const changed=unit(1,field==='tableSessionId'?{tableSessionId:id(299)}:{[field]:2})
    expect(pickupSelectionCurrent(body,board([changed]).tables)).toBe(false)
  })
  it('rejects a concurrently collected/cancelled unit but permits unrelated table changes',()=>{
    const initial=board([unit(),unit(2)]),body=pickupTakeCommand(pickupDraft(initial.tables[0]!))!
    expect(pickupSelectionCurrent(body,board([unit(2)]).tables)).toBe(false)
    expect(pickupSelectionCurrent(body,board([unit(),unit(2),unit(3,{tableId:id(222),tableCode:'B01',tableSessionId:id(223)})]).tables)).toBe(true)
  })
  it('distinguishes remake physical units from originals with the same id',()=>{
    const original=unit(),remake=unit(1,{kind:'remake'}),draft=pickupDraft(board([original,remake]).tables[0]!)
    expect(pickupTakeCommand(draft)!.units).toHaveLength(2)
  })
  it('drops completed cards and orders a reopened table by its current oldest ready item',()=>{
    const other=unit(3,{tableId:id(222),tableCode:'B01',tableSessionId:id(223),readyAt:'2026-09-21T10:00:20Z'})
    const reopened=unit(4,{readyAt:'2026-09-21T10:00:30Z'})
    const tables=board([reopened,other]).tables
    tables.push({...tables[0]!,tableId:id(230),tableCode:'C01',units:[]})
    expect(pickupTables(tables).map(table=>table.tableCode)).toEqual(['B01','A01'])
  })
  it('uses server-ready timestamps, clamps clock skew, and does not invent unknown waiting duration',()=>{
    expect(pickupWaitLabel([unit()],Date.parse('2026-09-21T10:02:59Z'))).toBe('等候 2分钟')
    expect(pickupWaitLabel([unit()],Date.parse('2026-09-21T09:59:00Z'))).toBe('刚摆好')
    expect(pickupWaitLabel([unit(1,{readyAt:null})],Date.now())).toBe('等候时间待核对')
  })
  it('requires full review for long names or special requirements',()=>{
    expect(pickupNeedsReview(pickupLines([unit()]))).toBe(false)
    expect(pickupNeedsReview(pickupLines([unit(1,{itemNote:'客人坚果过敏，请使用完全清洁的器具'})]))).toBe(true)
    expect(pickupNeedsReview(pickupLines([unit(1,{productName:'超级超级超级超级超级超级超级超级超级长鸡尾酒名称'})]))).toBe(true)
  })
  it('shows all physical items but requires explicit partial selection above the 50-task bound',()=>{
    const source=board(Array.from({length:51},(_,i)=>unit(i+1,{taskId:id(500+i)})))
    let draft=pickupDraft(source.tables[0]!)
    expect(pickupNeedsReview(draft.lines)).toBe(true);expect(pickupDraftCount(draft)).toBe(51);expect(pickupDraftOverLimit(draft)).toBe(true)
    expect(pickupTakeCommand(draft)).toBeNull();expect(pickupDraftCurrent(draft,source.tables)).toBe(true)
    draft=adjustPickupAmount(draft,draft.lines[0]!.key,-1)
    expect(pickupTakeCommand(draft)!.units).toHaveLength(50);expect(pickupDraftOverLimit(draft)).toBe(false)
  })
  it('limits a large single task by physical unit count rather than silently truncating it',()=>{
    const draft=pickupDraft(board(Array.from({length:1000},(_,i)=>unit(i+1))).tables[0]!)
    expect(pickupDraftCount(draft)).toBe(1000);expect(pickupDraftOverLimit(draft)).toBe(true);expect(pickupTakeCommand(draft)).toBeNull()
    expect(pickupTakeCommand(adjustPickupAmount(draft,draft.lines[0]!.key,-1))!.units).toHaveLength(999)
  })
  it('a zero-selected row does not falsely claim its unselected cancelled units will be taken',()=>{
    const original=board([unit(),unit(2,{productName:'薯条'})]),draft=pickupDraft(original.tables[0]!)
    const adjusted=adjustPickupAmount(draft,draft.lines.find(line=>line.name==='薯条')!.key,-1)
    expect(pickupDraftCurrent(adjusted,board([unit()]).tables)).toBe(true)
  })
  it('undo targets exactly one receipt and requires the original physical condition',()=>{
    const original=receipt([unit(),unit(2)])
    expect(pickupUndoCommand(original)).toEqual({action:'undo',receiptId:original.receiptId,expectedRevision:1,physicalStillAtPickupPoint:true})
    expect(pickupUndoCommand({...original,canUndo:false})).toBeNull()
    expect(pickupUndoCommand({...original,undo:{undoId:id(301),undoneAt:'2026-09-21T10:02:00Z'}})).toBeNull()
  })
})
