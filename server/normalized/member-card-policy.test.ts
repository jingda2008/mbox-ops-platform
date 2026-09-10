import {describe,it,expect} from 'vitest'
import {assertCardProjectOpen,decideCardApplication,matchesCardAudience,transitionMemberCard,type CardAudienceRule} from './member-card-policy.js'
const project={state:'open' as const,availableFrom:'2037-09-01T00:00:00+08:00',availableUntil:'2037-10-01T00:00:00+08:00',kind:'interest' as const,cooperationConfirmed:false,cooperationValidUntil:null}
const now=new Date('2037-09-09T12:00:00+08:00')
describe('independent member card and ordinary application policy',()=>{
  it('permits one authorized reviewer without marketing, follow or WeCom evidence',()=>{
    expect(decideCardApplication({state:'pending',decision:'approve',reviewerAuthorized:true,project,now,activeMember:true,alreadyHoldsCard:false})).toEqual({applicationState:'approved',createCard:true})
  })
  it('does not create a second card when the canonical customer already holds it',()=>{
    expect(decideCardApplication({state:'pending',decision:'approve',reviewerAuthorized:true,project,now,activeMember:true,alreadyHoldsCard:true}).createCard).toBe(false)
  })
  it.each(['approved','rejected','withdrawn'] as const)('rejects stale review of %s',state=>{
    expect(()=>decideCardApplication({state,decision:'approve',reviewerAuthorized:true,project,now,activeMember:true,alreadyHoldsCard:false})).toThrow('已处理')
  })
  it.each(['draft','paused','closed'] as const)('does not issue a card in project state %s',state=>{
    expect(()=>assertCardProjectOpen({...project,state},now)).toThrow()
  })
  it('uses an exclusive expiry and requires current confirmed cooperation for co-brand cards',()=>{
    expect(()=>assertCardProjectOpen(project,new Date(project.availableUntil))).toThrow()
    expect(()=>assertCardProjectOpen({...project,kind:'cobrand'},now)).toThrow('联名')
    expect(()=>assertCardProjectOpen({...project,kind:'cobrand',cooperationConfirmed:true,cooperationValidUntil:now.toISOString()},now)).toThrow('联名')
  })
  it('allows rejecting a stale project application but still requires review authority',()=>{
    const input={state:'pending' as const,decision:'reject' as const,reviewerAuthorized:true,project:{...project,state:'closed' as const},now,activeMember:false,alreadyHoldsCard:false}
    expect(decideCardApplication(input).applicationState).toBe('rejected')
    expect(()=>decideCardApplication({...input,reviewerAuthorized:false})).toThrow('权限')
  })
  it('keeps customer exit and staff suspension distinct; neither silently revives a revoked card',()=>{
    expect(transitionMemberCard('active','suspend')).toBe('suspended')
    expect(transitionMemberCard('suspended','resume')).toBe('active')
    expect(transitionMemberCard('suspended','withdraw')).toBe('withdrawn')
    expect(()=>transitionMemberCard('revoked','resume')).toThrow()
    expect(()=>transitionMemberCard('withdrawn','resume')).toThrow()
  })
  it('combines grade and multiple interests with explicit any/all and and/or semantics',()=>{
    const rule:CardAudienceRule={minimumTier:'gold',cardCodes:['FAN_CARD','JAZZ_CARD'],cardMatch:'all',tierAndCards:'and'}
    expect(matchesCardAudience(rule,{tier:'gold',activeCardCodes:['FAN_CARD']})).toBe(false)
    expect(matchesCardAudience({...rule,cardMatch:'any'},{tier:'gold',activeCardCodes:['FAN_CARD']})).toBe(true)
    expect(matchesCardAudience({...rule,tierAndCards:'or'},{tier:'silver',activeCardCodes:['FAN_CARD','JAZZ_CARD']})).toBe(true)
    expect(matchesCardAudience(rule,{tier:'unknown',activeCardCodes:['FAN_CARD','JAZZ_CARD']})).toBe(false)
  })
  it('rejects an empty audience instead of accidentally granting to everyone',()=>{
    expect(()=>matchesCardAudience({minimumTier:null,cardCodes:[],cardMatch:'any',tierAndCards:'and'},{tier:'gold',activeCardCodes:[]})).toThrow('空条件')
  })
})
