const apiService = require('../../utils/api-service')

const MIN_PASSWORD_LENGTH = 8

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
      phone: '',
      password: '',
      confirmPassword: ''
    },
    submitting: false
  },

  onLoad() {
    apiService.getCurrentUser().then((user) => {
      if (user && user.id) {
        this.setData({
          'form.name': user.name || '',
          'form.phone': user.phone || ''
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
    const password = String(this.data.form.password || '')
    const confirmPassword = String(this.data.form.confirmPassword || '')
    if (!/^1\d{10}$/.test(phone)) {
      return { ok: false, message: '请输入 11 位手机号' }
    }
    if (this.data.mode === 'register' && !name) {
      return { ok: false, message: '请输入真实姓名' }
    }
    if (!password) {
      return { ok: false, message: '请输入登录密码' }
    }
    if (this.data.mode === 'register') {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, message: `登录密码至少 ${MIN_PASSWORD_LENGTH} 位` }
      }
      if (/\s/.test(password)) {
        return { ok: false, message: '登录密码不能包含空格' }
      }
      if (password !== confirmPassword) {
        return { ok: false, message: '两次输入的密码不一致' }
      }
    }
    return { ok: true, phone, name, password }
  },

  submit() {
    const validation = this.validate()
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    const action = this.data.mode === 'register'
      ? apiService.registerUser({ name: validation.name, phone: validation.phone, password: validation.password })
      : apiService.loginByPhone(validation.phone, validation.password)

    action.then((user) => {
      // 只有登录才会走到这里（注册一律不发 token，注册结果在 catch 里按状态码友好提示）。
      finishWithUser(user)
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        const pages = getCurrentPages()
        if (pages.length > 1) {
          wx.navigateBack()
        } else {
          wx.switchTab({ url: '/pages/profile/profile' })
        }
      }, 300)
    }).catch((error) => {
      const code = Number(error && error.statusCode)
      const message = (error && error.message) || '请稍后重试'
      if (this.data.mode === 'register') {
        if (code === 403) {
          // 注册申请已受理（待管理员审核开通）——按成功语气提示，而非报错。
          wx.showModal({
            title: '注册申请已提交',
            content: message,
            showCancel: false,
            confirmText: '我知道了'
          })
          return
        }
        if (code === 409) {
          // 该手机号已开通：引导直接登录。
          wx.showModal({
            title: '该手机号已开通',
            content: message,
            confirmText: '去登录',
            cancelText: '取消',
            success: (res) => {
              if (res.confirm) this.setData({ mode: 'login' })
            }
          })
          return
        }
        wx.showModal({ title: '提交失败', content: message, showCancel: false })
        return
      }
      wx.showModal({
        title: '登录失败',
        content: message,
        showCancel: true,
        cancelText: '去注册',
        success: (res) => {
          if (res.cancel) this.setData({ mode: 'register' })
        }
      })
    }).finally(() => {
      this.setData({ submitting: false })
    })
  }
})
