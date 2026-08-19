const assert = require('assert')
const fs = require('fs')
const path = require('path')

// 需求：敏感查看足迹「查看人/房源(小区)」下拉候选，在真实分页 API 路径下也要能初始化。
// 背景(Codex P1)：renderAdminLogs 恒发 `?page=1&pageSize=50`，后端 FOOTPRINT_QUERY_KEYS 含 page/pageSize，
// 首屏也被判为 query → 返回分页对象(isPaged=true)，故不能只在 !isPaged 时重建候选，否则下拉永远为空。
// 本测试提取 admin-web 的足迹函数簇，用 mock DOM + mock getAdminData 驱动真实代码，锁定：
//   ① 表格请求(带分页)返回分页对象时，下拉仍能填出候选(来自不带分页参数的独立全量请求，含仅在全量集里的项)；
//   ② 候选用 textContent 构造(防注入)；③ 候选缓存只拉一次、后续渲染复用。

const htmlPath = path.join(__dirname, '..', '..', 'admin-web', 'index.html')
const source = fs.readFileSync(htmlPath, 'utf8')

// 提取「footprintPage 声明 → renderAdminLogs 结束(getLocalReportRows 前)」的连续函数簇。
const startMarker = 'let footprintPage = 1;'
const endMarker = 'function getLocalReportRows'
const startIdx = source.indexOf(startMarker)
const endIdx = source.indexOf(endMarker)
assert.ok(startIdx > 0 && endIdx > startIdx, '未能定位足迹函数簇，标记可能已变，请同步更新本测试')
const cluster = source.slice(startIdx, endIdx)

