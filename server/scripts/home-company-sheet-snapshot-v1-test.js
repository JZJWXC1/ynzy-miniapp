const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const repoRoot = path.join(__dirname, '..', '..')
const indexPath = path.join(repoRoot, 'pages', 'index', 'index.js')
const indexWxmlPath = path.join(repoRoot, 'pages', 'index', 'index.wxml')
const apiServicePath = path.join(repoRoot, 'utils', 'api-service.js')
const indexSource = fs.readFileSync(indexPath, 'utf8')
const indexWxmlSource = fs.readFileSync(indexWxmlPath, 'utf8')
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

function makePage(definition, runtime) {
  const page = Object.assign({}, definition)
  const state = runtime || {}
  state.setDataPatches = state.setDataPatches || []
  page.data = JSON.parse(JSON.stringify(definition.data || {}))
  page.setData = function setData(patch, callback) {
    state.setDataPatches.push(Object.assign({}, patch || {}))
    Object.keys(patch || {}).forEach((key) => setAtPath(page.data, key, patch[key]))
    if (typeof callback === 'function') callback()
  }
  return page
}

function canvasContext(state) {
  state.contextCalls = Number(state.contextCalls || 0) + 1
  state.fillTexts = state.fillTexts || []
  if (Number(state.drawFailAt || 0) === state.contextCalls) {
    throw new Error('synthetic draw failure')
  }
  return {
    scale() {},
    fillRect() {},
    strokeRect() {},
    fillText(text) {
      state.fillTexts.push(String(text || ''))
    }
  }
}

