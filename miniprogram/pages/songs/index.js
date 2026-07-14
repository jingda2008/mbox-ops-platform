const { getGuestSession, submitSongRequest } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { money, dateTime } = require('../../utils/format')

Page({
  data: {
    loading: true,
    submitting: false,
    error: '',
    warning: '',
    success: '',
    isDevelopment: false,
    isFallback: false,
    tableCode: '',
    tableSessionId: '',
    offers: [],
    selectedOffer: null,
    customerNote: '',
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const result = await getGuestSession()
      const data = result.data
      const offers = (data.songOffers || []).map((offer) => Object.assign({}, offer, {
        priceText: money(offer.priceAmount),
        timeText: dateTime(offer.startsAt),
      }))
      this.setData({
        loading: false,
        warning: result.warning,
        isFallback: result.source !== 'api',
        tableSessionId: data.account.tableSessionId || '',
        offers,
        error: data.account.tableSessionId ? '' : '当前桌台没有有效会话，暂不能提交点歌意向',
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '当日歌单载入失败' })
    }
  },

  selectOffer(event) {
    const selectedOffer = this.data.offers.find((item) => item.id === event.currentTarget.dataset.id)
    this.setData({ selectedOffer, success: '', error: '' })
  },

  onNoteInput(event) {
    this.setData({ customerNote: event.detail.value })
  },

  closeSelection() {
    this.setData({ selectedOffer: null, customerNote: '' })
  },

  noop() {},

  async submitIntent() {
    if (!this.data.selectedOffer || !this.data.tableSessionId) return
    if (this.data.isFallback) {
      this.setData({ error: '开发占位数据不能提交点歌，请启动本地 API 后重试' })
      return
    }
    const offer = this.data.selectedOffer
    this.setData({ submitting: true, error: '', success: '' })
    try {
      await submitSongRequest({
        appearanceId: offer.appearanceId,
        singerId: offer.singerId,
        songId: offer.songId,
        customerNote: this.data.customerNote.trim(),
      })
      this.setData({
        submitting: false,
        selectedOffer: null,
        customerNote: '',
        success: '点歌意向已提交，舞台正在确认。本页面未发起支付；确认与后续状态请在状态页查看。',
      })
    } catch (error) {
      this.setData({ submitting: false, error: error.message || '点歌意向未提交' })
    }
  },
})
