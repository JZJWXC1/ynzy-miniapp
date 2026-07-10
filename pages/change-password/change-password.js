const apiService = require('../../utils/api-service')

const MIN_PASSWORD_LENGTH = 8

Page({
  data: {
    form: { oldPassword: '', newPassword: '', confirmPassword: '' },
    submitting: false
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
    const validation = this.validate()
    if (!validation.ok) {
      wx.showToast({ title: validation.message, icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    apiService.changePassword(validation.oldPassword, validation.newPassword).then((user) => {
      // 服务端改密后会撤销全部旧 token，并给当前设备返回新 token；必须立即覆盖本地会话。
      const app = getApp()
      if (user && user.token && app && typeof app.setCurrentUser === 'function') {
        app.setCurrentUser(user)
      }
      wx.showToast({ title: '密码已修改', icon: 'success' })
      setTimeout(() => {
        wx.navigateBack()
      }, 400)
    }).catch((error) => {
      wx.showModal({
        title: '修改失败',
        content: (error && error.message) || '请稍后重试',
        showCancel: false
      })
    }).finally(() => {
      this.setData({ submitting: false })
    })
  }
})
