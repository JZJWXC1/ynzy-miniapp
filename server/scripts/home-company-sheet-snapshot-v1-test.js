const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repoRoot = path.join(__dirname, '..', '..')
const indexPath = path.join(repoRoot, 'pages', 'index', 'index.js')
const apiServicePath = path.join(repoRoot, 'utils', 'api-service.js')
const indexSource = fs.readFileSync(indexPath, 'utf8')
const apiServiceSource = fs.readFileSync(apiServicePath, 'utf8')

const FIXED_HEADERS = [
  '行政区',
  '板块/商圈',
  '小区',
  '小区+房号',
  '户型描述',
  '户型分类',
  '月租金',
  '看房方式',
  '备注',
  '房源状态'
]
const MAX_SAFE_CANVAS_EDGE_PX = 4096
const MAX_SAFE_PIXEL_RATIO = 2
const MAX_SAFE_LISTING_ROWS = 37

function snapshot(rows, overrides) {
  return Object.assign({
    title: '寓你住一起房源表',
    updatedAt: '2026-07-26 10:00:00',
    rows,
    rowCount: rows.length,
    columnCount: 10,
    sourceMode: 'feishu-mini-mirror-v1',
    schemaVersion: 1,
    sensitiveStripped: true
  }, overrides || {})
}

function listingRow(overrides) {
  const values = Object.assign({
    district: '拱墅区',
    block: '祥符',
    community: '棠润府',
    roomLabel: '棠润府 1幢101',
    layoutDescription: '两室一厅整租',
    layoutCategory: '两室',
    monthlyRent: '3200',
    viewingMethod: '密码',
    remark: '公开备注',
    listingStatus: '即将空出'
  }, overrides || {})
  return [
    values.district,
    values.block,
    values.community,
    values.roomLabel,
    values.layoutDescription,
    values.layoutCategory,
    values.monthlyRent,
    values.viewingMethod,
    values.remark,
    values.listingStatus
  ]
}

function setAtPath(target, key, value) {
  const parts = String(key).split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current[parts[index]] || typeof current[parts[index]] !== 'object') current[parts[index]] = {}
    current = current[parts[index]]
  }
  current[parts[parts.length - 1]] = value
}

function makePage(definition) {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function canvasContext() {
  return {
    scale() {},
    fillRect() {},
    strokeRect() {},
    fillText() {}
  }
}

function loadIndexPage(apiStub, runtime) {
  let pageDefinition = null
  const state = runtime || {}
  state.drawCellTextCalls = []
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return canvasContext()
    }
  }
  const wxStub = {
    showShareMenu() {},
    showToast() {},
    showModal() {},
    openSetting() {},
    hideKeyboard() {},
    vibrateShort() {},
    previewImage() {},
    showShareImageMenu() {},
    saveImageToPhotosAlbum() {},
    getWindowInfo() {
      return { pixelRatio: 2 }
    },
    createSelectorQuery() {
      return {
        in() { return this },
        select() { return this },
        fields() { return this },
        exec(callback) {
          callback([{ node: canvas, width: 640, height: 480 }])
        }
      }
    },
    canvasToTempFilePath(options) {
      state.canvasCalls = Number(state.canvasCalls || 0) + 1
      if (state.canvasShouldFail === true) {
        options.fail({ errMsg: 'synthetic canvas failure' })
        return
      }
      options.success({ tempFilePath: `/tmp/company-sheet-${state.canvasCalls}.png` })
    }
  }
  const sandbox = {
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setImmediate,
    globalThis: null,
    __drawCellTextCalls: state.drawCellTextCalls,
    wx: wxStub,
    Page(definition) {
      pageDefinition = definition
    },
    require(request) {
      if (request === '../../utils/api-service') return apiStub
      if (request === '../../utils/api-client') {
        return {
          getAuthSessionKey() { return 'guest-home-sheet-test' },
          getAuthToken() { return '' },
          subscribeAuthInvalidation() { return function unsubscribe() {} },
          isPublicReadAuthFallbackContinuation() { return false }
        }
      }
      if (request === '../../utils/voice-input') {
        return {
          createController() {
            return {
              isBusy() { return false },
              release() {}
            }
          },
          errorMessage(error, fallback) { return fallback || String(error || '') }
        }
      }
      if (request === '../../utils/listing-cover-state') {
        return { findFailedCoverIndex() { return -1 } }
      }
      if (request === '../../utils/pending-filter-storage') {
        return { createPendingFilterEnvelope(value) { return value } }
      }
      throw new Error(`首页快照测试出现未声明依赖：${request}`)
    }
  }
  sandbox.globalThis = sandbox
  const drawCellTextSignature = 'function drawCellText(ctx, text, left, top, width, height, options = {}) {'
  assert.ok(indexSource.includes(drawCellTextSignature), '首页测试必须能注入 drawCellText 行为记录器')
  const instrumentedIndexSource = indexSource.replace(
    drawCellTextSignature,
    `${drawCellTextSignature}
  globalThis.__drawCellTextCalls.push({
    text: String(text || ''),
    maxLines: options.maxLines || 2
  })`
  )
  vm.runInNewContext(
    `${instrumentedIndexSource}
globalThis.__homeSheetAudit = {
  buildSheetModel,
  buildSheetPreview,
  buildSnapshotMetrics,
  snapshotViewState
}`,
    sandbox,
    { filename: indexPath }
  )
  assert.ok(pageDefinition, '必须捕获首页 Page 配置')
  return {
    page: makePage(pageDefinition),
    helpers: sandbox.__homeSheetAudit,
    state
  }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function settle() {
  await flushPromises()
  await flushPromises()
}

