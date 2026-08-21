const { getMiniBootstrap } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')

const STORE_PHONE = '17621392152'

Page({
  data: { loading: true, error: '', contact: null },

  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      const remote = bootstrap.supportContact || null
      this.setData({
        loading: false,
        contact: {
          phone: (remote && remote.phone) || STORE_PHONE,
          phoneLabel: (remote && remote.phoneLabel) || '门店预约电话',
          wecomQrImageUrl: remote && remote.wecomQrImageUrl || '',
          wecomName: remote && remote.wecomName || '企业微信',
        },
      })
    } catch (_error) {
      this.setData({
        loading: false,
        contact: {
          phone: STORE_PHONE,
          phoneLabel: '门店预约电话',
          wecomQrImageUrl: '',
          wecomName: '企业微信',
        },
      })
    }
  },

  callStore() {
    const phone = (this.data.contact && this.data.contact.phone) || STORE_PHONE
    wx.makePhoneCall({ phoneNumber: String(phone) }).catch(() => {
      wx.showToast({ title: '暂时无法拨打', icon: 'none' })
    })
  },

  previewWecomQr() {
    const url = this.data.contact && this.data.contact.wecomQrImageUrl
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  openCustomerService() {
    const config = getRuntimeConfig()
    const url = String(config.wecomCustomerServiceUrl || '').trim()
    const corpId = String(config.wecomCorpId || '').trim()
    if (!url || !corpId) {
      wx.showModal({
        title: '客服暂未开通',
        content: '请确认已配置企业微信客服链接与企业ID，并在小程序后台完成绑定。也可先拨打预约电话。',
        showCancel: false,
      })
      return
    }
    if (typeof wx.openCustomerServiceChat !== 'function') {
      wx.showToast({ title: '当前微信版本过低，请升级后重试', icon: 'none' })
      return
    }
    wx.openCustomerServiceChat({
      extInfo: { url },
      corpId,
      fail(error) {
        const raw = String((error && (error.errMsg || error.message)) || '')
        wx.showModal({
          title: '暂时无法打开客服',
          content: /not\s*bind|未绑定/i.test(raw)
            ? '请在微信公众平台绑定企业微信客服后再试。也可拨打预约电话。'
            : ('微信返回：' + (raw || '未知错误')),
          showCancel: false,
        })
      },
    })
  },
})
