import {describe,it,expect} from 'vitest'
import {upgradeChoiceCombinations} from './checkout-upgrade-choice-combinations.js'
describe('complete upgrade choice combinations',()=>{
 const group={id:'drinks',name:'鸡尾酒',selectionCount:2,options:[{productId:'a',name:'A'},{productId:'b',name:'B'},{productId:'c',name:'C'}]}
 it('uses combinations rather than permutations and never repeats one choice',()=>{
  const result=upgradeChoiceCombinations([group])!
  expect(result.map(row=>row.selection.groups[0]!.productIds)).toEqual([['a','b'],['a','c'],['b','c']])
 })
 it('expands all independent groups and preserves labels',()=>{
  const result=upgradeChoiceCombinations([group,{id:'snacks',name:'小食',selectionCount:1,options:[{productId:'x',name:'薯条'},{productId:'y',name:'鸡翅'}]}])!
  expect(result).toHaveLength(6);expect(result[0]!.label).toBe('鸡尾酒：A、B；小食：薯条')
 })
 it('fails closed instead of showing only the cheapest/truncated options',()=>{
  expect(upgradeChoiceCombinations([group],2)).toBeNull()
  expect(upgradeChoiceCombinations([{...group,selectionCount:4}])).toBeNull()
  expect(upgradeChoiceCombinations([group,group])).toBeNull()
 })
 it('represents a fixed bundle with one complete empty selection',()=>{
  expect(upgradeChoiceCombinations([])).toEqual([{selection:{groups:[]},label:''}])
 })
})
