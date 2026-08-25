const {
  getCustomerProfile, updatePreferences, recordBirthdayBenefitConsent, withdrawBirthdayBenefitConsent,
} = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')

const AVATAR_KEY = 'mbox.member.avatarUrl'
const SEATS = [
  { value: 'no_preference', label: '交给现场' },
  { value: 'comfortable_booth', label: '舒适卡座' },
  { value: 'stage_atmosphere', label: '靠近舞台' },
  { value: 'quiet_chat', label: '方便聊天' },
  { value: 'outdoor_view', label: '外景位置' },
]
const SERVICE = [
  { value: 'quiet', label: '少些打扰' },
  { value: 'balanced', label: '刚刚好' },
  { value: 'hosted', label: '希望被照顾' },
]
const ALCOHOL = [
  { value: 'cocktail', label: '鸡尾酒' }, { value: 'wine', label: '葡萄酒' },
  { value: 'sparkling', label: '起泡酒' }, { value: 'beer', label: '啤酒' },
  { value: 'spirits', label: '烈酒' }, { value: 'non_alcoholic', label: '无酒精' },
  { value: 'mixed', label: '都可以' },
]

function birthdayOptions() {
  const output = [{ value: '', label: '暂不填写' }]
  for (let month = 1; month <= 12; month += 1) {
    const days = new Date(2024, month, 0).getDate()
    for (let day = 1; day <= days; day += 1) {
      const value = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      output.push({ value, label: `${month}月${day}日` })
    }
  }
  return output
}

function optionIndex(options, value) {
  const index = options.findIndex((item) => item.value === value)
  return index < 0 ? 0 : index
}

function alcoholChips(selectedValues) {
  const selected = new Set(selectedValues || [])
  return ALCOHOL.map((item) => Object.assign({}, item, { selected: selected.has(item.value) }))
}

Page({
  data: {
    loading: true, saving: false, error: '', profile: null, avatarUrl: '',
    displayName: '', seats: SEATS, service: SERVICE, alcohol: alcoholChips(['mixed']), birthdays: birthdayOptions(),
    seatValue: 'no_preference', serviceValue: 'balanced', birthdayIndex: 0,
    tasteNotes: '', musicStyles: '', dietaryNotes: '',
  },

  onLoad() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const profile = await getCustomerProfile()
      const preferences = profile.preferences || {}
      const preferred = preferences.preferredAlcohol || 'mixed'
      const selectedAlcohol = preferred === 'mixed' ? ['mixed'] : [preferred]
      this.setData({
        loading: false, profile,
        avatarUrl: wx.getStorageSync(AVATAR_KEY) || '',
        displayName: profile.displayName || wx.getStorageSync('mbox.member.displayName') || '',
        seatValue: preferences.seatPreference || 'no_preference',
        serviceValue: preferences.serviceIntensity || 'balanced',
        alcohol: alcoholChips(selectedAlcohol),
        birthdayIndex: optionIndex(this.data.birthdays, preferences.birthdayMonthDay),
        tasteNotes: preferences.tasteNotes || '',
        musicStyles: preferences.musicStyles || '',
        dietaryNotes: preferences.dietaryNotes || '',
      })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '暂时无法读取偏好设置') })
    }
  },

  onChooseAvatar(event) {
    const avatarUrl = event && event.detail && event.detail.avatarUrl
    if (!avatarUrl) return
    wx.setStorageSync(AVATAR_KEY, avatarUrl)
    this.setData({ avatarUrl })
  },
  onNameInput(event) { this.setData({ displayName: event.detail.value }) },
  onTasteInput(event) { this.setData({ tasteNotes: event.detail.value }) },
  onMusicInput(event) { this.setData({ musicStyles: event.detail.value }) },
  onDietaryInput(event) { this.setData({ dietaryNotes: event.detail.value }) },
  onBirthdayChange(event) { this.setData({ birthdayIndex: Number(event.detail.value) }) },
  toggleSeat(event) { this.setData({ seatValue: event.currentTarget.dataset.value }) },
  toggleService(event) { this.setData({ serviceValue: event.currentTarget.dataset.value }) },
  toggleAlcohol(event) {
    const value = event.currentTarget.dataset.value
    let selected = this.data.alcohol.filter((item) => item.selected).map((item) => item.value)
    if (value === 'mixed') {
      selected = selected.includes('mixed') ? [] : ['mixed']
    } else {
      selected = selected.filter((item) => item !== 'mixed')
      if (selected.includes(value)) selected = selected.filter((item) => item !== value)
      else selected = selected.concat(value)
    }
    if (!selected.length) selected = ['mixed']
    this.setData({ alcohol: alcoholChips(selected) })
  },

  async save() {
    if (this.data.saving) return
    const displayName = String(this.data.displayName || '').trim()
    if (displayName.length > 80) return this.setData({ error: '昵称请控制在80个字以内' })
    const selectedAlcohol = this.data.alcohol.filter((item) => item.selected).map((item) => item.value)
    const preferredAlcohol = selectedAlcohol.length === 1 ? selectedAlcohol[0] : 'mixed'
    const birthdayMonthDay = this.data.birthdays[this.data.birthdayIndex].value
    const preferences = {
      seatPreference: this.data.seatValue,
      serviceIntensity: this.data.serviceValue,
      preferredAlcohol,
      tasteNotes: String(this.data.tasteNotes || '').trim(),
      musicStyles: String(this.data.musicStyles || '').trim(),
      dietaryNotes: String(this.data.dietaryNotes || '').trim(),
    }
    this.setData({ saving: true, error: '' })
    try {
      await updatePreferences(preferences, displayName || null)
      const priorBirthday = this.data.profile && this.data.profile.preferences
        ? this.data.profile.preferences.birthdayMonthDay : ''
      if (birthdayMonthDay) {
        await recordBirthdayBenefitConsent(birthdayMonthDay)
      } else if (priorBirthday) {
        try { await withdrawBirthdayBenefitConsent('顾客本人移除生日月日并撤回生日礼遇授权') }
        catch (error) { if (!error || error.code !== 'BIRTHDAY_CONSENT_NOT_GRANTED') throw error }
      }
      wx.setStorageSync('mbox.member.displayName', displayName || '')
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 550)
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '暂时没有保存成功') })
    } finally { this.setData({ saving: false }) }
  },
})
