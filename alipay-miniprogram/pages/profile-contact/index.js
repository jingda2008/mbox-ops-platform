const runtime = require('../../utils/platform')
const { getMiniBootstrap } = require('../../utils/api')

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
    runtime.makePhoneCall({ phoneNumber: String(phone) }).catch(() => {
      runtime.showToast({ title: '暂时无法拨打', icon: 'none' })
    })
  },

  previewWecomQr() {
    const url = this.data.contact && this.data.contact.wecomQrImageUrl
    if (!url) return
    runtime.previewImage({ current: url, urls: [url] })
  },

  openCustomerService() {
    runtime.showModal({
      title: '支付宝暂不支持直达企业微信',
      content: '请拨打预约电话；如页面显示企业微信二维码，也可放大保存后扫码。',
      showCancel: false,
    })
  },
})
