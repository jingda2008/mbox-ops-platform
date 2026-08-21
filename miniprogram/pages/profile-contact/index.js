const { getMiniBootstrap } = require('../../utils/api')

Page({
  data: { loading: true, error: '', contact: null },

  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      this.setData({ loading: false, contact: bootstrap.supportContact || null })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '门店联系信息暂时无法读取' })
    }
  },

  callStore() {
    const phone = this.data.contact && this.data.contact.phone
    if (!phone) return
    wx.makePhoneCall({ number: phone }).catch(() => {})
  },

  previewWecomQr() {
    const url = this.data.contact && this.data.contact.wecomQrImageUrl
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },
})
