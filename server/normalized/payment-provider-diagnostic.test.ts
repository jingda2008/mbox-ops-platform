import {PostarPaymentRejectedError} from '../postar-adapter.js'
import {describe,it,expect} from 'vitest'
import {OnlinePaymentUnknownError} from './online-payment-service.js'

describe('payment unknown diagnostics without sensitive provider data',()=>{
 it.each([
  [Object.assign(new Error('secret=not-for-logs'),{name:'TimeoutError'}),'timeout'],
  [new Error('https://private-provider/?key=private-secret',{cause:Object.assign(new Error('phone=13800012345'),{code:'ECONNRESET'})}),'network'],
  [new SyntaxError('token=private-secret body=13800012345'),'invalid_response'],
  [new Error('星驿HTTP响应异常: 503'),'http'],
  [new PostarPaymentRejectedError('token=private-secret',{providerCode:'ORDER_NOT_FOUND'}),'provider_rejected'],
  [new Error('unclassified private-secret'),'unknown'],
 ] as const)('preserves the financial unknown boundary and the safe category', (cause,category)=>{
  const error=new OnlinePaymentUnknownError(cause,'close')
  expect(error.diagnostic).toMatchObject({operation:'close',category})
  expect(error).not.toHaveProperty('cause')
  expect(JSON.stringify(error)).not.toMatch(/private-secret|13800012345|private-provider|not-for-logs/)
 })
})