function defaultApi(overrides) {
  return Object.assign({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, listingRow()]))
    },
    getTodayTasks() {
      return Promise.resolve({ tasks: [], summary: { pendingCount: 0, updatedAt: '' } })
    },
    getHomeListings() {
      return Promise.resolve([])
    }
  }, overrides || {})
}

function testFixedTenColumnModel() {
  const loaded = loadIndexPage(defaultApi(), {})
  const rows = [
    FIXED_HEADERS,
    listingRow(),
    listingRow({
      community: '万融城运河印',
      roomLabel: '万融城运河印 2幢202',
      listingStatus: '待出租'
    }),
    listingRow({
      block: '东新园',
      community: '长岳王马府',
      roomLabel: '长岳王马府 3幢303',
      layoutDescription: '一室一厅整租',
      layoutCategory: '一室',
      monthlyRent: '2800',
      viewingMethod: '联系房东',
      remark: '',
      listingStatus: '待出租'
    })
  ]
  const model = loaded.helpers.buildSheetModel(snapshot(rows))
  assert.deepStrictEqual(Array.from(model.header), FIXED_HEADERS, '首页必须逐列识别服务端固定十列表头')
  assert.strictEqual(model.listingCount, 3, '固定十列表头不得被误计为房源')
  assert.deepStrictEqual(Array.from(model.dataRows[0].cells), rows[1], '行政区到房源状态十列不得串位')
  assert.strictEqual(model.districtCol, 0, '行政区必须是第一级分组')
  assert.strictEqual(model.blockCol, 1, '板块/商圈必须是第二级分组')
  assert.strictEqual(model.communityCol, 2, '小区必须是第三级分组')
  assert.deepStrictEqual(Array.from(model.groupColumns), [0, 1, 2], '首页图片必须按行政区/板块/小区三级合并')
  assert.deepStrictEqual(
    Array.from(model.maxLines),
    [1, 1, 1, 2, 2, 1, 1, 1, 2, 1],
    '换行规则必须绑定字段角色，不能继续写死旧列号'
  )
  const blockSpans = model.spans.filter((item) => item.colIndex === 1)
  assert.strictEqual(blockSpans.length, 2, '同一行政区下两个板块必须形成两个独立合并区')
  assert.strictEqual(blockSpans[0].count, 2, '祥符板块应合并连续两套房源')
  assert.strictEqual(blockSpans[1].count, 1, '东新园板块不得并入祥符')
}

