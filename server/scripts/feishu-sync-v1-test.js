const assert = require('assert')
const feishuSync = require('../src/feishu-sync')

function makeDb() {
  return {
    users: [
      { id: 'A1', name: '管理员', role: '管理员', isAdmin: true }
    ],
    listings: [],
    footprints: [],
    pointLogs: []
  }
}

function row(fields) {
  return { fields }
}

async function main() {
  const db = makeDb()
  const first = await feishuSync.applySync(db, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '601D',
      户型: '一室一厅一卫',
      押一付一: '2800',
      联系电话: '13900001111',
      看房方式密码: '336699#'
    })
  ], [], 'A1', { dryRun: true })

  assert.strictEqual(first.created, 1, '缺素材房源仍应同步入库')
  assert.strictEqual(first.down, 0, '缺素材不应自动下架')
  assert.strictEqual(first.missingVideoMaterial, 1, '应统计缺视频素材数量')
  const missing = db.listings[0]
  assert.strictEqual(missing.syncStatus, '缺视频素材', '后台应标记缺视频素材')
  assert.strictEqual(missing.videoMaterialStatus, '缺视频素材', '视频素材状态应标记缺失')
  assert.strictEqual(missing.landlordPhone, '公司统一维护', '飞书联系电话不能入库')
  assert.ok(!JSON.stringify(missing).includes('13900001111'), '同步房源不能保留飞书联系电话')
  assert.ok(!JSON.stringify(missing).includes('336699'), '同步房源不能保留看房密码')

  const matched = await feishuSync.applySync(db, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '601D',
      户型: '一室一厅一卫',
      押一付一: '2800'
    })
  ], [
    { name: '601D.mp4', videoUrl: 'https://example.com/601D.mp4' }
  ], 'A1', { dryRun: true })

  assert.strictEqual(matched.updated, 1, '按房号命中的素材应更新原房源')
  assert.strictEqual(db.listings[0].syncStatus, '已同步飞书', '命中素材后应恢复正常同步状态')
  assert.strictEqual(db.listings[0].missingVideoMaterial, false, '命中素材后应清除缺素材标记')

  const removed = await feishuSync.applySync(db, [], [], 'A1', { dryRun: true })
  assert.strictEqual(removed.down, 1, '房源表删除后应自动下架')
  assert.strictEqual(db.listings[0].status, '已下架', '自动下架后状态应进入后台资产池')

  const snapshot = feishuSync.sanitizeSheetSnapshot({
    rows: [
      ['区域', '小区', '房号', '联系电话', '户型描述', '看房方式密码', '备注'],
      ['闸弄口', '京漾东韵府', '1-2-601D', '13900001111', '一室', '336699#', '水电自理']
    ]
  })
  const snapshotText = JSON.stringify(snapshot)
  assert.ok(!snapshotText.includes('联系电话'), '快照不能保留联系电话列')
  assert.ok(!snapshotText.includes('13900001111'), '快照不能保留联系电话内容')
  assert.ok(!snapshotText.includes('看房方式密码'), '快照不能保留看房密码列')
  assert.ok(!snapshotText.includes('336699'), '快照不能保留看房密码内容')
}

main().then(() => {
  console.log('feishu-sync-v1-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
