const crypto = require('crypto')

// 登录密码最小长度：与后台管理员账号同口径（≥8 位），中介自助注册与后台设密共用。
const MIN_PASSWORD_LENGTH = 8

// 密码哈希：scrypt + 随机 salt + 恒定时间比对。抽到独立模块，让 index.js（后台账号）与
// domain.js（小程序用户）共用同一实现，避免两套哈希口径漂移。禁止明文存储、禁止 == 比较。
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('base64url')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  // 拒绝退化数据：空 salt / 空 hash 段，或哈希过短。否则 `scrypt$salt$`（空 hash 段）会让
  // expected 为 0 长度、与 scryptSync(pwd, salt, 0) 的 0 长度 buffer 恒等 → 任意密码命中，构成认证绕过。
  // 正常 hashPassword 恒产 64 字节，这里 fail-closed 兜住任何被手工/迁移写坏的哈希。
  if (!parts[1] || !parts[2]) return false
  const expected = Buffer.from(parts[2], 'base64url')
  if (expected.length < 32) return false
  const actual = crypto.scryptSync(String(password), parts[1], expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

// 密码强度校验：返回错误提示字符串（不合规）或 ''（合规）。集中一处，登录注册/后台设密同口径。
function passwordIssue(password) {
  const value = String(password == null ? '' : password)
  if (!value) return '请设置登录密码'
  if (value.length < MIN_PASSWORD_LENGTH) return `登录密码至少 ${MIN_PASSWORD_LENGTH} 位`
  if (/\s/.test(value)) return '登录密码不能包含空格'
  return ''
}

module.exports = { hashPassword, verifyPassword, passwordIssue, MIN_PASSWORD_LENGTH }
