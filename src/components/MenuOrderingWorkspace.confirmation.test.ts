import { describe, expect, it } from 'vitest'
import { buildMenuCartItems, isMenuConfirmationDisabled } from './MenuOrderingWorkspace'

describe('menu order confirmations', () => {
  it('binds product remarks to their own order line and retains bundle selections', () => {
    const selections={bundle:[{groups:[{groupId:'cocktail',productIds:['A']}]}]}
    expect(buildMenuCartItems([{id:'bundle'},{id:'food'}],{bundle:1,food:2},selections,
      {bundle:' 少冰 ',food:'不放辣',removed:'不要发送'})).toEqual([
        {productId:'bundle',quantity:1,note:'少冰',bundleSelections:selections.bundle},
        {productId:'food',quantity:2,note:'不放辣'},
      ])
  })
  it('allows a guest to confirm a new cart adjustment even while checkout is temporarily unavailable', () => {
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: true,
      confirmation: 'continue',
      confirmedDuplicateOrderId: '',
    })).toBe(false)
  })

  it('keeps an unavailable checkout and an unconfirmed duplicate order blocked', () => {
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: true,
      confirmation: 'submit',
      confirmedDuplicateOrderId: '',
    })).toBe(true)
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: false,
      confirmation: 'duplicate',
      confirmedDuplicateOrderId: '',
    })).toBe(true)
  })
})
