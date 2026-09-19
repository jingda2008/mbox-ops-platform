import {describe,it,expect,vi} from 'vitest'
import {OfficialSocialAccountAdapter,type SocialAccount} from './social-account-adapter.js'
const account:SocialAccount={id:'local',kind:'service_account',app_id:'wxLocalTest',enabled:true,code_template_id:'code',code_data_key:'character_string1',reminder_template_id:'reminder',reminder_data_key:'thing1'}
const credentials={secret:'local-secret',token:'localToken',encodingAesKey:'x'.repeat(43)}
const token=()=>new Response(JSON.stringify({access_token:'test-access-token',expires_in:7200}),{status:200})
describe('WeChat message delivery result boundaries',()=>{
 it.each([
  [{errcode:0,errmsg:'ok'},'accepted',null],
  [{errcode:43101,errmsg:'quota unavailable'},'rejected','WECHAT_43101'],
  [{},'unknown','INVALID_ACCEPTANCE'],
 ] as const)('uses the explicit bizsend acceptance contract %j',async(body,status,errorCode)=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify(body)))
  expect(await new OfficialSocialAccountAdapter(account,credentials,request).sendSubscribe('recipient','template',{number1:'1234'})).toEqual({status,providerReference:null,errorCode})
  expect(request).toHaveBeenCalledTimes(2)
 })
 it('never interprets a malformed user lookup as an unsubscribe',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('{}'))
  await expect(new OfficialSocialAccountAdapter(account,credentials,request).user('recipient')).rejects.toMatchObject({code:'INVALID_USER_RESPONSE'})
 })
 it.each([new Response('upstream unavailable',{status:503}),new Response('not json',{status:200}),new Response('{}',{status:200})])('keeps uncertain send responses unknown without retrying',async(response)=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(response)
  const result=await new OfficialSocialAccountAdapter(account,credentials,request).sendTemplate('recipient','template',{thing1:'text'})
  expect(result.status).toBe('unknown');expect(request).toHaveBeenCalledTimes(2)
 })
 it('distinguishes explicit provider rejection from HTTP failure',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({errcode:45009,errmsg:'quota'})))
  expect(await new OfficialSocialAccountAdapter(account,credentials,request).sendTemplate('recipient','template',{thing1:'text'})).toMatchObject({status:'rejected',errorCode:'WECHAT_45009'})
 })
 it('uses the official mass audience channel and records acceptance separately from final delivery',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({errcode:0,msg_id:12345})))
  expect(await new OfficialSocialAccountAdapter(account,credentials,request).sendBroadcast('活动内容')).toEqual({status:'accepted',providerReference:'12345',errorCode:null})
  const [url,init]=request.mock.calls[1]!
  expect(String(url)).toMatch(/^https:\/\/api.weixin.qq.com\/cgi-bin\/message\/mass\/sendall\?/)
  expect(JSON.parse(init!.body as string)).toEqual({filter:{is_to_all:true},msgtype:'text',text:{content:'活动内容'}})
 })
 it('preserves large provider receipt IDs and reuses a token across adapter instances',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response('{"errcode":0,"msgid":2002283324006668290}')).mockResolvedValueOnce(new Response('{"errcode":0,"msgid":2002283324006668291}'))
  expect((await new OfficialSocialAccountAdapter(account,credentials,request).sendTemplate('recipient','template',{})).providerReference).toBe('2002283324006668290')
  expect((await new OfficialSocialAccountAdapter(account,credentials,request).sendTemplate('recipient','template',{})).providerReference).toBe('2002283324006668291')
  expect(request).toHaveBeenCalledTimes(3)
 })
 it('does not send anything for a disabled account',async()=>{
  const request=vi.fn<typeof fetch>();expect((await new OfficialSocialAccountAdapter({...account,enabled:false},credentials,request).sendBroadcast('text')).status).toBe('rejected');expect(request).not.toHaveBeenCalled()
 })
})
