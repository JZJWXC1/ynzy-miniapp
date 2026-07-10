'use strict'

// 客户端/服务端小区库一致性锁定：
// 背景：服务端已知小区 = 拱墅名单 ∪ 坐标表键，客户端此前只有拱墅名单。缺的小区
// （如「皋塘运都」）在小程序编辑页会被判未匹配，提交 requiresManualReview=true，
// 服务端按「只允许收紧」采纳，已上架房源被误转人工审核、详情不可见。
// 本测试锁三层：①双库集合双向一致；②客户端库必须由同步脚本生成（防手改漂移）；
// ③真实前端载荷回归——中介编辑「皋塘运都」房源只改租金，不得转入待审核。

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const domain = require('../src/domain')
const { normalizeCommunityKey, isKnownCommunity } = require('../src/community-library')
const {
  serverKnownCommunities,
  buildClientLibrarySource,
  CLIENT_LIBRARY_PATH
} = require('./sync-client-community-library')

// 1) 双库集合双向一致（用与前端 normalizeCommunityText 相同的归一化口径）
{
  const clientList = require(CLIENT_LIBRARY_PATH)
  assert.ok(Array.isArray(clientList) && clientList.length > 0, '客户端小区库应导出非空数组')
  const clientKeys = new Set(clientList.map(normalizeCommunityKey))

  const missingOnClient = serverKnownCommunities().filter((name) => !clientKeys.has(normalizeCommunityKey(name)))
  assert.deepStrictEqual(missingOnClient, [],
    `客户端小区库缺少服务端已知小区（编辑这些小区的房源会被误转人工审核）：${missingOnClient.join('、')}`)

  const extraOnClient = clientList.filter((name) => !isKnownCommunity(name))
  assert.deepStrictEqual(extraOnClient, [],
    `客户端小区库包含服务端不认识的小区（前端提示已匹配、服务端仍判未匹配）：${extraOnClient.join('、')}`)

  // 回归样本：皋塘运都（坐标表来源，曾仅服务端可匹配）与半山家苑（双库共有基准）
  assert.ok(isKnownCommunity('皋塘运都'), '服务端应认识皋塘运都')
  assert.ok(clientKeys.has(normalizeCommunityKey('皋塘运都')), '客户端应认识皋塘运都')
  assert.ok(clientKeys.has(normalizeCommunityKey('半山家苑')), '客户端应认识半山家苑')
}

// 2) 客户端库文件必须与同步脚本输出一致（防手改/漏跑脚本导致再次漂移）
{
  const onDisk = fs.readFileSync(CLIENT_LIBRARY_PATH, 'utf8')
  assert.strictEqual(onDisk.replace(/\r\n/g, '\n'), buildClientLibrarySource(),
    'utils/gongshu-communities.js 与生成器输出不一致，请重跑 node server/scripts/sync-client-community-library.js')
}

// 3) 真实前端载荷回归：加载真实 pages/upload/upload.js，中介编辑自己已上架的
//    「皋塘运都」房源、只改租金 → 载荷申报已匹配、免人工审核，保存后仍为已通过。
;(async () => {
  const repoRoot = path.join(__dirname, '..', '..')
  const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service.js'))
  const uploadPagePath = require.resolve(path.join(repoRoot, 'pages', 'upload', 'upload.js'))

  // api-service 桩占住 require 缓存，让真实 upload.js 加载时直接取到（不触真实网络层/mock 层）
  const apiStub = {
    _editable: null,
    getEditableListing() { return Promise.resolve(JSON.parse(JSON.stringify(apiStub._editable))) },
    getCurrentUser() { return Promise.resolve({ id: 'U1', isAdmin: false }) },
    getCommissionConfig() { return Promise.resolve({}) }
  }
  require.cache[apiServicePath] = { id: apiServicePath, filename: apiServicePath, loaded: true, exports: apiStub }
  let pageDef = null
  global.Page = (def) => { pageDef = def }
  global.wx = {
    showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
    navigateTo() {}, navigateBack() {}, redirectTo() {}, chooseMedia() {}
  }
  require(uploadPagePath)
  assert.ok(pageDef && typeof pageDef.buildSubmitPayload === 'function', '真实上传页 Page 定义已捕获')

  function makePage() {
    const instance = Object.assign({}, pageDef)
    instance.data = JSON.parse(JSON.stringify(pageDef.data))
    // 小程序 setData 语义：支持 'form.x' 点路径 + 回调
    instance.setData = function (patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split('.')
        let target = instance.data
        for (let i = 0; i < parts.length - 1; i += 1) target = target[parts[i]]
        target[parts[parts.length - 1]] = patch[key]
      })
      if (typeof callback === 'function') callback()
    }
    return instance
  }

  const db = {
    users: [
      { id: 'U1', name: '中介', role: '中介', authed: '已实名' },
      { id: 'ADMIN', name: '管理员', isAdmin: true }
    ],
    listings: [{
      id: 'L-GTYD-1', uploaderId: 'U1', status: '在租', lifecycleStatus: 'active',
      reviewStatus: '已通过', rent: 3500,
      address: '杭州拱墅区皋塘运都3栋1单元502室', layout: '整租二室1厅1卫',
      community: '皋塘运都', building: '3', unit: '1', roomNumber: '502',
      rentMode: '整租', room: '二室', hall: '1厅', bath: '1卫',
      source: '二房东房源', ownerType: '二房东房源', landlordPhone: '13800001111',
      features: ['电梯'], videoKey: 'v.mp4', videoUrl: 'https://example.com/v.mp4',
      communityMatched: true, communityMatchStatus: '已匹配', requiresManualReview: false
    }],
    footprints: [],
    pointLogs: [],
    rentalNeeds: []
  }

  apiStub._editable = domain.editableListingDetail(db, 'U1', 'L-GTYD-1')
  const page = makePage()
  page.setData({ isAdmin: false, currentUser: { id: 'U1', isAdmin: false } })
  page.loadEditableListing('L-GTYD-1')
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(page.data.mode, 'edit', '编辑态加载完成')
  assert.strictEqual(page.data.form.community, '皋塘运都', '编辑态回填小区名')

  page.updateField({ currentTarget: { dataset: { field: 'rent' } }, detail: { value: '3600' } })
  const validation = page.validateForm()
  assert.strictEqual(validation.ok, true, `前端校验应通过：${validation.message || ''}`)
  assert.strictEqual(validation.communityMatched, true, '客户端应判定皋塘运都已匹配小区库')
  const payload = page.buildSubmitPayload(validation, null)
  assert.strictEqual(payload.communityMatched, true, '载荷不得申报未匹配')
  assert.strictEqual(payload.requiresManualReview, false, '载荷不得申报需人工审核')

  domain.updateNormalListing(db, 'U1', 'L-GTYD-1', payload)
  const listing = db.listings.find((item) => item.id === 'L-GTYD-1')
  assert.strictEqual(listing.rent, 3600, '租金已更新')
  assert.strictEqual(listing.communityMatched, true, '服务端维持已匹配判定')
  assert.strictEqual(listing.requiresManualReview, false, '不得转入人工审核')
  assert.strictEqual(listing.reviewStatus, '无需审核', '免审编辑落无需审核，不得回落待审核')
  assert.ok(domain.listingDetail(db, 'L-GTYD-1'), '编辑后详情仍前台可见（修复前会因转待审核而不可见）')

  console.log('community-library-parity-test passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