async function testDrawUsesFieldRoleLineLimits() {
  const sourceRow = listingRow({
    district: '拱墅区绘制断言',
    block: '祥符绘制断言',
    community: '棠润府绘制断言',
    roomLabel: '棠润府绘制断言 1幢1单元101室',
    layoutDescription: '两室一厅整租绘制断言',
    layoutCategory: '两室绘制断言',
    monthlyRent: '3200绘制断言',
    viewingMethod: '密码看房绘制断言',
    remark: '公开备注绘制断言',
    listingStatus: '即将空出绘制断言'
  })
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, sourceRow]))
    }
  }), {})
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()

  const callByText = new Map(loaded.state.drawCellTextCalls.map((call) => [call.text, call]))
  ;[
    sourceRow[3],
    sourceRow[4],
    sourceRow[8]
  ].forEach((text) => {
    assert.strictEqual(callByText.get(text) && callByText.get(text).maxLines, 2, `${text} 必须真实按两行规则绘制`)
  })
  ;[
    sourceRow[5],
    sourceRow[6],
    sourceRow[7],
    sourceRow[9]
  ].forEach((text) => {
    assert.strictEqual(callByText.get(text) && callByText.get(text).maxLines, 1, `${text} 必须真实按单行规则绘制`)
  })
}

async function testCanvasSizeBoundaryFailsClosed() {
  const safeRows = Array.from({ length: MAX_SAFE_LISTING_ROWS }, (_, index) => listingRow({
    community: `安全小区${index + 1}`,
    roomLabel: `安全小区${index + 1} ${index + 1}幢101`,
    remark: `公开备注${index + 1}`
  }))
  const loaded = loadIndexPage(defaultApi(), {})
  const safeState = loaded.helpers.snapshotViewState(snapshot([FIXED_HEADERS, ...safeRows]))
  assert.strictEqual(safeState.shouldRender, true, '生产允许的最大 37 条房源必须仍可生成首页图片')
  assert.ok(safeState.metrics, '安全边界内必须返回画布尺寸')
  assert.ok(
    safeState.metrics.width * MAX_SAFE_PIXEL_RATIO <= MAX_SAFE_CANVAS_EDGE_PX &&
      safeState.metrics.height * MAX_SAFE_PIXEL_RATIO <= MAX_SAFE_CANVAS_EDGE_PX,
    '最大允许行数在 2 倍像素下不得超过微信兼容画布单边'
  )

  const privateSentinel = 'PRIVATE_EXTRA_COLUMN_MUST_NOT_RENDER'
  const oversizedRows = safeRows.concat([
    listingRow({
      community: '超限小区',
      roomLabel: '超限小区 38幢101',
      remark: '超限公开备注'
    })
  ])
  const oversizedState = loaded.helpers.snapshotViewState(snapshot([FIXED_HEADERS, ...oversizedRows]))
  assert.strictEqual(oversizedState.shouldRender, false, '第 38 条房源使画布超限时必须 fail-closed，不得继续截图')
  assert.strictEqual(oversizedState.status, '房源表内容较多，暂不生成图片')
  assert.strictEqual(oversizedState.metrics, null, '超限快照不得把不可用的大画布尺寸交给页面')
  const oversizedPage = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, ...oversizedRows]))
    }
  }), {})
  oversizedPage.page._pageActive = true
  oversizedPage.page.onShow()
  await settle()
  assert.strictEqual(oversizedPage.state.canvasCalls || 0, 0, '超限快照不得调用 canvasToTempFilePath')
  assert.strictEqual(oversizedPage.state.drawCellTextCalls.length, 0, '超限快照不得进入任何单元格绘制')
  assert.strictEqual(oversizedPage.page.data.sheetSnapshotStatus, '房源表内容较多，暂不生成图片')

  const sensitiveSchemaState = loaded.helpers.snapshotViewState(snapshot([
    FIXED_HEADERS.concat(['内部负责人']),
    listingRow().concat([privateSentinel])
  ], {
    rowCount: 2,
    columnCount: 11
  }))
  assert.strictEqual(sensitiveSchemaState.shouldRender, false, '出现契约外字段时必须 fail-closed')
  assert.ok(!JSON.stringify(sensitiveSchemaState.preview).includes(privateSentinel), '额外敏感列不得进入首页预览')
  const sensitivePage = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([
        FIXED_HEADERS.concat(['内部负责人']),
        listingRow().concat([privateSentinel])
      ], {
        rowCount: 2,
        columnCount: 11
      }))
    }
  }), {})
  sensitivePage.page._pageActive = true
  sensitivePage.page.onShow()
  await settle()
  assert.strictEqual(sensitivePage.state.canvasCalls || 0, 0, '契约外敏感列出现时不得调用 canvasToTempFilePath')
  assert.strictEqual(sensitivePage.state.drawCellTextCalls.length, 0, '契约外敏感列出现时不得进入绘制')
}

