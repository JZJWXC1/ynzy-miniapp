'use strict'

const ACCOUNT_CONTEXT_FIELDS = new Set([
  'threadId',
  'needId',
  'rentalNeedId',
  'clientNeedId',
  'needTemporary',
  'feedbackMessageId',
  'messageId',
  'userId',
  'viewerId',
  'maintainerId',
  'uploaderId',
  'role',
  'isAdmin'
])

function anonymousPublicRequestData(value, depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((item) => anonymousPublicRequestData(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).reduce((result, key) => {
    if (ACCOUNT_CONTEXT_FIELDS.has(key)) return result
    result[key] = anonymousPublicRequestData(value[key], depth + 1)
    return result
  }, {})
}

module.exports = {
  anonymousPublicRequestData
}
