import { describe, expect, it } from 'vitest'
import { channelPermissionPresentation, staffPermissionCategory, matchesStaffPermissionSearch } from './channel-permissions.js'

describe('cooperation permission discovery', () => {
 it('finds all five capabilities by new name, legacy name or code even against old catalog metadata', () => {
  expect(Object.keys(channelPermissionPresentation)).toHaveLength(5)
  for (const [code,presentation] of Object.entries(channelPermissionPresentation)) {
   const old={code,name:'旧渠道权限',description:'旧描述',category:'marketing'}
   expect(staffPermissionCategory(old)).toBe('channel')
   expect(presentation.name).toContain('周边店合作')
   for(const query of ['周边店合作','渠道',code,'  合作店  ','']) expect(matchesStaffPermissionSearch(old,query,presentation.name,presentation.description)).toBe(true)
   expect(matchesStaffPermissionSearch(old,'库存盘点',presentation.name,presentation.description)).toBe(false)
  }
  expect(staffPermissionCategory({code:'marketing.send',category:'marketing'})).toBe('marketing')
 })
})