async function testMalformedSourceRowsFailClosed() {
  const validRow = listingRow({
    community: '完整十列小区',
    roomLabel: '完整十列小区 1幢101'
  })
  const nonArrayRow = Object.assign(
    { length: FIXED_HEADERS.length },
    listingRow({
      community: '非数组伪行小区',
      roomLabel: '非数组伪行小区 2幢202'
    })
  )
  const cases = [
    {
      label: '九列短行',
      rows: [FIXED_HEADERS, validRow, listingRow().slice(0, FIXED_HEADERS.length - 1)]
    },
    {
      label: '非数组数据行',
      rows: [FIXED_HEADERS, validRow, nonArrayRow]
    }
  ]
  const actual = []

  for (const testCase of cases) {
    const malformedSnapshot = snapshot(testCase.rows)
    const runtime = {}
    const loaded = loadIndexPage(defaultApi({
      getCompanySheetSnapshot() {
        return Promise.resolve(malformedSnapshot)
      }
    }), runtime)
    const viewState = loaded.helpers.snapshotViewState(malformedSnapshot)
    loaded.page._pageActive = true
    loaded.page.onShow()
    await settle()
    actual.push({
      label: testCase.label,
      shouldRender: viewState.shouldRender,
      listingCount: viewState.preview.listingCount,
      status: viewState.status,
      canvasCalls: runtime.canvasCalls || 0,
      drawCalls: runtime.drawCellTextCalls.length
    })
  }

  assert.deepStrictEqual(actual, cases.map((testCase) => ({
    label: testCase.label,
    shouldRender: false,
    listingCount: 0,
    status: '房源表数据格式待更新',
    canvasCalls: 0,
    drawCalls: 0
  })), '固定十列契约下任一短行或非数组行都必须整份 fail-closed，且不得进入画布绘制')
}

function testSnapshotEmptyStates() {
  const loaded = loadIndexPage(defaultApi(), {})
  const headerOnly = loaded.helpers.snapshotViewState(snapshot([FIXED_HEADERS]))
  assert.strictEqual(headerOnly.shouldRender, false, '只有表头时不得生成可转发空图')
  assert.strictEqual(headerOnly.status, '当前暂无待租房源')
  assert.strictEqual(headerOnly.preview.listingCount, 0)

  const unavailable = loaded.helpers.snapshotViewState(snapshot([FIXED_HEADERS], {
    unavailable: true,
    updatedAt: ''
  }))
  assert.strictEqual(unavailable.shouldRender, false, '服务端明确 unavailable 时不得生成空图')
  assert.strictEqual(unavailable.status, '房源表暂未同步')

  const unknownSchema = loaded.helpers.snapshotViewState(snapshot([
    FIXED_HEADERS,
    listingRow()
  ], {
    schemaVersion: 2
  }))
  assert.strictEqual(unknownSchema.shouldRender, false, '未知 schema 必须 fail-closed，不能按列位置猜测')
  assert.strictEqual(unknownSchema.status, '房源表数据格式待更新')
  assert.strictEqual(unknownSchema.preview.listingCount, 0, '未知 schema 不得把任何行展示为房源')
}

