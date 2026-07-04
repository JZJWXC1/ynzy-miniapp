const assert = require('assert')
const domain = require('../src/domain.js')

// 锁定：公司房源一律默认带「电梯」（电梯房）与「免押金」；合作房源不默认带电梯。
function run() {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const base = {
    status: '在租',
    lifecycleStatus: 'active',
    rent: 3000,
    layout: '整租一室',
    area: '拱墅区',
    district: '拱墅区',
    videoUrl: 'https://example.com/v.mp4',
    uploaderId: 'U1',
    lastVerifiedAt: now,
    createdAt: now
  }
  const db = {
    users: [{ id: 'U1', name: '中介', role: '管理员', authed: '已实名', isAdmin: true }],
    listings: [
      { ...base, id: 'C1', companyListing: true, source: '公司房源', community: '城北天邑', features: ['朝南'] },
      { ...base, id: 'P1', companyListing: false, source: '二房东房源', community: '合作小区', features: ['朝南'] }
    ],
    rentalNeeds: [],
    footprints: []
  }

  const rows = domain.filterListings(db, {})
  const c1 = rows.find((item) => item.id === 'C1')
  const p1 = rows.find((item) => item.id === 'P1')
  assert.ok(c1, '公司房源应出现在前台列表')
  assert.ok(p1, '合作房源应出现在前台列表')
  assert.ok(c1.features.includes('电梯'), '公司房源必须一律默认带电梯房，即便上传时未勾选')
  assert.ok(c1.features.includes('免押金'), '公司房源仍默认带免押金')
  assert.ok(!p1.features.includes('电梯'), '合作房源不默认带电梯（尊重实际填写）')

  console.log('company-default-features-test passed')
}

run()
