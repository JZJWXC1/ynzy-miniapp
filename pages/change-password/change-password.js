const apiService = require('../../utils/api-service')
const apiClient = require('../../utils/api-client')

const MIN_PASSWORD_LENGTH = 8

function currentAuthSessionKey() {
  return String(typeof apiClient.getAuthSessionKey === 'function' ? apiClient.getAuthSessionKey() : (apiClient.getAuthToken ? apiClient.getAuthToken() : ''))
}

Page({
  data: {
    form: { oldPassword: '', newPassword: '', confirmPassword: '' },
    submitting: false
  },

  onLoad() {
    this._pageActive = true
    this.authSessionSnapshot = currentAuthSessionKey()
  },

  onShow() {
    this._pageActive = true
    const nextSessionKey = currentAuthSessionKey()
    const changed = this.authSessionSnapshot !== undefined && this.authSessionSnapshot !== nextSessionKey
    this.authSessionSnapshot = nextSessionKey
    if (!changed) return
    this._submitSeq = Number(this._submitSeq || 0) + 1
    this.setData({
      form: { oldPassword: '', newPassword: '', confirmPassword: '' },
      submitting: false
    })
  },

  onUnload() {
    this._pageActive = false
    this._submitSeq = Number(this._submitSeq || 0) + 1
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  validate() {
    const oldPassword = String(this.data.form.oldPassword || '')
    const newPassword = String(this.data.form.newPassword || '')
    const confirmPassword = String(this.data.form.confirmPassword || '')
    if (!oldPassword) {
      return { ok: false, message: '请输入原密码' }
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, message: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }
    }
    if (/\s/.test(newPassword)) {
      return { ok: false, message: '新密码不能包含空格' }
    }
    if (newPassword === oldPassword) {
      return { ok: false, message: '新密码不能与原密码相同' }
    }
    if (newPassword !== confirmPassword) {
      return { ok: false, message: '两次输入的新密码不一致' }
    }
    return { ok: true, oldPassword, newPassword }
  },

  submit() {
    if (this.data.submitting) return
    const validation = this.validate()
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const requestSessionKey = currentAuthSessionKey()
    const requestSeq = Number(this._submitSeq || 0) + 1
    this._submitSeq = requestSeq
    const isCurrentRequest = () => (
      this._pageActive !== false &&
      this._submitSeq === requestSeq &&
      currentAuthSessionKey() === requestSessionKey
    )
    apiService.changePassword(validation.oldPassword, validation.newPassword).then((user) => {
      if (!isCurrentRequest()) return
      // 服务端改密后会撤销全部旧 token，并给当前设备返回新 token；必须立即覆盖本地会话。
      const app = getApp()
      if (!user || !user.token || !app || typeof app.setCurrentUser !== 'function' || app.setCurrentUser(user) !== true) {
        throw new Error('密码已修改，但新登录状态保存失败，请使用新密码重新登录')
      }
      const completedSessionKey = currentAuthSessionKey()
      wx.showToast({ title: '密码已修改', icon: 'success' })
      setTimeout(() => {
        if (!this._pageActive || currentAuthSessionKey() !== completedSessionKey) return
        wx.navigateBack()
      }, 400)
    }).catch((error) => {
      if (!isCurrentRequest()) return
      wx.showModal({
        title: '修改失败',
        content: (error && error.message) || '请稍后重试',
        showCancel: false
      })
    }).finally(() => {
      if (this._submitSeq === requestSeq) this.setData({ submitting: false })
    })
  }
})