async function testRequestFailureRetriesImmediately() {
  let calls = 0
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('synthetic request failure'))
      return Promise.resolve(snapshot([FIXED_HEADERS, listingRow()]))
    }
  }), {})
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()
  assert.strictEqual(calls, 1)
  assert.strictEqual(loaded.page.data.sheetSnapshotStatus, '房源表图片加载失败')

  loaded.page.onShow()
  await settle()
  assert.strictEqual(calls, 2, '请求失败后的下一次 onShow 必须立即重试，不能被 60 秒任务节流卡住')
  assert.ok(loaded.page.data.sheetSnapshotImagePath, '重试成功后必须真实生成图片路径')
}

async function testCanvasFailureRetriesImmediately() {
  let calls = 0
  const runtime = { canvasShouldFail: true }
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      calls += 1
      return Promise.resolve(snapshot([FIXED_HEADERS, listingRow()]))
    }
  }), runtime)
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()
  assert.strictEqual(loaded.page.data.sheetSnapshotStatus, '图片生成失败，请重试')
  assert.strictEqual(loaded.page.data.sheetSnapshotImagePath, '')

  runtime.canvasShouldFail = false
  loaded.page.onShow()
  await settle()
  assert.strictEqual(calls, 2, '画布失败后的下一次 onShow 必须重新取快照并生成图片')
  assert.strictEqual(runtime.canvasCalls, 2)
  assert.ok(loaded.page.data.sheetSnapshotImagePath)
}

async function testLateResponseCannotOverwrite() {
  const requests = [deferred(), deferred()]
  let callIndex = 0
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      const request = requests[callIndex]
      callIndex += 1
      return request.promise
    }
  }), {})
  loaded.page._pageActive = true
  loaded.page.loadCompanySheetSnapshot()
  loaded.page.loadCompanySheetSnapshot()
  requests[1].resolve(snapshot([
    FIXED_HEADERS,
    listingRow({ block: '东新园', community: '长岳王马府', roomLabel: '长岳王马府 3幢303' })
  ]))
  await settle()
  requests[0].resolve(snapshot([
    FIXED_HEADERS,
    listingRow({ block: '祥符', community: '旧响应小区', roomLabel: '旧响应小区 1幢101' })
  ]))
  await settle()
  assert.strictEqual(loaded.page.data.companySheetSnapshot.rows[1][1], '东新园', '迟到旧响应不得覆盖新快照')
  assert.strictEqual(loaded.page.data.sheetPreview.listingCount, 1)
}

function testRuntimeBrandingAndMockParity() {
  assert.ok(
    !/['"`][^'"`]*飞书[^'"`]*['"`]/.test(indexSource),
    '首页运行时文案不得暴露飞书来源'
  )
  assert.ok(/columnCount:\s*10/.test(apiServiceSource), 'Mock 快照必须与生产固定十列一致')
  assert.ok(/sourceMode:\s*['"]feishu-mini-mirror-v1['"]/.test(apiServiceSource), 'Mock 必须带固定来源契约')
  assert.ok(/schemaVersion:\s*1/.test(apiServiceSource), 'Mock 必须带固定 schemaVersion')
}

async function main() {
  testFixedTenColumnModel()
  await testDrawUsesFieldRoleLineLimits()
  await testCanvasSizeBoundaryFailsClosed()
  await testMalformedSourceRowsFailClosed()
  testSnapshotEmptyStates()
  await testRequestFailureRetriesImmediately()
  await testCanvasFailureRetriesImmediately()
  await testLateResponseCannotOverwrite()
  testRuntimeBrandingAndMockParity()
  console.log('home-company-sheet-snapshot-v1-test passed')
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
