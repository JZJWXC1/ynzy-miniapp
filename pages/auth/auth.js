const apiService = require('../../utils/api-service')

function finishWithUser(user) {
  const app = getApp()
  if (app && app.setCurrentUser) {
    app.setCurrentUser(user)
  }
  if (app && app.bindWechatOpenid) {
    app.bindWechatOpenid()
  }
}

Page({
  data: {
    mode: 'login',
    form: {
      name: '',
      phone: ''
    },
    submitting: false
  },

  onLoad() {
    apiService.getCurrentUser().then((user) => {
      if (user && user.id) {
        this.setData({
          form: {
            name: user.name || '',
            phone: user.phone || ''
          }
        })
      }
    }).catch(() => {})
  },

  switchMode(event) {
    const mode = event.currentTarget.dataset.mode || 'login'
    this.setData({ mode })
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({
      [`form.${field}`]: event.detail.value
    })
  },

  validate() {
    const phone = String(this.data.form.phone || '').trim()
    const name = String(this.data.form.name || '').trim()
    if (!/^1\d{10}$/.test(phone)) {
      return { ok: false, message: '请输入 11 位手机号' }
    }
    if (this.data.mode === 'register' && !name) {
      return { ok: false, message: '请输入真实姓名' }
    }
    return { ok: true, phone, name }
  },

  submit() {
    const validation = this.validate()
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    const action = this.data.mode === 'register'
      ? apiService.registerUser({ name: validation.name, phone: validation.phone })
      : apiService.loginByPhone(validation.phone)

    action.then((user) => {
      finishWithUser(user)
      wx.showToast({
        title: this.data.mode === 'register' ? '注册成功' : '登录成功',
        icon: 'success'
      })
      setTimeout(() => {
        const pages = getCurrentPages()
        if (pages.length > 1) {
          wx.navigateBack()
        } else {
          wx.switchTab({ url: '/pages/profile/profile' })
        }
      }, 300)
    }).catch((error) => {
      wx.showModal({
        title: this.data.mode === 'login' ? '登录失败' : '注册失败',
        content: error.message || '请稍后重试',
        showCancel: this.data.mode === 'login',
        cancelText: '去注册',
        success: (res) => {
          if (this.data.mode === 'login' && res.cancel) {
            this.setData({ mode: 'register' })
          }
        }
      })
    }).finally(() => {
      this.setData({ submitting: false })
    })
  }
})
