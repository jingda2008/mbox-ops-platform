import {describe,expect,it,vi} from 'vitest'
import {publishTicketDrafts,saveTicketOffer,type TableTicketOfferInput} from './table-ticket-offer-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

const selected='00000000-0000-4000-8000-000000000001'
const old='00000000-0000-4000-8000-000000000002'
const input:TableTicketOfferInput={areaId:'area',expectedVersion:1,name:'桌票',priceMinor:50000,giftPoints:0,status:'draft',visibleFrom:null,visibleUntil:null}
function fixture({configured=true,prior=null,eligible=[selected]}:{configured?:boolean;prior?:string[]|null;eligible?:string[]}={}) {
  const query=vi.fn(async (sql:string,values?:unknown[])=>{
    if(sql.includes('ORDER BY area.sort_order'))return {rows:[{areaId:'area',version:1,draftAuthor:'writer',status:'draft',name:'桌票',priceMinor:50000,giftPoints:0,draftTableIds:prior}]}
    if(sql.includes('FROM mbox.community_activities'))return {rows:[{id:'show',status:'published',visibility:'public',valid:true}]}
    if(sql.includes('FROM mbox.table_ticket_event_terms'))return {rows:[{id:'rules',version:1,service_contact:'客服',refund_schedule:'开演前按规则退费'}]}
    if(sql.includes('FROM mbox.areas'))return {rows:[{id:'area'}]}
    if(sql.includes('FROM mbox.table_ticket_offers'))return {rows:[{status:'draft',version:1,created_by:'writer',draft_table_ids:prior}]}
    if(sql.includes('AS configured'))return {rows:[{configured}]}
    if(sql.includes('t.id=ANY'))return {rows:((values?.[3]??[]) as string[]).filter(id=>eligible.includes(id)).map(id=>({id}))}
    if(sql.includes('INSERT INTO mbox.table_ticket_offers'))return {rows:[{id:'draft',version:2,status:values?.[8]}]}
    throw new Error('Unexpected query')
  })
  const tx={scope:{tenantId:'tenant',storeId:'store'},query} as unknown as ScopedTransaction
  return {tx,query}
}
describe('confirmed table roster ticket drafts',()=>{
  it('stores only the requested stable IDs in the new draft version',async()=>{
    const {tx,query}=fixture()
    await expect(saveTicketOffer(tx,'show','writer',{...input,draftTableIds:[selected]})).resolves.toMatchObject({status:'draft',version:2})
    const version=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO mbox.table_ticket_offers'))
    expect(version?.[1]?.at(-1)).toEqual([selected])
  })
  it.each([[old],[selected,old]])('rejects a table not in the current scope before persistence',async (...ids)=>{
    const {tx,query}=fixture()
    await expect(saveTicketOffer(tx,'show','writer',{...input,draftTableIds:ids})).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_STALE'})
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO mbox.table_ticket_offers'))).toBe(false)
  })
  it('requires explicit nonempty distinct selection once the roster is configured',async()=>{
    const {tx}=fixture()
    await expect(saveTicketOffer(tx,'show','writer',input)).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_INVALID'})
    await expect(saveTicketOffer(tx,'show','writer',{...input,draftTableIds:[selected,selected]})).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_INVALID'})
  })
  it('blocks old clients, explicit and batch publishing; withdrawal stays available',async()=>{
    const {tx}=fixture({prior:[selected]})
    await expect(saveTicketOffer(tx,'show','reviewer',{...input,status:'published'})).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_DRAFT_ONLY'})
    await expect(publishTicketDrafts(tx,'show','reviewer',[{areaId:'area',version:1}],1)).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_DRAFT_ONLY'})
    await expect(saveTicketOffer(tx,'show','reviewer',{...input,status:'withdrawn'})).resolves.toMatchObject({status:'withdrawn'})
    const removed=fixture({configured:false,prior:[selected]})
    await expect(saveTicketOffer(removed.tx,'show','reviewer',{...input,status:'published'})).rejects.toMatchObject({code:'TICKET_TABLE_SCOPE_DRAFT_ONLY'})
  })
  it('preserves the separately authorized historic area-wide behavior when unconfigured',async()=>{
    const {tx,query}=fixture({configured:false})
    await expect(saveTicketOffer(tx,'show','reviewer',{...input,status:'published'})).resolves.toMatchObject({status:'published'})
    expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO mbox.table_ticket_offers'))?.[1]?.at(-1)).toBeNull()
  })
})
