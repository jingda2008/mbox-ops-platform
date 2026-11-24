import {describe,expect,it} from 'vitest'
import {ScopedTicketHoldRepository} from './scoped-ticket-hold-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0')
const scope={tenantId:id(1),storeId:id(2)}

function fixture(rows:{ordinal:number;reservationLockId:string}[]=[]){
  const calls:{sql:string;values:readonly unknown[]}[]=[]
  const query=(async(sql:string,values:readonly unknown[]=[])=>{
    calls.push({sql,values})
    return {rows:sql.includes('SELECT ordinal')?rows:[],rowCount:0}
  }) as ScopedTransaction['query']
  return {repo:new ScopedTicketHoldRepository({scope,query}),calls}
}

describe('scoped ticket hold identity foundation',()=>{
  it('gets shared store advisory lock before binding with exact scope and ordinal',async()=>{
    const {repo,calls}=fixture()
    await repo.bind(id(3),2,id(4))
    expect(calls).toHaveLength(3)
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock')
    expect(calls[1]?.sql).toContain('ORDER BY ordinal')
    expect(calls[1]?.values).toEqual([...Object.values(scope),id(3)])
    expect(calls[2]?.sql).toContain('INSERT INTO mbox.scoped_ticket_hold_identity')
    expect(calls[2]?.values).toEqual([...Object.values(scope),id(3),2,id(4)])
  })
  it('leaves exact retry alone and never overwrites another lock',async()=>{
    const {repo,calls}=fixture([{ordinal:2,reservationLockId:id(4)}])
    await repo.bind(id(3),2,id(4))
    await expect(repo.bind(id(3),2,id(5))).rejects.toThrow('already owns')
    expect(calls.every(c=>!c.sql.includes('INSERT'))).toBe(true)
  })
  it('rejects malformed identity before touching PostgreSQL',async()=>{
    const {repo,calls}=fixture()
    await expect(repo.bind(id(3),0,id(4))).rejects.toThrow(TypeError)
    await expect(repo.bind(id(3),2,'A1')).rejects.toThrow(TypeError)
    await expect(repo.list('unknown')).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })
})
