import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  approvedReviewPrivacyPolicy,
  selectPublicPrivacyPolicy,
} from './approved-privacy-policy.js'

describe('approved privacy policy read selection', () => {
  it('serves the in-repo review copy only when the store has no published and no withdrawn release', () => {
    const review = approvedReviewPrivacyPolicy()
    expect(review.version).toBe('MBOX-PRIVACY-20260914-V2')
    expect(review.content.length).toBeGreaterThan(80)
    expect(review.contentSha256).toBe(createHash('sha256').update(review.content).digest('hex'))
    expect(review.content).toContain('上海超嗨文化传媒有限公司')
    expect(selectPublicPrivacyPolicy({ published: null, withdrawn: false })).toEqual({
      data: review,
      meta: { published: false, source: 'approved-review-copy' },
    })
  })

  it('keeps a store release authoritative and hides the review copy after withdrawal', () => {
    const published = {
      ...approvedReviewPrivacyPolicy(),
      version: 'STORE.1',
      content: '门店已发布的隐私政策正文。'.repeat(8),
    }
    published.contentSha256 = createHash('sha256').update(published.content).digest('hex')
    expect(selectPublicPrivacyPolicy({ published, withdrawn: false })).toEqual({
      data: published,
      meta: { published: true, source: 'store-release' },
    })
    expect(selectPublicPrivacyPolicy({ published: null, withdrawn: true })).toEqual({
      data: null,
      meta: { published: false },
    })
  })
})