// 断言簇里确实包含关键函数与「不带分页参数取全量」的候选源请求（防止有人把修复删回旧逻辑）。
assert.ok(/function ensureFootprintFilterOptions/.test(cluster), '缺少 ensureFootprintFilterOptions')
assert.ok(/getAdminData\('\/admin\/footprints'/.test(cluster), '缺少不带分页参数的 /admin/footprints 候选源请求')
assert.ok(/\.textContent = value/.test(cluster), '下拉选项应以 textContent 构造(防注入)')

// ---- mock DOM ----
function makeSelect() {
  return {
    value: '',
    options: [{ value: '', textContent: '全部' }],
    remove(i) { this.options.splice(i, 1) },
    appendChild(o) { this.options.push(o) }
  }
}
function makeEl() {
  return { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, style: {} }
}
const SELECT_IDS = new Set(['footprintViewer', 'footprintKeyword', 'footprintAction'])
const els = {}
const documentMock = {
  getElementById(id) {
    if (!els[id]) els[id] = SELECT_IDS.has(id) ? makeSelect() : makeEl()
    return els[id]
  },
  // createElement('option') 只给 value/textContent（无 innerHTML）：若代码误用 innerHTML 赋值会静默丢失，
  // 从而断言拿不到期望文本——反向保证走的是 textContent。
  createElement() { return { value: '', textContent: '' } }
}

// ---- mock 数据：分页 payload(表格) vs 全量数组(候选源) ----
const XSS_NAME = '<img src=x onerror=alert(1)>'
// 全量集含「仅在全量里、不在首屏页」的查看人/房源，用来证明候选来自全量而非当前页。
const FULL_ARRAY = [
  { viewer: '吴志坚', listing: '西文南苑', action: '修正地图坐标' },
  { viewer: '张敏', listing: '婉秋铭府', action: '飞书同步下架' },
  { viewer: '李明', listing: '翰皋名府', action: '转发房间视频给租客' },
  { viewer: XSS_NAME, listing: '兴业杨家府', action: '记录带看' },
  { viewer: '', user: '王晓', listing: '', title: '西文西苑', action: '自动下架' }
]
// 首屏分页返回：只含第 1 页(缺少 李明/XSS_NAME/翰皋名府/兴业杨家府/西文西苑)。
const PAGED_OBJECT = {
  rows: [{ viewer: '吴志坚', listing: '西文南苑', action: '修正地图坐标' }],
  total: 5, page: 1, pageSize: 50, totalPages: 1, actions: ['修正地图坐标']
}

let noParamCalls = 0
let pagedCalls = 0
async function getAdminDataMock(reqPath, fallback) {
  if (reqPath === '/admin/footprints') { noParamCalls += 1; return FULL_ARRAY }
  if (reqPath.indexOf('/admin/footprints?') === 0) { pagedCalls += 1; return PAGED_OBJECT }
  return typeof fallback === 'function' ? fallback() : undefined
}
const buildQueryMock = (obj) => '?' + Object.keys(obj).map((k) => `${k}=${encodeURIComponent(obj[k])}`).join('&')
const dataCenterMock = { getAdminLogs: () => FULL_ARRAY.slice() }
const idem = (x) => x

const factory = new Function(
  'document', 'getAdminData', 'buildQuery', 'dataCenter', 'safeText', 'pillClass', 'needIdText', 'footprintPurposeText',
  `${cluster}\n;return { renderAdminLogs, footprintFilterOptions, getEl: (id) => document.getElementById(id) };`
)
const api = factory(documentMock, getAdminDataMock, buildQueryMock, dataCenterMock, idem, idem, idem, idem)

function optionValues(selectEl) {
  return selectEl.options.slice(1).map((o) => o.value) // 去掉首项「全部」
}

async function run() {
  await api.renderAdminLogs()

  const viewer = api.getEl('footprintViewer')
  const keyword = api.getEl('footprintKeyword')

  // 首项仍是「全部」
  assert.strictEqual(viewer.options[0].value, '', '查看人首项应为「全部」(value="")')
  assert.strictEqual(keyword.options[0].value, '', '房源首项应为「全部」(value="")')

  const viewers = optionValues(viewer)
  const listings = optionValues(keyword)

  // ① 候选来自全量：包含仅在全量集(非首屏页)里的查看人/房源
  assert.ok(viewers.includes('李明'), '查看人下拉应含仅在全量集里的「李明」(证明候选取自不分页全量而非当前页)')
  assert.ok(viewers.includes(XSS_NAME), '查看人下拉应含全量集里的 XSS 样本名')
  assert.ok(listings.includes('翰皋名府'), '房源下拉应含仅在全量集里的「翰皋名府」')
  assert.ok(listings.includes('兴业杨家府'), '房源下拉应含全量集里的「兴业杨家府」')
  // 空 viewer 回退到 user、空 listing 回退到 title
  assert.ok(viewers.includes('王晓'), '空 viewer 应回退取 user')
  assert.ok(listings.includes('西文西苑'), '空 listing 应回退取 title')
  // 空字符串不应成为候选
  assert.ok(!viewers.includes(''), '空查看人不应进入候选')

  // ② textContent 防注入：XSS 样本名以原文进入 textContent，未被解析/转义丢失
  const xssOption = viewer.options.find((o) => o.value === XSS_NAME)
  assert.ok(xssOption, '应存在 XSS 样本名的选项')
  assert.strictEqual(xssOption.textContent, XSS_NAME, 'XSS 样本名应原样落在 textContent(证明走 textContent 而非 innerHTML)')

  // ③ 候选源只拉一次：再次渲染(如翻页/筛选)复用缓存，不重复请求不带分页参数的全量
  const firstNoParam = noParamCalls
  assert.strictEqual(firstNoParam, 1, `候选源应恰好请求一次，实为 ${firstNoParam}`)
  await api.renderAdminLogs()
  assert.strictEqual(noParamCalls, 1, '二次渲染应复用候选缓存，不再请求全量候选源')
  assert.ok(pagedCalls >= 2, '表格分页请求应每次都发')
  // 二次渲染后下拉仍在(未被清空)
  assert.ok(optionValues(api.getEl('footprintViewer')).includes('李明'), '二次渲染后下拉候选应仍在')
}

run().then(() => {
  console.log('admin-web-footprint-options-v1-test passed')
}).catch((error) => {
  console.error(`admin-web-footprint-options-v1-test failed: ${error.message}`)
  process.exit(1)
})
