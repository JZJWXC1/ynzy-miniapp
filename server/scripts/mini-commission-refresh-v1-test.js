'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// P2③：后台修改分佣配置后，上传页与详情页必须在生命周期（onShow）重新拉取，使展示以服务端当前配置为准；
// 且详情页只能静默更新分佣字段，不得清空 listing 或重置敏感查看态。行为回归由微信开发者工具执行，
// 本测试锁定静态生命周期契约，防止刷新逻辑被回退。

const root = path.resolve(__dirname, '../..')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

// 提取页面方法体：页面方法均为 2 空格缩进、`名称(...) {` 开头、以 `\n  },` 结束。
function methodBody(src, name) {
  const re = new RegExp('\\n  ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},')
  const m = src.match(re)
  return m ? m[1] : null
}

function run() {
  const failures = []

  const uploadSrc = read('pages/upload/upload.js')
  const uploadOnShow = methodBody(uploadSrc, 'onShow')
  if (!uploadOnShow || !/this\.loadCommissionConfig\(\)/.test(uploadOnShow)) {
    failures.push('upload.onShow 未在生命周期重新拉取分佣配置，后台改配置后会继续显示旧比例')
  } else if (!/_commissionConfigShownOnce/.test(uploadOnShow)) {
    failures.push('upload.onShow 未跳过首次显示：onLoad 已拉取，首屏会固定发两次请求并浪费限流额度')
  }

  const detailSrc = read('pages/listing-detail/listing-detail.js')
  const detailOnShow = methodBody(detailSrc, 'onShow')
  if (!detailOnShow || !/this\.refreshCommissionDisplay\(\)/.test(detailOnShow)) {
    failures.push('listing-detail.onShow 未在生命周期静默刷新分佣展示')
  }
  const refreshBody = methodBody(detailSrc, 'refreshCommissionDisplay')
  if (!refreshBody) {
    failures.push('listing-detail 缺少 refreshCommissionDisplay 方法')
  } else {
    if (/sensitiveVisible|isVerified|listing:\s*\{\}/.test(refreshBody)) {
      failures.push('refreshCommissionDisplay 不得清空 listing 或重置敏感查看态，必须仅静默更新分佣字段')
    }
    // 完整异步门禁：迟到响应/全量重载/卸载期间必须作废，否则乱序覆盖新比例或写入半成品详情。
    for (const guard of ['_commissionRefreshSeq', 'listingLoadGeneration', '_pageActive']) {
      if (!refreshBody.includes(guard)) {
        failures.push('refreshCommissionDisplay 缺少异步门禁 ' + guard + '，会乱序覆盖或写入只含佣金字段的半成品详情')
      }
    }
  }

  assert.deepStrictEqual(failures, [], failures.join('；'))
}

run()
console.log('mini-commission-refresh-v1-test passed')
