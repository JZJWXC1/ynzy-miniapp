const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'admin-web', 'index.html'), 'utf8')

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`]
  const start = markers.reduce((matched, marker) => {
    const index = source.indexOf(marker)
    if (index === -1) return matched
    return matched === -1 || index < matched ? index : matched
  }, -1)
  assert.ok(start >= 0, `后台缺少 ${name} 函数`)
  const braceStart = source.indexOf('{', start)
  let depth = 0
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${name} 函数体未闭合`)
}

function evaluateSuperOnlyActions(isSuper) {
  const sandbox = { currentAdminIsSuper: isSuper, result: null }
  vm.runInNewContext(`${extractFunction('superOnlyActions')}\nresult = superOnlyActions('<button class="write-action">写操作</button>')`, sandbox)
  return sandbox.result
}

const readonlyMarkup = evaluateSuperOnlyActions(false)
assert.ok(/只读权限/.test(readonlyMarkup), '受限管理员操作列必须明确显示只读权限')
assert.ok(!/<button\b/.test(readonlyMarkup), '受限管理员操作列不得包含可点击写按钮')

const superMarkup = evaluateSuperOnlyActions(true)
assert.ok(/write-action/.test(superMarkup), '超级管理员写能力不得回退')

;['renderListings', 'listingReviewActions', 'expiredListingActions', 'renderShowingUploads'].forEach((name) => {
  assert.ok(extractFunction(name).includes('superOnlyActions('), `${name} 必须统一收敛受限账号写按钮`)
})

assert.ok(!/confirm-deal-button|confirmAdminDeal/.test(source), '暂停期间任何管理员都不得确认历史签单')
assert.ok(/报备与签单功能暂停/.test(source) && /历史数据只读/.test(source), '后台必须明确历史报备/签单为暂停只读')

assert.ok(
  /<button[^>]*id="saveMaintenanceRule"[^>]*data-super="1"/.test(source),
  '房态规则保存按钮必须只对超级管理员显示'
)

console.log('admin-readonly-actions-v1-test passed')
