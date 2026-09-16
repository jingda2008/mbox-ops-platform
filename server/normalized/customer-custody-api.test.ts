import Fastify from 'fastify'
import {afterEach,expect,it,vi} from 'vitest'
import {customerCustodyApiPlugin} from './customer-custody-api.js'
import {CustomerCustodyRepository} from './customer-custody-repository.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
const apps:ReturnType<typeof Fastify>[]=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks()})
const id='11111111-1111-4111-8111-111111111111',photo='22222222-2222-4222-8222-222222222222'
function setup(anonymous=false) {
  const app=Fastify();apps.push(app)
  const scope={tenantId:id,storeId:photo}
  const run=vi.fn(async(scope,fn)=>fn({scope,query:async()=>({rows:[]})}))
  app.register(customerCustodyApiPlugin,{transactions:{run} as CustomerBenefitApiOptions['transactions'],protection:createActivityContactProtectionKeyring(null,'local-custody-test-only'),resolveSelfContext:async()=>{
    if(anonymous)throw new NormalizedAuthenticationRequiredError()
    return {scope,customerId:'authenticated-customer',tableSessionId:null,businessDate:'2026-09-16',actorRef:'test'}
  }})
  return {app,run}
}
it.each(['',`/${id}`,`/${id}/photos/${photo}`])('requires authentication and disables caching for %s',async suffix=>{
  const {app,run}=setup(true),response=await app.inject('/public/mini/customer/bottle-custody'+suffix)
  expect(response.statusCode).toBe(401);expect(run).not.toHaveBeenCalled();expect(response.headers['cache-control']).toContain('no-store')
})
it('does not accept client-chosen ownership and validates cursor before database reads',async()=>{
  const {app,run}=setup()
  for(const query of ['?customerId=victim','?memberNo=100002','?cursor=bad'])expect((await app.inject('/public/mini/customer/bottle-custody'+query)).statusCode).toBe(400)
  expect(run).not.toHaveBeenCalled()
})
it('binds list, detail and photo to the session and read-only transactions',async()=>{
  const list=vi.spyOn(CustomerCustodyRepository.prototype,'list').mockResolvedValue({items:[],nextCursor:null})
  const detail=vi.spyOn(CustomerCustodyRepository.prototype,'detail').mockResolvedValue({order:{},deposits:[],collections:[],events:[]} as never)
  const readPhoto=vi.spyOn(CustomerCustodyRepository.prototype,'photo').mockResolvedValue(Buffer.from('photo'))
  const {app,run}=setup()
  for(const suffix of ['',`/${id}`,`/${id}/photos/${photo}`])expect((await app.inject('/public/mini/customer/bottle-custody'+suffix)).statusCode).toBe(200)
  expect(list).toHaveBeenCalledWith('authenticated-customer',undefined);expect(detail).toHaveBeenCalledWith('authenticated-customer',id);expect(readPhoto).toHaveBeenCalledWith('authenticated-customer',id,photo)
  expect(run.mock.calls.every(call=>call[2]?.readOnly)).toBe(true)
})
it('rejects cross-customer details and photos before touching deposit data',async()=>{
  const {app}=setup()
  for(const suffix of [`/${id}`,`/${id}/photos/${photo}`])expect((await app.inject('/public/mini/customer/bottle-custody'+suffix)).statusCode).toBe(404)
})
