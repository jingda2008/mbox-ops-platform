const { getCustomerProfile, updatePreferences } = require('../../utils/api')

const SEATS = [
  { value: 'no_preference', label: '交给现场安排' },
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

Page({
  data: {
    loading: true, saving: false, error: '', profile: null,
    displayName: '', seats: SEATS, service: SERVICE, alcohol: ALCOHOL, birthdays: birthdayOptions(),
    seatIndex: 0, serviceIndex: 1, alcoholIndex: 6, birthdayIndex: 0,
    tasteNotes: '', musicStyles: '', dietaryNotes: '',
  },

  onLoad() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const profile = await getCustomerProfile()
      const preferences = profile.preferences || {}
      this.setData({
        loading: false, profile,
        displayName: profile.displayName || '',
        seatIndex: optionIndex(SEATS, preferences.seatPreference),
        serviceIndex: optionIndex(SERVICE, preferences.serviceIntensity),
        alcoholIndex: optionIndex(ALCOHOL, preferences.preferredAlcohol),
        birthdayIndex: optionIndex(this.data.birthdays, preferences.birthdayMonthDay),
        tasteNotes: preferences.tasteNotes || '',
        musicStyles: preferences.musicStyles || '',
        dietaryNotes: preferences.dietaryNotes || '',
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '暂时无法读取个人资料' })
    }
  },

  onNameInput(event) { this.setData({ displayName: event.detail.value }) },
  onTasteInput(event) { this.setData({ tasteNotes: event.detail.value }) },
  onMusicInput(event) { this.setData({ musicStyles: event.detail.value }) },
  onDietaryInput(event) { this.setData({ dietaryNotes: event.detail.value }) },
  chooseSeat(event) { this.setData({ seatIndex: Number(event.currentTarget.dataset.index) }) },
  chooseService(event) { this.setData({ serviceIndex: Number(event.currentTarget.dataset.index) }) },
  chooseAlcohol(event) { this.setData({ alcoholIndex: Number(event.currentTarget.dataset.index) }) },
  onBirthdayChange(event) { this.setData({ birthdayIndex: Number(event.detail.value) }) },

  async save() {
    if (this.data.saving) return
    const displayName = String(this.data.displayName || '').trim()
    if (displayName.length > 80) return this.setData({ error: '昵称请控制在80个字以内' })
    const preferences = {
      seatPreference: this.data.seats[this.data.seatIndex].value,
      serviceIntensity: this.data.service[this.data.serviceIndex].value,
      preferredAlcohol: this.data.alcohol[this.data.alcoholIndex].value,
      birthdayMonthDay: this.data.birthdays[this.data.birthdayIndex].value,
      tasteNotes: String(this.data.tasteNotes || '').trim(),
      musicStyles: String(this.data.musicStyles || '').trim(),
      dietaryNotes: String(this.data.dietaryNotes || '').trim(),
    }
    this.setData({ saving: true, error: '' })
    try {
      await updatePreferences(preferences, displayName || null)
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 550)
    } catch (error) {
      this.setData({ error: error.message || '暂时没有保存成功' })
    } finally { this.setData({ saving: false }) }
  },
})
