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
  assert.ok(braceStart >= 0, `${name} 缺少函数体`)
  let depth = 0
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${name} 函数体未闭合`)
}

function loadFunction(name, context) {
  const sandbox = { ...context, result: null }
  vm.runInNewContext(`${extractFunction(name)}\nresult = ${name}`, sandbox)
  return sandbox.result
}

async function run() {
  let fallbackCalls = 0
  let dataFailureCalls = 0
  const onlineGetAdminData = loadFunction('getAdminData', {
    canUseAdminApi: () => true,
    adminRequest: async () => { throw new Error('backend-offline') },
    showAdminDataFailure: () => { dataFailureCalls += 1 }
  })
  await assert.rejects(
    () => onlineGetAdminData('/admin/listings', () => {
      fallbackCalls += 1
      return [{ id: 'PREVIEW-LISTING' }]
    }),
    /backend-offline/,
    '在线后台读取失败必须向上抛错，不能显示本地预览数据'
  )
  assert.strictEqual(fallbackCalls, 0, '在线后台不得调用 preview fallback')
  assert.strictEqual(dataFailureCalls, 1, '任意在线读取失败都必须立即显示数据不可用状态')

  let onlineRequestCalls = 0
  const previewGetAdminData = loadFunction('getAdminData', {
    canUseAdminApi: () => false,
    adminRequest: async () => {
      onlineRequestCalls += 1
      return []
    }
  })
  const previewRows = await previewGetAdminData('/admin/listings', () => [{ id: 'PREVIEW-LISTING' }])
  assert.deepStrictEqual(JSON.parse(JSON.stringify(previewRows)), [{ id: 'PREVIEW-LISTING' }], 'file 预览仍应使用本地演示数据')
  assert.strictEqual(onlineRequestCalls, 0, 'file 预览不得请求后端')

  let showingFallbackCalls = 0
  let showingFailureCalls = 0
  const onlineShowingData = loadFunction('getShowingUploadData', {
    canUseAdminApi: () => true,
    adminRequest: async () => { throw new Error('showing-backend-offline') },
    showAdminDataFailure: () => { showingFailureCalls += 1 },
    dataCenter: {
      getShowingUploadRows() {
        showingFallbackCalls += 1
        return [{ id: 'PREVIEW-SHOWING' }]
      }
    }
  })
  await assert.rejects(
    () => onlineShowingData(),
    /showing-backend-offline/,
    '在线带看读取失败也不得回退本地预览记录'
  )
  assert.strictEqual(showingFallbackCalls, 0, '在线带看不得调用 preview fallback')
  assert.strictEqual(showingFailureCalls, 1, '在线带看读取失败必须立即显示数据不可用状态')

  assert.ok(source.includes('id="adminDataFailure"'), '在线读取失败必须有持久错误状态容器')
  assert.ok(source.includes('async function restoreAdminSession('), '刷新页面必须尝试恢复有效后台会话')
  assert.ok(source.includes("sessionStorage.removeItem('ynzy_admin_token')"), '失效后台 token 必须清理')

  const renderAllSource = extractFunction('renderAll')
  assert.ok(renderAllSource.startsWith('async function renderAll('), 'renderAll 必须返回可等待的 Promise')
  assert.ok(/Promise\.all(?:Settled)?\s*\(/.test(renderAllSource), 'renderAll 必须等待所有面板加载完成')

  console.log('admin-live-data-integrity-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
