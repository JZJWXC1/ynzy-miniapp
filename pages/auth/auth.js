const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')

const MIN_PASSWORD_LENGTH = 8

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : (apiClient.getAuthToken ? apiClient.getAuthToken() : ''))
}

function finishWithUser(user) {
  const app = getApp()
  let saved = false
  if (app && app.setCurrentUser) {
    saved = app.setCurrentUser(user) === true
  }
  if (saved && app && app.bindWechatOpenid) {
    app.bindWechatOpenid()
  }
  return saved
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
    agreementsAccepted: false,
    submitting: false
  },

  onLoad() {
    this._authPageActive = true
    this._editedPrefillFields = new Set()
    if (!apiClient.getAuthToken()) return
    const requestSeq = Number(this._prefillRequestSeq || 0) + 1
    const requestSessionKey = currentAuthSessionKey()
    this._prefillRequestSeq = requestSeq
    apiService.getCurrentUser().then((user) => {
      if (!this._authPageActive || this._prefillRequestSeq !== requestSeq || currentAuthSessionKey() !== requestSessionKey) return
      if (user && user.id) {
        const patch = {}
        if (!this._editedPrefillFields.has('name')) patch['form.name'] = user.name || ''
        if (!this._editedPrefillFields.has('phone')) patch['form.phone'] = user.phone || ''
        if (Object.keys(patch).length > 0) this.setData(patch)
      }
    }).catch(() => {})
  },

  onUnload() {
    this._authPageActive = false
    this._prefillRequestSeq = Number(this._prefillRequestSeq || 0) + 1
    this._submitRequestSeq = Number(this._submitRequestSeq || 0) + 1
  },

  switchMode(event) {
    if (this.data.submitting) return
    const mode = event.currentTarget.dataset.mode || 'login'
    this.setData({ mode })
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    if (!this._editedPrefillFields) this._editedPrefillFields = new Set()
    this._editedPrefillFields.add(field)
    this.setData({
      [`form.${field}`]: event.detail.value
    })
  },

  onAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ agreementsAccepted: values.includes('accepted') })
  },

  openUserAgreement() {
    wx.navigateTo({ url: '/pages/user-agreement/user-agreement' })
  },

  openPrivacyPolicy() {
    wx.navigateTo({ url: '/pages/privacy-policy/privacy-policy' })
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
    if (this.data.submitting) return
    if (this.data.agreementsAccepted !== true) {
      wx.showToast({ title: '请先阅读并同意《用户服务协议》和《隐私政策》', icon: 'none' })
      return
    }
    const validation = this.validate()
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    const submitMode = this.data.mode
    const requestSessionKey = currentAuthSessionKey()
    const requestSeq = Number(this._submitRequestSeq || 0) + 1
    this._submitRequestSeq = requestSeq
    const isCurrentRequest = () => (
      this._authPageActive !== false &&
      this._submitRequestSeq === requestSeq &&
      currentAuthSessionKey() === requestSessionKey
    )
    const action = submitMode === 'register'
      ? apiService.registerUser({ name: validation.name, phone: validation.phone, password: validation.password })
      : apiService.loginByPhone(validation.phone, validation.password)

    action.then((user) => {
      if (!isCurrentRequest()) return
      // 只有登录才会走到这里（注册一律不发 token，注册结果在 catch 里按状态码友好提示）。
      if (!finishWithUser(user)) throw new Error('登录响应无有效会话，请重新登录')
      const completedSessionKey = currentAuthSessionKey()
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        if (!this._authPageActive || currentAuthSessionKey() !== completedSessionKey) return
        const pages = getCurrentPages()
        if (pages.length > 1) {
          wx.navigateBack()
        } else {
          wx.switchTab({ url: '/pages/profile/profile' })
        }
      }, 300)
    }).catch((error) => {
      if (!isCurrentRequest()) return
      const code = Number(error && error.statusCode)
      const message = (error && error.message) || '请稍后重试'
      if (submitMode === 'register') {
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
      if (this._submitRequestSeq === requestSeq) this.setData({ submitting: false })
    })
  }
})
