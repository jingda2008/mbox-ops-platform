export interface MemberPortalBenefit {
  id: string
  name: string
  description: string
  kind: 'product_gift' | 'amount_coupon' | 'service' | 'song'
  remainingQuantity: number
  validUntil: string
  status: 'available' | 'locked'
}

export interface MemberPortalResponse {
  member: {
    id: string
    displayName: string
    phoneMasked: string
    level: 'standard' | 'silver' | 'gold' | 'platinum'
    serviceAccountBound: boolean
    wecomBound: boolean
  }
  benefits: MemberPortalBenefit[]
}
