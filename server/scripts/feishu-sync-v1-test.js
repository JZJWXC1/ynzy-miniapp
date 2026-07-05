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

function record(recordId, fields) {
  return { record_id: recordId, fields }
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
  ], [], 'system-feishu-sync', { dryRun: true })

  assert.strictEqual(first.created, 1, '缺素材房源仍应同步入库')
  assert.strictEqual(db.listings[0].uploaderId, 'A1', '系统定时同步新增房源应自动落到真实管理员身份')
  assert.strictEqual(first.down, 0, '缺素材不应自动下架')
  assert.strictEqual(first.missingVideoMaterial, 1, '应统计缺视频素材数量')
  const missing = db.listings[0]
  assert.strictEqual(missing.syncStatus, '缺视频素材', '后台应标记缺视频素材')
  assert.strictEqual(missing.videoMaterialStatus, '缺视频素材', '视频素材状态应标记缺失')
  assert.strictEqual(missing.landlordPhone, '13900001111', '公司房源应保留飞书联系电话')
  assert.strictEqual(missing.viewingPassword, '336699#', '公司房源应保留看房方式密码')
  assert.ok(JSON.stringify(missing).includes('13900001111'), '同步房源应保留飞书联系电话')
  assert.ok(JSON.stringify(missing).includes('336699'), '同步房源应保留看房密码')

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
  assert.ok((matched.auditRows || []).some((item) => item.syncResult === '上架-已配视频'), '对账表应记录已配视频结果')

  const mismatchDb = makeDb()
  const mismatch = await feishuSync.applySync(mismatchDb, [
    record('703', {
      区域: '闸弄口',
      小区: '杭行荟',
      几栋: '5',
      房号: '710',
      户型: '一室一厅一卫',
      押一付一: '3000'
    })
  ], [
    { name: 'mmexport1782463085111.mp4', sourcePath: '棠润府17-1004A/mmexport1782463085111.mp4' }
  ], 'A1', { dryRun: true })
  assert.strictEqual(mismatch.skippedNoMaterial, 1, '素材匹配不能用弱房号片段误命中别的小区视频')
  assert.strictEqual(mismatchDb.listings[0].missingVideoMaterial, true, '弱匹配失败后仍应缺素材上架')
  assert.strictEqual((mismatch.auditRows || [])[0].matchedMaterialName, '', '弱匹配失败的对账行不应记录错误素材')

  const transferFailed = await feishuSync.applySync(db, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '602A',
      户型: '一室一厅一卫',
      押一付一: '2900'
    })
  ], [
    { name: '602A.mp4' }
  ], 'A1', { dryRun: false })

  assert.strictEqual(transferFailed.failed, 0, '素材匹配后不可用不应阻断公司房源上架')
  assert.strictEqual(transferFailed.materialTransferFailed, 1, '应统计素材搬运失败次数')
  assert.strictEqual(transferFailed.missingVideoMaterial, 1, '素材搬运失败应计入缺视频素材')
  const degradedListing = db.listings.find((item) => item.roomNumber === '602A')
  assert.ok(degradedListing, '素材失败降级后仍应创建公司房源')
  assert.strictEqual(degradedListing.missingVideoMaterial, true, '素材失败降级房源应标记缺视频素材')
  assert.strictEqual(degradedListing.videoMaterialStatus, '素材转存失败', '后台应保留素材转存失败状态')
  assert.ok(degradedListing.videoMaterialFailureReason, '后台应保留素材失败原因')
  assert.ok((transferFailed.auditRows || []).some((item) => item.syncResult === '上架-素材失败降级缺视频素材' && item.failureReason), '对账表应记录素材失败降级原因')

  const districtUpdated = await feishuSync.applySync(db, [
    row({
      区域: '东新园',
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
  assert.strictEqual(districtUpdated.updated, 1, '飞书更新应命中原房源')
  const updated601 = db.listings.find((item) => item.roomNumber === '601D')
  assert.strictEqual(updated601.district, '拱墅区', '飞书更新也应回写 district')
  assert.strictEqual(updated601.area, '拱墅区', '飞书更新也应回写 area')
  assert.strictEqual(updated601.block, '东新园', '飞书更新应保留板块')

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
  assert.ok(snapshotText.includes('联系电话'), '公司房源快照应保留联系电话列')
  assert.ok(snapshotText.includes('13900001111'), '公司房源快照应保留联系电话内容')
  assert.ok(snapshotText.includes('看房方式密码'), '公司房源快照应保留看房密码列')
  assert.ok(snapshotText.includes('336699'), '公司房源快照应保留看房密码内容')
  assert.strictEqual(snapshot.columnCount, 7, '快照表头与数据行列数应一致')

  const parsedWholeRent = feishuSync.normalizeRecord(row({
    区域: '闸弄口',
    小区: '京漾东韵府',
    几栋: '1',
    几单元: '2',
    房号: '602',
    户型描述: '（整）一室一厅一卫',
    押一付一: '3000'
  }), 0)
  assert.strictEqual(parsedWholeRent.rentMode, '整租', '户型描述以（整）开头应解析为整租')
  assert.strictEqual(parsedWholeRent.layout, '一室一厅一卫', '整租前缀不应写入户型净值')
  assert.strictEqual(parsedWholeRent.area, '上城区', '闸弄口板块应自动归入上城区')
  assert.strictEqual(parsedWholeRent.block, '闸弄口', '飞书区域列应作为板块保留')

  const parsedMultiBlock = feishuSync.normalizeRecord(row({
    区域: '闸弄口\n新塘\n元宝塘\n东站',
    小区: '皋塘运都',
    几栋: '1',
    几单元: '1',
    房号: '701',
    户型描述: '（整）两室一厅',
    押一付一: '4500'
  }), 3)
  assert.strictEqual(parsedMultiBlock.area, '上城区', '多行上城板块应自动归入上城区')

  const parsedSharedRent = feishuSync.normalizeRecord(row({
    区域: '闸弄口',
    小区: '京漾东韵府',
    几栋: '1',
    几单元: '2',
    房号: '603A',
    户型描述: '朝南单间带独卫',
    押一付一: '1800'
  }), 1)
  assert.strictEqual(parsedSharedRent.rentMode, '合租', '户型描述没有（整）前缀应解析为合租')

  const parsedGongshuBlock = feishuSync.normalizeRecord(row({
    区域: '万达',
    小区: '拱墅万达公寓',
    几栋: '1',
    几单元: '1',
    房号: '801',
    户型描述: '朝南单间',
    押一付一: '1800'
  }), 2)
  assert.strictEqual(parsedGongshuBlock.area, '拱墅区', '非上城配置板块应自动归入拱墅区')
}

main().then(() => {
  console.log('feishu-sync-v1-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
