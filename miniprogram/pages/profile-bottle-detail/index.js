const { getCustomerBottle, getCustomerBottlePhoto } = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')
const { presentDetail } = require('../../utils/custody')
Page({
  data: { loading: false, loaded: false, error: '', order: null, deposits: [], collections: [], events: [] },
  onLoad(options) { this.orderId = options.id || ''; this.photoFiles = [] },
  onShow() { if (this.previewing) { this.previewing = false; return } return this.load() },
  onHide() { if (!this.previewing) this.clear() },
  onUnload() { this.clear() },
  clear() {
    this.generation = (this.generation || 0) + 1
    for (const filePath of this.photoFiles || []) wx.getFileSystemManager().unlink({ filePath, fail() {} })
    this.photoFiles = []
    this.setData({ order: null, deposits: [], collections: [], events: [], loaded: false, loading: false, error: '' })
  },
  async onPullDownRefresh() { try { await this.load() } finally { wx.stopPullDownRefresh() } },
  async load() {
    this.clear()
    const generation = this.generation
    this.setData({ loading: true })
    try {
      const result = await getCustomerBottle(this.orderId)
      if (generation !== this.generation) return
      this.setData(Object.assign(presentDetail(result), { loading: false, loaded: true }))
      if (this.data.deposits.length) await this.loadPhoto(this.data.deposits[0].id)
    } catch (error) { if (generation === this.generation) this.setData({ loading: false, error: customerErrorMessage(error, '存酒单暂未读取，请重试') }) }
  },
  async loadPhoto(id) {
    const deposit = this.data.deposits.find(d => d.id === id)
    if (!deposit || deposit.photoLoading || deposit.photoPath) return
    const generation = this.generation
    const update = values => { if (generation === this.generation) this.setData({ deposits: this.data.deposits.map(d => d.id === id ? Object.assign({}, d, values) : d) }) }
    update({ photoLoading: true, photoError: '' })
    let filePath
    try {
      const photo = await getCustomerBottlePhoto(this.orderId, id)
      if (generation !== this.generation) return
      if (!photo.base64) throw new Error('missing photo')
      filePath = wx.env.USER_DATA_PATH + '/custody-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg'
      await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: photo.base64, encoding: 'base64', success: resolve, fail: reject }))
      if (generation !== this.generation) { wx.getFileSystemManager().unlink({ filePath, fail() {} }); return }
      this.photoFiles.push(filePath)
      update({ photoPath: filePath, photoLoading: false })
    } catch (error) {
      if (filePath) wx.getFileSystemManager().unlink({ filePath, fail() {} })
      update({ photoLoading: false, photoError: customerErrorMessage(error, '照片暂未读取，点击重试') })
    }
  },
  photoAction(event) {
    const id = event.currentTarget.dataset.id
    const deposit = this.data.deposits.find(d => d.id === id)
    if (!deposit) return
    if (!deposit.photoPath) return this.loadPhoto(id)
    this.previewing = true
    wx.previewImage({ current: deposit.photoPath, urls: this.data.deposits.map(d => d.photoPath).filter(Boolean), fail: () => { this.previewing = false; wx.showToast({ title: '照片预览未打开，请重试', icon: 'none' }) } })
  },
  photoFailed(event) { const id = event.currentTarget.dataset.id; this.setData({ deposits: this.data.deposits.map(d => d.id === id ? Object.assign({}, d, { photoPath: '', photoError: '照片显示失败，点击重新读取' }) : d) }) },
  openMembership() { wx.switchTab({ url: '/pages/profile/index' }) },
})
