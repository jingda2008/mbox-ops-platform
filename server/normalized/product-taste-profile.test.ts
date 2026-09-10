import {describe,it,expect} from 'vitest'
import {productTasteProfile,publicProductTasteProfile} from '../../src/shared/product-taste-profile.js'
describe('product sensory display profile',()=>{
 it('distinguishes absent, unrated and zero',()=>{
  expect(productTasteProfile(undefined)).toBeNull()
  expect(productTasteProfile({acidity:0,sweetness:null})).toEqual({acidity:0,sweetness:null})
  expect(productTasteProfile({sweetness:5})).toEqual({acidity:null,sweetness:5})
 })
 it('reports the offending field without allowing operational configuration',()=>{
  expect(()=>productTasteProfile({acidity:6})).toThrow('酸度')
  expect(()=>productTasteProfile({sweetness:'3'})).toThrow('甜度')
  expect(()=>productTasteProfile({acidity:1.5})).toThrow('整数')
  expect(()=>productTasteProfile({enabled:true})).toThrow('不支持')
  expect(publicProductTasteProfile({sweetness:NaN})).toBeNull()
 })
})