function loadIndexPage(apiStub, runtime) {
  let pageDefinition = null
  const state = runtime || {}
  state.drawCellTextCalls = []
  state.previewCalls = state.previewCalls || []
  state.shareCalls = state.shareCalls || []
  state.saveCalls = state.saveCalls || []
  state.saveCallbacks = state.saveCallbacks || []
  state.canvasCallbacks = state.canvasCallbacks || []
  state.canvasExports = state.canvasExports || []
  state.toasts = state.toasts || []
  state.modals = state.modals || []
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return canvasContext(state)
    }
  }
  const wxStub = {
    showShareMenu() {},
    showToast(options) {
      state.toasts.push(Object.assign({}, options || {}))
    },
    showModal(options) {
      state.modals.push(Object.assign({}, options || {}))
    },
    openSetting() {},
    hideKeyboard() {},
    vibrateShort() {},
    previewImage(options) {
      state.previewCalls.push({
        current: options && options.current,
        urls: Array.from((options && options.urls) || [])
      })
    },
    showShareImageMenu(options) {
      state.shareCalls.push(Object.assign({}, options || {}))
    },
    saveImageToPhotosAlbum(options) {
      const callIndex = state.saveCalls.length
      state.saveCalls.push(options && options.filePath)
      if (state.deferSaves === true) {
        state.saveCallbacks.push(options)
        return
      }
      if ((state.saveFailIndexes || []).includes(callIndex)) {
        options.fail({ errMsg: 'synthetic save failure' })
        return
      }
      options.success({})
    },
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
      state.canvasExports.push({
        width: options.destWidth,
        height: options.destHeight,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
      })
      if (state.deferCanvasExports === true) {
        state.canvasCallbacks.push(options)
        return
      }
      if (state.canvasShouldFail === true || Number(state.canvasFailAt || 0) === state.canvasCalls) {
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
  buildSnapshotPages,
  snapshotMetricsFitCanvas,
  snapshotViewState
}`,
    sandbox,
    { filename: indexPath }
  )
  assert.ok(pageDefinition, '必须捕获首页 Page 配置')
  return {
    page: makePage(pageDefinition, state),
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

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await flushPromises()
  }
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

function listingRows(count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const label = `${prefix || '分页小区'}${number}`
    return listingRow({
      district: number > 37 ? '余杭区' : '拱墅区',
      block: number > 37 ? '未来科技城' : '祥符',
      community: label,
      roomLabel: `${label} ${number}幢${String(number).padStart(3, '0')}`,
      remark: `公开备注${number}`
    })
  })
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

function testCanvasPaginationBoundaries() {
  const loaded = loadIndexPage(defaultApi(), {})
  const cases = [
    { count: 1, pageRows: [1] },
    { count: 37, pageRows: [37] },
    { count: 38, pageRows: [37, 1] },
    { count: 46, pageRows: [37, 9] },
    { count: 74, pageRows: [37, 37] },
    { count: 75, pageRows: [37, 37, 1] }
  ]

  cases.forEach((testCase) => {
    const sourceRows = listingRows(testCase.count, `边界${testCase.count}-`)
    if (sourceRows.length > MAX_SAFE_LISTING_ROWS) {
      sourceRows[MAX_SAFE_LISTING_ROWS][8] = '第二页独有的较长公开备注用于锁定所有分页列宽完全一致'
    }
    const sourceSnapshot = snapshot([FIXED_HEADERS, ...sourceRows])
    const viewState = loaded.helpers.snapshotViewState(sourceSnapshot)
    assert.strictEqual(viewState.shouldRender, true, `${testCase.count} 套房源必须可以生成完整多页图片`)
    assert.strictEqual(viewState.pages.length, testCase.pageRows.length, `${testCase.count} 套分页数错误`)
    assert.deepStrictEqual(
      Array.from(viewState.pages, (page) => page.model.dataRows.length),
      testCase.pageRows,
      `${testCase.count} 套必须稳定按 37 条一页切分`
    )
    const flattened = viewState.pages.flatMap((page) => {
      assert.deepStrictEqual(Array.from(page.model.header), FIXED_HEADERS, '每一页都必须重复固定十列表头')
      assert.deepStrictEqual(
        Array.from(page.metrics.columnWidths),
        Array.from(viewState.pages[0].metrics.columnWidths),
        '同一组图片的所有分页必须使用完全相同的十列宽度'
      )
      assert.ok(
        loaded.helpers.snapshotMetricsFitCanvas(page.metrics, MAX_SAFE_PIXEL_RATIO),
        '每一页在 2 倍像素下都必须落在微信 4096px 物理边界内'
      )
      assert.ok(
        page.metrics.width * MAX_SAFE_PIXEL_RATIO <= MAX_SAFE_CANVAS_EDGE_PX &&
          page.metrics.height * MAX_SAFE_PIXEL_RATIO <= MAX_SAFE_CANVAS_EDGE_PX,
        '分页后的实际物理宽高不得超过 4096px'
      )
      return page.model.dataRows.map((row) => row.cells[3])
    })
    assert.deepStrictEqual(
      Array.from(flattened),
      sourceRows.map((row) => row[3]),
      `${testCase.count} 套分页后必须零漏、零重且顺序不变`
    )
  })
}

async function testPaginationKeepsFixedTenColumnPrivacyBoundary() {
  const loaded = loadIndexPage(defaultApi(), {})
  const privateSentinel = 'PRIVATE_EXTRA_COLUMN_MUST_NOT_RENDER'
  const sensitiveSnapshot = snapshot([
    FIXED_HEADERS.concat(['内部负责人']),
    listingRow().concat([privateSentinel])
  ], {
    rowCount: 2,
    columnCount: 11
  })
  const sensitiveSchemaState = loaded.helpers.snapshotViewState(sensitiveSnapshot)
  assert.strictEqual(sensitiveSchemaState.shouldRender, false, '出现契约外字段时必须 fail-closed')
  assert.strictEqual(sensitiveSchemaState.pages.length, 0, '契约外字段不得生成任何分页')
  assert.ok(!JSON.stringify(sensitiveSchemaState.preview).includes(privateSentinel), '额外敏感列不得进入首页预览')
  const sensitivePage = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(sensitiveSnapshot)
    }
  }), {})
  sensitivePage.page._pageActive = true
  sensitivePage.page.onShow()
  await settle()
  assert.strictEqual(sensitivePage.state.canvasCalls || 0, 0, '契约外敏感列出现时不得调用 canvasToTempFilePath')
  assert.strictEqual(sensitivePage.state.drawCellTextCalls.length, 0, '契约外敏感列出现时不得进入绘制')
}

async function testAllPagesRenderPreviewAndCurrentPageShare() {
  const rows = listingRows(46, '操作小区')
  const runtime = {}
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, ...rows]))
    }
  }), runtime)
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()

  assert.strictEqual(runtime.canvasCalls, 2, '46 套必须真实绘制 37+9 两张图片')
  assert.deepStrictEqual(
    Array.from(loaded.page.data.sheetSnapshotImagePaths),
    ['/tmp/company-sheet-1.png', '/tmp/company-sheet-2.png'],
    '全部分页都成功后才发布完整图片集合'
  )
  assert.strictEqual(loaded.page.data.sheetSnapshotPageCount, 2)
  assert.strictEqual(loaded.page.data.sheetSnapshotCurrentPage, 0)
  assert.strictEqual(loaded.page.data.sheetSnapshotImagePath, '/tmp/company-sheet-1.png')
  assert.strictEqual(runtime.fillTexts.filter((text) => text === '行政区').length, 2, '每张实际图片都必须重复十列表头')
  runtime.canvasExports.forEach((item) => {
    assert.ok(item.width <= MAX_SAFE_CANVAS_EDGE_PX && item.height <= MAX_SAFE_CANVAS_EDGE_PX, '每张实际导出图片必须遵守 4096px 物理边界')
  })

  loaded.page.previewCompanySheetSnapshot()
  assert.deepStrictEqual(runtime.previewCalls[0], {
    current: '/tmp/company-sheet-1.png',
    urls: ['/tmp/company-sheet-1.png', '/tmp/company-sheet-2.png']
  }, '查看大图必须一次预览全部分页')

  loaded.page.changeCompanySheetPage({ currentTarget: { dataset: { step: 1 } } })
  assert.strictEqual(loaded.page.data.sheetSnapshotCurrentPage, 1, '分页控件必须能切换当前页')
  assert.strictEqual(loaded.page.data.sheetSnapshotImagePath, '/tmp/company-sheet-2.png')
  loaded.page.previewCompanySheetSnapshot()
  assert.deepStrictEqual(runtime.previewCalls[1], {
    current: '/tmp/company-sheet-2.png',
    urls: ['/tmp/company-sheet-1.png', '/tmp/company-sheet-2.png']
  }, '切页后预览仍须包含全部页，并从当前页打开')
  loaded.page.shareCompanySheetSnapshot()
  assert.strictEqual(runtime.shareCalls.length, 1)
  assert.strictEqual(runtime.shareCalls[0].path, '/tmp/company-sheet-2.png', '图片转发必须只使用用户当前页')

  assert.ok(/bindtap="changeCompanySheetPage"/.test(indexWxmlSource), '首页必须提供可操作的分页控件')
  assert.ok(/disabled="\{\{sheetSnapshotDownloading\}\}"/.test(indexWxmlSource), '下载按钮必须在进行中禁用')
}

async function testAnyPageDrawFailureRejectsWholeGroup() {
  const runtime = { drawFailAt: 2 }
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, ...listingRows(46, '绘图失败小区')]))
    }
  }), runtime)
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()

  assert.strictEqual(runtime.canvasCalls, 1, '第二页绘图失败前只允许第一张图片完成导出')
  assert.deepStrictEqual(Array.from(loaded.page.data.sheetSnapshotImagePaths || []), [], '任一页失败不得发布部分图片')
  assert.strictEqual(loaded.page.data.sheetSnapshotImagePath, '', '任一页失败必须清空旧的单页兼容路径')
  assert.strictEqual(loaded.page.data.sheetSnapshotStatus, '图片生成失败，请重试')
  assert.strictEqual(loaded.page._sheetSnapshotLoadedAt, 0, '整组失败后下次进入必须立即重试')
}

async function testSequentialDownloadProgressGuardAndPartialFailure() {
  const runtime = {}
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, ...listingRows(75, '下载小区')]))
    }
  }), runtime)
  loaded.page._pageActive = true
  loaded.page.onShow()
  await settle()
  assert.strictEqual(loaded.page.data.sheetSnapshotImagePaths.length, 3, '75 套必须先完整生成三页')

  runtime.deferSaves = true
  loaded.page.saveCompanySheetSnapshot()
  loaded.page.saveCompanySheetSnapshot()
  assert.deepStrictEqual(runtime.saveCalls, ['/tmp/company-sheet-1.png'], '下载必须串行，首张完成前不得并发保存后续页')
  assert.ok(runtime.toasts.some((item) => item.title === '正在下载，请稍候'), '重复点击必须给出进行中提示')

  runtime.saveCallbacks[0].success({})
  await settle()
  assert.deepStrictEqual(
    runtime.saveCalls,
    ['/tmp/company-sheet-1.png', '/tmp/company-sheet-2.png'],
    '第一张完成后才能开始第二张'
  )
  runtime.saveCallbacks[1].fail({ errMsg: 'synthetic save failure' })
  await settle()
  assert.deepStrictEqual(
    runtime.saveCalls,
    ['/tmp/company-sheet-1.png', '/tmp/company-sheet-2.png', '/tmp/company-sheet-3.png'],
    '中间页失败后仍须继续串行保存剩余页'
  )
  runtime.saveCallbacks[2].success({})
  await settle()

  assert.strictEqual(loaded.page.data.sheetSnapshotDownloading, false, '全部尝试完成后必须解除防双击状态')
  assert.strictEqual(loaded.page.data.sheetSnapshotDownloadProgress, '已保存 2/3 张，1 张失败', '部分失败结果必须准确汇总')
  const progressValues = runtime.setDataPatches
    .map((patch) => patch.sheetSnapshotDownloadProgress)
    .filter(Boolean)
  assert.ok(progressValues.includes('正在保存 1/3'), '下载必须显示第一页进度')
  assert.ok(progressValues.includes('正在保存 2/3'), '下载必须显示第二页进度')
  assert.ok(progressValues.includes('正在保存 3/3'), '下载必须显示第三页进度')
  assert.ok(runtime.toasts.some((item) => item.title === '已保存 2/3 张，1 张失败'), '部分失败必须向用户明确提示')
}

async function testRenderRaceAndUnloadAreSafe() {
  const snapshots = [
    snapshot([FIXED_HEADERS, ...listingRows(38, '旧批次小区')]),
    snapshot([FIXED_HEADERS, listingRow({
      block: '东新园',
      community: '最新批次小区',
      roomLabel: '最新批次小区 1幢101'
    })])
  ]
  let callIndex = 0
  const runtime = { deferCanvasExports: true }
  const loaded = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      const value = snapshots[callIndex]
      callIndex += 1
      return Promise.resolve(value)
    }
  }), runtime)
  loaded.page._pageActive = true
  loaded.page.loadCompanySheetSnapshot()
  await settle()
  assert.strictEqual(runtime.canvasCallbacks.length, 1, '旧批次第一页应进入导出')

  loaded.page.loadCompanySheetSnapshot()
  await settle()
  assert.strictEqual(runtime.canvasCallbacks.length, 1, '新批次必须等待共享 Canvas 上的旧导出回调收敛')
  runtime.canvasCallbacks[0].success({ tempFilePath: '/tmp/stale-page.png' })
  await settle()
  assert.strictEqual(runtime.canvasCallbacks.length, 2, '旧导出收敛后才允许新批次开始绘制')
  runtime.canvasCallbacks[1].success({ tempFilePath: '/tmp/latest-page.png' })
  await settle()

  assert.strictEqual(runtime.canvasCalls, 2, '旧批次变陈旧后不得继续绘制它的第二页')
  assert.strictEqual(loaded.page.data.companySheetSnapshot.rows[1][2], '最新批次小区')
  assert.deepStrictEqual(Array.from(loaded.page.data.sheetSnapshotImagePaths), ['/tmp/latest-page.png'], '最终只能发布最新请求的完整图片集合')

  const unloadRuntime = { deferCanvasExports: true }
  const unloadPage = loadIndexPage(defaultApi({
    getCompanySheetSnapshot() {
      return Promise.resolve(snapshot([FIXED_HEADERS, ...listingRows(46, '卸载小区')]))
    }
  }), unloadRuntime)
  unloadPage.page._pageActive = true
  unloadPage.page.loadCompanySheetSnapshot()
  await settle()
  assert.strictEqual(unloadRuntime.canvasCallbacks.length, 1)
  unloadPage.page.onUnload()
  const patchCountAtUnload = unloadRuntime.setDataPatches.length
  unloadRuntime.canvasCallbacks[0].success({ tempFilePath: '/tmp/after-unload.png' })
  await settle()
  assert.strictEqual(unloadRuntime.canvasCalls, 1, '页面卸载后不得继续绘制剩余分页')
  assert.strictEqual(unloadRuntime.setDataPatches.length, patchCountAtUnload, '页面卸载后的异步回调不得再写页面状态')
  assert.deepStrictEqual(Array.from(unloadPage.page.data.sheetSnapshotImagePaths || []), [], '页面卸载后不得发布临时图片')
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
  testCanvasPaginationBoundaries()
  await testPaginationKeepsFixedTenColumnPrivacyBoundary()
  await testAllPagesRenderPreviewAndCurrentPageShare()
  await testAnyPageDrawFailureRejectsWholeGroup()
  await testSequentialDownloadProgressGuardAndPartialFailure()
  await testRenderRaceAndUnloadAreSafe()
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
