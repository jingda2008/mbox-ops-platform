import {describe,it,expect,vi} from 'vitest'
import {DurableStaffCommand} from './durable-staff-command'
function storage(){const map=new Map<string,string>();return{getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}}}
describe('durable staff command recovery',()=>{
  it('recovers after closing the tab with fresh session storage and module memory',async()=>{
    const persisted=storage(),namespace=crypto.randomUUID(),keys:string[]=[],ledger=new Set<string>()
    vi.stubGlobal('localStorage',persisted);vi.stubGlobal('sessionStorage',storage())
    try{
      const first=new DurableStaffCommand(namespace,async(_body:{quantity:number},key:string)=>{keys.push(key);ledger.add(key);throw new Error('reply lost')})
      await expect(first.submit({quantity:2})).rejects.toThrow('reply lost')
      vi.stubGlobal('sessionStorage',storage());vi.resetModules()
      const {DurableStaffCommand:ReopenedCommand}=await import('./durable-staff-command')
      const reopened=new ReopenedCommand(namespace,async(_body:{quantity:number},key:string)=>{keys.push(key);ledger.add(key);return {ok:true}})
      expect(reopened.pending()?.body).toEqual({quantity:2})
      await reopened.recover();expect(keys[1]).toBe(keys[0]);expect(ledger.size).toBe(1)
    }finally{vi.unstubAllGlobals()}
  })
  it('freezes the employee intent across a lost reply and reload; one ledger write and a fresh key only after readback',async()=>{
    const saved=storage(),ledger=new Map<string,{id:string}>(),keys:string[]=[],namespace=crypto.randomUUID()
    let lose=true
    const send=vi.fn(async(body:{quantity:number},key:string)=>{keys.push(key);if(!ledger.has(key))ledger.set(key,{id:String(body.quantity)});if(lose){lose=false;throw new Error('reply lost')}return ledger.get(key)!})
    const first=new DurableStaffCommand(namespace,send,saved)
    await expect(first.submit({quantity:2})).rejects.toThrow('reply lost')
    const restored=new DurableStaffCommand(namespace,send,saved)
    await expect(restored.submit({quantity:3})).rejects.toThrow('原操作')
    expect(await restored.recover()).toEqual({id:'2'});expect(ledger.size).toBe(1);expect(keys[0]).toBe(keys[1])
    await expect(restored.refresh(async()=>{throw new Error('read failed')})).rejects.toThrow('read failed')
    expect(await restored.recover()).toEqual({id:'2'});expect(send).toHaveBeenCalledTimes(2)
    await restored.refresh(async()=>{});expect(restored.pending()).toBeNull()
    await restored.submit({quantity:2});expect(ledger.size).toBe(2);expect(keys[2]).not.toBe(keys[1])
  })
  it('keeps employees separate and prevents overlapping clicks from sending twice',async()=>{
    const saved=storage(),namespace=crypto.randomUUID();let finish!:(result:{ok:boolean})=>void
    const send=vi.fn(()=>new Promise<{ok:boolean}>(resolve=>{finish=resolve}))
    const a=new DurableStaffCommand(`${namespace}:employee-a`,send,saved),same=new DurableStaffCommand(`${namespace}:employee-a`,send,saved),b=new DurableStaffCommand(`${namespace}:employee-b`,send,saved)
    const one=a.submit({reason:'破损'}),two=same.submit({reason:'破损'});expect(send).toHaveBeenCalledTimes(1);expect(b.pending()).toBeNull()
    finish({ok:true});await Promise.all([one,two]);expect(a.pending()?.result).toEqual({ok:true})
  })
  it.each([[403,'INVENTORY_PERMISSION_DENIED',false],[409,'INVENTORY_INSUFFICIENT',false],[409,'IDEMPOTENCY_IN_PROGRESS',true],[500,'INVENTORY_INTERNAL_ERROR',true]])('handles refusal %s/%s without confusing it with an unknown result',async(status,code,retained)=>{
    const command=new DurableStaffCommand(crypto.randomUUID(),async()=>{throw Object.assign(new Error(code),{status,code})},storage())
    await expect(command.submit({quantity:1})).rejects.toThrow(code);expect(command.pending()!==null).toBe(retained)
  })
})

it('requires persistent storage before issuing a kitchen command and keeps the original key when saving its reply fails',async()=>{
  const saved=storage(),send=vi.fn(async()=>({ok:true}))
  const blocked=new DurableStaffCommand(crypto.randomUUID(),send,{...saved,setItem:()=>{throw new Error('quota')}},true)
  await expect(blocked.submit({quantity:1})).rejects.toThrow('quota');expect(send).not.toHaveBeenCalled();expect(blocked.pending()).toBeNull()
  let writes=0;const keys:string[]=[]
  const command=new DurableStaffCommand(crypto.randomUUID(),async(_body:{quantity:number},key:string)=>{keys.push(key);return {ok:true}},
    {...saved,setItem:(key,value)=>{if(++writes===2)throw new Error('quota');saved.setItem(key,value)}},true)
  await expect(command.submit({quantity:2})).rejects.toThrow('quota')
  expect(command.pending()?.body).toEqual({quantity:2});await command.recover();expect(keys[0]).toBe(keys[1])
})
