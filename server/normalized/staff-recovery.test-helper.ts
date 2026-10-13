import {expect} from 'vitest'
import {executeRecoverableCommand} from '../../src/normalized-ui/recoverable-command.js'
import {DurableStaffCommand} from '../../src/normalized-ui/durable-staff-command.js'

/** Real database send; transport loss and temporary authentication refusals are injected. */
export async function recoverCommittedStaffCommand<R>(send:(key:string)=>Promise<R>,durable=false){
  const namespace=crypto.randomUUID(),keys:string[]=[]
  let phase=0,first!:R
  const transport=async(key:string)=>{
    keys.push(key)
    if(phase===1||phase===2)throw Object.assign(new Error('authentication unavailable'),{status:phase===1?401:403})
    const result=await send(key)
    if(phase===0){first=result;throw new Error('committed response lost')}
    return result
  }
  const saved=new Map<string,string>()
  const storage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>{saved.set(k,v)},removeItem:(k:string)=>{saved.delete(k)}}
  const execute=()=>durable
    ?new DurableStaffCommand(namespace,async(_body:unknown,key:string)=>transport(key),storage,true).submit({operation:namespace})
    :executeRecoverableCommand(namespace,{operation:namespace},crypto.randomUUID(),transport)
  await expect(execute()).rejects.toThrow('committed response lost')
  for(phase=1;phase<=2;phase++)await expect(execute()).rejects.toThrow('authentication unavailable')
  const recovered=await execute()
  expect(new Set(keys).size).toBe(1)
  return {first,recovered}
}
