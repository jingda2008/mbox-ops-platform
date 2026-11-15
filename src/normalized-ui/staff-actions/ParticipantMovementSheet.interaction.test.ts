import {useEffect,useMemo,useRef,useState} from 'react'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {ParticipantMovementSheet} from './ParticipantMovementSheet'
import {ParticipantMovementHistoryPanel} from './ParticipantMovementHistoryPanel'

vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:vi.fn(),useRef:vi.fn(),useMemo:vi.fn(),useEffect:vi.fn()}))
const nodes=(n:any):any[]=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)]
const label=(n:any):string=>typeof n==='string'?n:Array.isArray(n)?n.map(label).join(''):n?.props?label(n.props.children):''
const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return{promise,resolve}}
describe('participant movement async interaction',()=>{
 let states:any[],refs:any[],si:number,ri:number,effects:(()=>void|(()=>void))[]
 let props:any
 const preview={movementGuard:{movementRevision:'0',sourceTableId:'source-table',sourceLocationVersion:1,sourceGuestCount:2,targetGuestCount:0,targetCapacity:8},movementKind:'participant_split',movedGuestCount:1,selectedParticipantCount:1,targetTableId:'target',targetTableSessionId:null,blockers:[],roleAdjustments:[]}
 const participant={publicId:'person',identityLevel:'identified',role:'companion',confirmationState:'confirmed'}
 function render(){si=0;ri=0;effects=[];return ParticipantMovementSheet(props)}
 function button(tree:any,text:string){const b=nodes(tree).find(n=>n.type==='button'&&label(n).includes(text));expect(b, text).toBeTruthy();return b}
 function edit(){render();states[0]=[participant];states[1]=['person'];states[3]='target';states[9]='edit';return render()}
 beforeEach(()=>{
  vi.clearAllMocks();states=[];refs=[]
  vi.mocked(useState).mockImplementation(initial=>{const i=si++;if(!(i in states))states[i]=initial;return[states[i],(v:any)=>{states[i]=typeof v==='function'?v(states[i]):v}] as never})
  vi.mocked(useRef).mockImplementation(initial=>{const i=ri++;return(refs[i]??(refs[i]={current:initial})) as never})
  vi.mocked(useMemo).mockImplementation(factory=>factory())
  vi.mocked(useEffect).mockImplementation(effect=>{effects.push(effect)})
  props={api:{loadTableParticipants:vi.fn(),previewParticipantMovement:vi.fn(),moveParticipants:vi.fn()},table:{id:'source-table',code:'A1',activeSession:{id:'source',guestCount:2,locationVersion:1}},allTables:[{id:'target',code:'A2',status:'available',activeSession:null,capacity:8}],onClose:vi.fn(),onDone:vi.fn()}
 })
 it('single-flights rapid preview and execution clicks',async()=>{
  const p=deferred(),m=deferred();props.api.previewParticipantMovement.mockReturnValue(p.promise);props.api.moveParticipants.mockReturnValue(m.promise)
  const next=button(edit(),'下一步');next.props.onClick();next.props.onClick()
  expect(props.api.previewParticipantMovement).toHaveBeenCalledOnce()
  p.resolve(preview);await vi.waitFor(()=>expect(states[9]).toBe('preview'))
  const confirm=button(render(),'确认执行');confirm.props.onClick();confirm.props.onClick()
  expect(props.api.moveParticipants).toHaveBeenCalledOnce()
  expect(props.api.moveParticipants.mock.calls[0][0].movementGuard).toEqual(preview.movementGuard)
  const saving=render();expect(button(saving,'人员并桌').props.disabled).toBe(true)
  expect(nodes(saving).find(n=>n.props?.['aria-label']==='关闭').props.disabled).toBe(true)
  m.resolve();await vi.waitFor(()=>expect(props.onDone).toHaveBeenCalledOnce())
 })
 it('discards a preview after the same session moves to another physical table',async()=>{
  const p=deferred();props.api.previewParticipantMovement.mockReturnValue(p.promise)
  button(edit(),'下一步').props.onClick()
  props={...props,table:{...props.table,id:'moved-table',activeSession:{...props.table.activeSession,locationVersion:2}}};render()
  p.resolve(preview);await new Promise(resolve=>setImmediate(resolve))
  expect(states[7]).toBeNull();expect(states[9]).not.toBe('preview')
 })
 it('ignores an aborted participant list even if the transport resolves it',async()=>{
  const p=deferred();props.api.loadTableParticipants.mockReturnValue(p.promise)
  render();const cleanups=effects.map(effect=>effect());cleanups.forEach(cleanup=>cleanup?.())
  p.resolve([participant]);await new Promise(resolve=>setImmediate(resolve))
  expect(states[0]).toEqual([])
 })
 it('exits preview loading when the target changes while its response is in flight',async()=>{
  const p=deferred();props.api.previewParticipantMovement.mockReturnValue(p.promise)
  button(edit(),'下一步').props.onClick()
  props={...props,allTables:[{...props.allTables[0],capacity:4}]};render()
  p.resolve(preview);await vi.waitFor(()=>expect(states[9]).toBe('edit'))
  expect(states[7]).toBeNull();expect(states[10]).toContain('重新预检')
 })
 it('does not report an old operation as successful on a newly selected table',async()=>{
  const m=deferred();props.api.previewParticipantMovement.mockResolvedValue(preview);props.api.moveParticipants.mockReturnValue(m.promise)
  button(edit(),'下一步').props.onClick();await vi.waitFor(()=>expect(states[9]).toBe('preview'))
  button(render(),'确认执行').props.onClick()
  props={...props,table:{...props.table,activeSession:{...props.table.activeSession,id:'different'}}};render()
  m.resolve();await new Promise(resolve=>setImmediate(resolve));expect(props.onDone).not.toHaveBeenCalled()
 })
 it('invalidates a confirmed preview when another employee changes the target occupancy',async()=>{
  props.api.previewParticipantMovement.mockResolvedValue(preview)
  button(edit(),'下一步').props.onClick();await vi.waitFor(()=>expect(states[9]).toBe('preview'))
  const oldConfirm=button(render(),'确认执行')
  props={...props,allTables:[{...props.allTables[0],status:'occupied',activeSession:{id:'other-party',status:'open',guestCount:2}}]};render()
  oldConfirm.props.onClick();await new Promise(resolve=>setImmediate(resolve))
  expect(props.api.moveParticipants).not.toHaveBeenCalled()
 })
 it('does not execute a preview without the server location guard',async()=>{
  props.api.previewParticipantMovement.mockResolvedValue({...preview,movementGuard:undefined})
  button(edit(),'下一步').props.onClick();await vi.waitFor(()=>expect(states[9]).toBe('edit'))
  expect(states[7]).toBeNull();expect(states[10]).toContain('缺少桌位信息');expect(props.api.moveParticipants).not.toHaveBeenCalled()
 })
 it('shows explicit original-result recovery after network loss instead of another confirm action',async()=>{
  const summary={canRecover:true,message:'原拆并桌结果待核对'}
  props.api.pendingParticipantMovement=vi.fn(()=>null)
  props.api.previewParticipantMovement.mockResolvedValue(preview)
  props.api.moveParticipants.mockImplementation(async()=>{props.api.pendingParticipantMovement.mockReturnValue(summary);throw new Error('网络中断')})
  button(edit(),'下一步').props.onClick();await vi.waitFor(()=>expect(states[9]).toBe('preview'))
  button(render(),'确认执行').props.onClick();await vi.waitFor(()=>expect(states[11]).toEqual(summary))
  const recoveryTree=render();expect(nodes(recoveryTree).filter(n=>n.type==='button'&&label(n).includes('确认执行'))).toHaveLength(0)
  const p=deferred();props.api.recoverParticipantMovement=vi.fn(()=>p.promise)
  const retry=button(recoveryTree,'核对原拆并桌结果');retry.props.onClick();retry.props.onClick();expect(props.api.recoverParticipantMovement).toHaveBeenCalledOnce()
  props.api.pendingParticipantMovement.mockReturnValue(null);p.resolve();await vi.waitFor(()=>expect(props.onDone).toHaveBeenCalledOnce())
  expect(props.api.moveParticipants).toHaveBeenCalledOnce();expect(states[11]).toBeNull()
 })
 it('keeps an absent receipt blocked and makes withdrawal a separate single-flight action',async()=>{
  const summary={canRecover:true,canSeal:true,message:'原请求待核对'}
  props.api.pendingParticipantMovement=vi.fn(()=>summary)
  props.api.recoverParticipantMovement=vi.fn().mockRejectedValue(new Error('暂未找到原拆并桌回执'))
  props.api.sealParticipantMovement=vi.fn()
  render();states[11]=summary
  button(render(),'核对原拆并桌结果').props.onClick()
  await vi.waitFor(()=>expect(states[10]).toContain('暂未找到'))
  expect(states[11]).toEqual(summary);expect(props.api.sealParticipantMovement).not.toHaveBeenCalled()
  expect(nodes(render()).some(n=>n.type==='button'&&label(n).includes('确认执行'))).toBe(false)
  const p=deferred();props.api.sealParticipantMovement.mockReturnValue(p.promise)
  const seal=button(render(),'撤回未确认的原请求');seal.props.onClick();seal.props.onClick()
  expect(props.api.sealParticipantMovement).toHaveBeenCalledOnce()
  expect(button(render(),'核对原拆并桌结果').props.disabled).toBe(true)
  props.api.pendingParticipantMovement.mockReturnValue(null);p.resolve()
  await vi.waitFor(()=>expect(states[11]).toBeNull());expect(props.api.moveParticipants).not.toHaveBeenCalled()
 })
 it.each(['unknown','sealed','denied'])('shows the actual withdrawal outcome without clearing it through reload: %s',async outcome=>{
  const summary={canRecover:true,canSeal:true,message:'撤回结果待核对，不代表撤回成功'}
  props.api.pendingParticipantMovement=vi.fn(()=>summary)
  props.api.sealParticipantMovement=vi.fn(async()=>{
    if(outcome==='sealed')props.api.pendingParticipantMovement.mockReturnValue(null)
    throw Object.assign(new Error(outcome==='unknown'?'网络中断，撤回待核对':outcome==='denied'?'当前无权核对':'已封存'),{code:outcome==='sealed'?'TABLE_MOVEMENT_REQUEST_SEALED':outcome==='denied'?'TABLE_PERMISSION_DENIED':'NETWORK_ERROR',...(outcome==='sealed'?{commitDisposition:'not_committed'}:{})})
  })
  render();states[11]=summary;const reload=states[8]
  button(render(),'撤回未确认的原请求').props.onClick()
  await vi.waitFor(()=>expect(states[9]).toBe('edit'))
  if(outcome==='sealed')expect(props.onDone).toHaveBeenCalledWith(expect.stringContaining('原请求已撤回'))
  else{
    expect(props.onDone).not.toHaveBeenCalled();expect(states[8]).toBe(reload)
    expect(label(render())).toContain(outcome==='unknown'?'网络中断':'当前无权核对')
    expect(states[11]).toEqual(summary)
  }
  expect(props.api.moveParticipants).not.toHaveBeenCalled()
 })
 it('does not show the previous account withdrawal result after the API identity changes',async()=>{
  const summary={canRecover:true,canSeal:true,message:'原请求待核对'}
  let finish!:(reason:unknown)=>void
  props.api.pendingParticipantMovement=vi.fn(()=>summary)
  props.api.sealParticipantMovement=vi.fn(()=>new Promise((_resolve,reject)=>{finish=reject}))
  render();states[11]=summary;button(render(),'撤回未确认的原请求').props.onClick()
  props={...props,api:{...props.api,pendingParticipantMovement:vi.fn(()=>({canRecover:false,message:'其他员工'}))}};render()
  finish(Object.assign(new Error('已撤回'),{code:'TABLE_MOVEMENT_REQUEST_SEALED',commitDisposition:'not_committed'}))
  await new Promise(resolve=>setImmediate(resolve));expect(props.onDone).not.toHaveBeenCalled()
 })
 it('restores the pending operation after reopening another table without re-previewing or submitting',async()=>{
  const summary={canRecover:true,message:'原请求待核对'}
  props.api.pendingParticipantMovement=vi.fn(()=>summary);props.api.loadTableParticipants.mockResolvedValue([])
  props.table.activeSession.id='another-table';render();effects.forEach(effect=>effect())
  await new Promise(resolve=>setImmediate(resolve))
  expect(states[11]).toEqual(summary);expect(button(render(),'核对原拆并桌结果').props.disabled).toBe(false)
  expect(props.api.previewParticipantMovement).not.toHaveBeenCalled();expect(props.api.moveParticipants).not.toHaveBeenCalled()
 })
 it('requires server history and explicit new-intent confirmation after earlier movement',async()=>{
  props.api.previewParticipantMovement.mockResolvedValue({...preview,movementGuard:{...preview.movementGuard,movementRevision:'2'}})
  button(edit(),'下一步').props.onClick();await vi.waitFor(()=>expect(states[9]).toBe('preview'))
  let tree=render();expect(button(tree,'确认执行').props.disabled).toBe(true);button(tree,'确认执行').props.onClick()
  expect(props.api.moveParticipants).not.toHaveBeenCalled()
  nodes(tree).find(n=>n.type===ParticipantMovementHistoryPanel).props.onVerified()
  tree=render();expect(button(tree,'确认执行').props.disabled).toBe(true)
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}})
  tree=render();expect(button(tree,'确认执行').props.disabled).toBe(false)
  const staleConfirm=button(tree,'确认执行')
  nodes(tree).find(n=>n.type===ParticipantMovementHistoryPanel).props.onInvalidated()
  staleConfirm.props.onClick();expect(props.api.moveParticipants).not.toHaveBeenCalled()
  tree=render();expect(button(tree,'确认执行').props.disabled).toBe(true)
  nodes(tree).find(n=>n.type===ParticipantMovementHistoryPanel).props.onVerified();tree=render()
  nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}})
  button(render(),'确认执行').props.onClick()
  await vi.waitFor(()=>expect(props.api.moveParticipants).toHaveBeenCalledOnce())
  expect(props.api.moveParticipants.mock.calls[0][0]).toMatchObject({movementHistoryConfirmed:true,movementGuard:{movementRevision:'2'}})
 })
})
