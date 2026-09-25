import {describe,expect,it} from 'vitest'
import {tableSearchMatcher} from '../shared/table-search'

describe('complete table codes across staff search surfaces',()=>{
  it.each(['a5','A5',' A05 '])('does not match IDs or product names containing %s',query=>{
    const matches=tableSearchMatcher(query,['A5','B2','A50'])
    expect(matches('A5','drink')).toBe(true)
    expect(matches('B2','order-b2-ca546-sample','A5套餐')).toBe(false)
    expect(matches('A50','drink')).toBe(false)
  })
  it('does not fall back to a random ID when the table has no tasks',()=>{
    const matches=tableSearchMatcher('A5',['B2','A50'])
    expect(matches('B2','some-a5-id')).toBe(false)
    expect(matches('A50')).toBe(false)
  })
  it('keeps literal tables distinct from approved aliases',()=>{
    const matches=tableSearchMatcher('C01',['C01','C1'])
    expect(matches('C01')).toBe(true)
    expect(matches('C1')).toBe(false)
    expect(tableSearchMatcher('W01',['W1'])('W1')).toBe(true)
    expect(tableSearchMatcher('C08',['C8'])('C8')).toBe(false)
  })
  it('retains area, product, prefix, and non-table ID searches',()=>{
    expect(tableSearchMatcher('露台',['A1'])('A1','露台')).toBe(true)
    expect(tableSearchMatcher('1664',['A1'])('A1','1664啤酒')).toBe(true)
    expect(tableSearchMatcher('W',['W1','W10'])('W10')).toBe(true)
    expect(tableSearchMatcher('ca546',['B2'])('B2','order-b2-ca546-sample')).toBe(true)
    expect(tableSearchMatcher('',['A1'])(null,'unknown')).toBe(true)
  })
})
