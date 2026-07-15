const assert = require('assert')
const fs = require('fs')
const path = require('path')
const feishuSync = require('../src/feishu-sync')
const config = require('../src/config')
const oss = require('../src/oss')

const FALSE_SAFE_SUFFIX_PHONE = '187号线0000号线1111'
const LEGAL_PUBLIC_NUMERIC_VALUES = [
  '17号板块3号地铁5分钟1室1厅1卫2026年',
  '17㎡三室1厅1卫',
  '17m²三室',
  '17m2三室',
  '17平方米三室'
]
const NOISY_WECHAT_GAP = '微 信 a realwx123'
const NOISY_WECHAT_DECOY = '微 信 abcdef realwx123'
const NOISY_WECHAT_ID = 'realwx123'
const GENERIC_ALPHA_CONTACTS = ['联系方式 privateid', '联系方式 private_wx_01', '联系房东 privateid', '联络方式 privateid', 'contact privateid']
const FULLWIDTH_O_PHONE = '187000Ｏ1111'
const MIXED_CHINESE_PHONE_VARIANTS = [
  '一八八测试零零零零测试七七七七',
  '壹捌捌测试零零零零测试柒柒柒柒',
  '一八八abc零零零零abc七七七七',
  '一八八🫥零零零零🫥七七七七'
]
const VALID_DATE_COPY = '开放日期2026-07-14 更新时间2026-07-14T10:20:30.000Z'
const COMPANY_ROAD_ADDRESS = '杭州市拱墅区文一西路969号园区北门'
const PLACEHOLDER_LITERAL = '__YNZY_ALLOWED_PHONE_A__'
const TIBETAN_PHONE = '\u0f21\u0f28\u0f27\u0f20\u0f20\u0f20\u0f20\u0f21\u0f21\u0f21\u0f21'
const PRIVATE_PHONE_DIGITS = '18700001111'
const UNIT_PHONE_SMUGGLES = [
  '18㎡700㎡001㎡111㎡',
  '18公里700公里001公里111公里',
  '18元/月700元/月001元/月111元/月',
  '18号线7室0室0室00号线1室1室1室1室'
]
const CONTACT_HEADER_CASES = [
  { header: '微🫥信号', privateValue: 'private_wx_01' },
  { header: '微・信号', privateValue: 'private_wx_01' },
  { header: '聯絡電話', privateValue: '88888888' },
  { header: '座机', privateValue: '88888888' },
  { header: '房东微信', privateValue: 'private_wx_01' }
]

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
  return { fields: { 联系电话: '13900001111', ...fields } }
}

function managedKey(fileName) {
  const uploadDir = String(config.oss.uploadDir || 'house-videos').replace(/^\/+|\/+$/g, '') || 'house-videos'
  return `${uploadDir}/${fileName}`
}

function record(recordId, fields) {
  return { record_id: recordId, fields: { 联系电话: '13900001111', ...fields } }
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
      房东佣金占月租比例: 0,
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
  assert.strictEqual(missing.requiresManualReview, false, '飞书公司房源缺视频也不得进入人工审核拦截')
  assert.strictEqual(missing.communityMatched, true, '飞书公司房源应按表内在租直接视为小区已匹配')
  assert.strictEqual(missing.landlordPhone, '13900001111', '公司房源应保留飞书联系电话')
  assert.strictEqual(missing.landlordCommissionPercent, 0, '飞书显式 0% 房东佣金不得被默认 50 覆盖')
  assert.strictEqual(missing.viewingPassword, '336699#', '公司房源应保留看房方式密码')
  assert.ok(JSON.stringify(missing).includes('13900001111'), '同步房源应保留飞书联系电话')
  assert.ok(JSON.stringify(missing).includes('336699'), '同步房源应保留看房密码')

  const keepExistingPhone = await feishuSync.applySync(db, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '601D',
      户型: '一室一厅一卫',
      押一付一: '2850',
      联系电话: 'invalid-phone'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(keepExistingPhone.updated, 1, '表内无效号码不能冻结已有公司房源更新')
  assert.strictEqual(keepExistingPhone.missingLandlordPhone, 0, '线上已有合法号码时应保留，不应误报待补')
  assert.strictEqual(db.listings[0].landlordPhone, '13900001111', '表内无效号码不得覆盖线上已有合法号码')
  assert.ok(!JSON.stringify(db.listings[0]).includes('invalid-phone'), '飞书无效号码不得落入任何房源字段')
  missing.requiresManualReview = true
  missing.communityMatched = false
  missing.communityMatchStatus = '未匹配'

  const invalidPhoneDb = makeDb()
  const invalidPhone = await feishuSync.applySync(invalidPhoneDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      房号: '609A',
      户型: '一室一厅一卫',
      押一付一: '2800',
      联系电话: 'invalid-phone'
    })
  ], [{ name: '609A.mp4', videoUrl: 'https://example.test/609A.mp4' }], 'A1', { dryRun: true })
  assert.strictEqual(invalidPhone.skippedInvalid, 0, '飞书缺电话不能冻结整行公开库存同步')
  assert.strictEqual(invalidPhone.missingLandlordPhone, 1, '飞书缺电话必须单独计数并 fail-loud')
  assert.strictEqual(invalidPhone.created, 1, '无号公司房源仍应创建，后续由管理员补电话')
  assert.strictEqual(invalidPhoneDb.listings.length, 1, '飞书缺电话仍应写入公开库存字段')
  assert.strictEqual(invalidPhoneDb.listings[0].landlordPhone, '', '不得用占位文字或无效号码冒充房东手机号')
  assert.strictEqual(invalidPhoneDb.listings[0].contact, '', '兼容 contact 字段也不得残留无效号码')
  assert.ok(!JSON.stringify(invalidPhoneDb.listings[0]).includes('invalid-phone'), '无效号码不得旁路写入房源对象')
  assert.strictEqual(invalidPhoneDb.listings[0].missingLandlordPhone, true, '房源必须显式标记联系电话待补')
  assert.strictEqual(invalidPhoneDb.listings[0].feishuContactStatus, '待补充')
  assert.ok(invalidPhone.messages.some((message) => /联系电话待补充/.test(message)), '同步结果必须给出可运维的缺号摘要')
  assert.ok((invalidPhone.auditRows || []).some((item) => /联系电话待补充/.test(item.failureReason)), '逐行对账必须标记缺号而非静默')
  assert.ok(invalidPhone.messages.every((message) => !/1[3-9]\d{9}/.test(message)), '飞书错误摘要不得输出号码')
  assert.strictEqual(feishuSync.status(invalidPhoneDb).missingLandlordPhoneCount, 1, '后台状态必须汇总仍在架的飞书缺号房源')

  invalidPhoneDb.listings[0].landlordPhone = '公司统一维护'
  invalidPhoneDb.listings[0].contact = 'invalid-legacy-phone'
  const invalidPhoneUpdated = await feishuSync.applySync(invalidPhoneDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      房号: '609A',
      户型: '一室一厅一卫',
      押一付一: '3100',
      联系电话: ''
    })
  ], [{ name: '609A.mp4', videoUrl: 'https://example.test/609A.mp4' }], 'A1', { dryRun: true })
  assert.strictEqual(invalidPhoneUpdated.updated, 1, '存量无号公司房源后续仍必须继续同步租金/状态')
  assert.strictEqual(invalidPhoneUpdated.failed, 0, '存量非法占位电话必须被内部同步清空，不能再次触发领域 400')
  assert.strictEqual(invalidPhoneDb.listings[0].rent, 3100, '缺号不得冻结公开库存字段更新')
  assert.strictEqual(invalidPhoneDb.listings[0].landlordPhone, '', '更新后仍不得伪造号码')
  assert.strictEqual(invalidPhoneDb.listings[0].contact, '', '存量兼容 contact 非法值也必须清理')

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
  assert.strictEqual(db.listings[0].requiresManualReview, false, '同步更新必须清理存量人工审核残留')
  assert.strictEqual(db.listings[0].communityMatched, true, '同步更新必须清理存量小区未匹配残留')
  assert.ok((matched.auditRows || []).some((item) => item.syncResult === '上架-已配视频'), '对账表应记录已配视频结果')

  const staleVideoDb = makeDb()
  await feishuSync.applySync(staleVideoDb, [
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
    { name: '601D.mp4', token: 'SYNTHETIC-601D', videoUrl: 'https://example.com/601D.mp4', videoKey: managedKey('601D.mp4') }
  ], 'A1', { dryRun: true })
  assert.ok(staleVideoDb.listings[0].videoUrl || staleVideoDb.listings[0].videoKey, '命中素材后应先写入视频字段')
  const previousManagedVideoKey = staleVideoDb.listings[0].videoKey
  const previousMaterialToken = staleVideoDb.listings[0].sourceMaterialToken

  const staleMissing = await feishuSync.applySync(staleVideoDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '601D',
      户型: '一室一厅一卫',
      押一付一: '2800'
    })
  ], [], 'A1', { dryRun: true })
  const staleMissingListing = staleVideoDb.listings[0]
  assert.strictEqual(staleMissing.updated, 1, '旧房源再次同步缺素材时应更新原房源')
  assert.strictEqual(staleMissingListing.missingVideoMaterial, true, '旧房源缺素材时应标记缺视频素材')
  assert.strictEqual(staleMissingListing.videoKey, previousManagedVideoKey, '暂时漏匹配素材时必须保留同一存量房源最后一份受控 videoKey')
  assert.strictEqual(staleMissingListing.videoUrl, '', '受控 key 伴随的外部测试 URL 不得借保留分支继续存活')
  assert.strictEqual(staleMissingListing.sourceMaterialToken, previousMaterialToken, '沿用旧视频时不得把来源标识清空，否则下轮无法安全复用')
  assert.strictEqual(staleMissingListing.videoMaterialStatus, '沿用上次视频·素材待核', '后台应明确区分沿用旧视频与本轮新素材成功')
  assert.strictEqual(staleMissingListing.recommendationProfile.hasVideo, true, '推荐画像必须与仍可播放的保留视频一致')
  assert.ok((staleMissing.auditRows || []).some((item) => item.syncResult === '上架-沿用上次视频·素材待核' && item.failureReason), '缺素材沿用旧视频的逐行对账必须明确待核且保留原因')

  const signedUrlDb = makeDb()
  const controlledOrigin = oss.readSourceOrigins()[0]
  assert.ok(controlledOrigin, '测试环境必须至少提供一个服务端受控媒体 origin')
  const signedVideoKey = managedKey('607A.mp4')
  const syntheticSignedUrl = `${controlledOrigin}/${signedVideoKey}?Signature=SYNTHETIC_DO_NOT_USE&Expires=1`
  await feishuSync.applySync(signedUrlDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '607A',
      户型: '一室一厅一卫',
      押一付一: '2850'
    })
  ], [
    { name: '607A.mp4', token: 'SYNTHETIC-607A', videoUrl: syntheticSignedUrl }
  ], 'A1', { dryRun: true })
  assert.strictEqual(signedUrlDb.listings[0].videoUrl, syntheticSignedUrl, '测试前置必须先保存带合成短签 query 的受控源 URL')
  await feishuSync.applySync(signedUrlDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '607A',
      户型: '一室一厅一卫',
      押一付一: '2850'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(signedUrlDb.listings[0].videoKey, signedVideoKey, 'URL-only 受控旧数据应只提取规范化 object key 继续播放')
  assert.strictEqual(signedUrlDb.listings[0].videoUrl, '', '沿用受控视频时不得延寿旧短签 videoUrl')
  assert.strictEqual(signedUrlDb.listings[0].sourceMaterialUrl, '', '沿用受控视频时不得延寿旧短签 sourceMaterialUrl')
  assert.ok(!JSON.stringify(signedUrlDb.listings[0]).includes('SYNTHETIC_DO_NOT_USE'), '短签 query 不得残留在房源对象任何字段')

  const reactivatedVideoDb = makeDb()
  await feishuSync.applySync(reactivatedVideoDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '606A',
      户型: '一室一厅一卫',
      押一付一: '2840'
    })
  ], [
    { name: '606A.mp4', token: 'SYNTHETIC-606A', videoKey: managedKey('606A.mp4') }
  ], 'A1', { dryRun: true })
  await feishuSync.applySync(reactivatedVideoDb, [], [], 'A1', { dryRun: true })
  assert.strictEqual(reactivatedVideoDb.listings[0].status, '已下架', '测试前置必须先让旧房源进入下架资产池')
  await feishuSync.applySync(reactivatedVideoDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '606A',
      户型: '一室一厅一卫',
      押一付一: '2840'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(reactivatedVideoDb.listings[0].videoKey, '', '曾下架后重新出现但无素材的房源不得公开沿用旧视频')
  assert.strictEqual(reactivatedVideoDb.listings[0].videoUrl, '', '重新上架无素材时不得保留旧视频 URL')
  assert.strictEqual(reactivatedVideoDb.listings[0].videoMaterialStatus, '缺视频素材', '重新上架无素材应回到普通缺素材状态')
  assert.strictEqual(reactivatedVideoDb.listings[0].recommendationProfile.hasVideo, false, '重新上架无素材时推荐画像必须同步清除视频标记')

  const changedIdentityDb = makeDb()
  await feishuSync.applySync(changedIdentityDb, [
    record('SYNTHETIC-SAME-RECORD', {
      区域: '测试板块甲',
      小区: '测试小区甲',
      几栋: '1',
      几单元: '1',
      房号: '101A',
      户型: '一室一厅一卫',
      押一付一: '2800'
    })
  ], [
    { name: '101A.mp4', token: 'SYNTHETIC-101A', videoKey: managedKey('101A.mp4') }
  ], 'A1', { dryRun: true })
  assert.strictEqual(changedIdentityDb.listings[0].videoKey, managedKey('101A.mp4'), '测试前置必须先为原物理房源保存受控视频')
  await feishuSync.applySync(changedIdentityDb, [
    record('SYNTHETIC-SAME-RECORD', {
      区域: '测试板块乙',
      小区: '测试小区乙',
      几栋: '2',
      几单元: '2',
      房号: '202B',
      户型: '两室一厅一卫',
      押一付一: '3600'
    })
  ], [], 'A1', { dryRun: true })
  const changedIdentityListing = changedIdentityDb.listings[0]
  assert.strictEqual(changedIdentityListing.community, '测试小区乙', '同一飞书记录改指另一套时仍应更新本轮房源字段')
  assert.strictEqual(changedIdentityListing.roomNumber, '202B', '同一飞书记录改指另一套时应切换到新房号')
  assert.strictEqual(changedIdentityListing.videoKey, '', '物理房源标识变化后不得把上一套视频沿用到新套')
  assert.notStrictEqual(changedIdentityListing.videoMaterialStatus, '沿用上次视频·素材待核', '跨物理房源时不得伪装为同房源暂态漏素材')
  assert.strictEqual(changedIdentityListing.recommendationProfile.hasVideo, false, '跨物理房源清除旧视频后推荐画像必须同步为无视频')

  const crossIdentityTokenDb = makeDb()
  await feishuSync.applySync(crossIdentityTokenDb, [
    record('SYNTHETIC-SAME-TOKEN-RECORD', {
      区域: '测试板块甲', 小区: '测试小区甲', 几栋: '1', 几单元: '1', 房号: '111A', 户型: '一室一厅一卫', 押一付一: '2800'
    })
  ], [
    { name: '111A.mp4', token: 'SYNTHETIC-SAME-TOKEN', videoKey: managedKey('111A.mp4') }
  ], 'A1', { dryRun: true })
  const originalSameTokenUploadToOss = config.feishu.uploadToOss
  let crossIdentityTokenResult
  try {
    config.feishu.uploadToOss = false
    crossIdentityTokenResult = await feishuSync.applySync(crossIdentityTokenDb, [
      record('SYNTHETIC-SAME-TOKEN-RECORD', {
        区域: '测试板块乙', 小区: '测试小区乙', 几栋: '2', 几单元: '2', 房号: '222B', 户型: '两室一厅一卫', 押一付一: '3600'
      })
    ], [
      { name: '222B.mp4', token: 'SYNTHETIC-SAME-TOKEN' }
    ], 'A1', { dryRun: false })
  } finally {
    config.feishu.uploadToOss = originalSameTokenUploadToOss
  }
  assert.strictEqual(crossIdentityTokenResult.materialTransferFailed, 1, '跨物理房源即使素材 token 相同也必须尝试本轮素材，不能把旧 key 当成功复用')
  assert.strictEqual(crossIdentityTokenDb.listings[0].roomNumber, '222B', '同 token 场景仍应更新到本轮物理房源')
  assert.strictEqual(crossIdentityTokenDb.listings[0].videoKey, '', '跨物理房源的同 token 不得绕过身份门沿用旧套视频')
  assert.notStrictEqual(crossIdentityTokenDb.listings[0].videoMaterialStatus, '已匹配视频素材', '旧 key 不得被伪装成本轮同 token 素材成功')

  const signedTokenReuseDb = makeDb()
  const signedTokenReuseKey = managedKey('333C.mp4')
  const signedTokenReuseUrl = `${controlledOrigin}/${signedTokenReuseKey}?Signature=SYNTHETIC_REUSE_QUERY&Expires=1`
  const signedTokenReuseFields = {
    区域: '测试板块', 小区: '测试复用小区', 几栋: '3', 几单元: '3', 房号: '333C', 户型: '一室一厅一卫', 押一付一: '3300'
  }
  await feishuSync.applySync(signedTokenReuseDb, [record('SYNTHETIC-SIGNED-REUSE', signedTokenReuseFields)], [
    { name: '333C.mp4', token: 'SYNTHETIC-SIGNED-REUSE-TOKEN', videoUrl: signedTokenReuseUrl }
  ], 'A1', { dryRun: true })
  try {
    config.feishu.uploadToOss = false
    await feishuSync.applySync(signedTokenReuseDb, [record('SYNTHETIC-SIGNED-REUSE', signedTokenReuseFields)], [
      { name: '333C.mp4', token: 'SYNTHETIC-SIGNED-REUSE-TOKEN' }
    ], 'A1', { dryRun: false })
  } finally {
    config.feishu.uploadToOss = originalSameTokenUploadToOss
  }
  assert.strictEqual(signedTokenReuseDb.listings[0].videoKey, signedTokenReuseKey, '同一持续在架房源的同 token 可从受控旧 URL 规范化复用 object key')
  assert.strictEqual(signedTokenReuseDb.listings[0].videoUrl, '', '同 token 复用只保留规范 key，不得延寿旧短签 videoUrl')
  assert.strictEqual(signedTokenReuseDb.listings[0].sourceMaterialUrl, '', '同 token 复用不得通过 sourceMaterialUrl 延寿旧短签')
  assert.ok(!JSON.stringify(signedTokenReuseDb.listings[0]).includes('SYNTHETIC_REUSE_QUERY'), '同 token 复用后任何字段都不得残留旧短签 query')

  const currentMaterialWinsDb = makeDb()
  const currentMaterialFields = {
    区域: '测试板块', 小区: '测试新素材小区', 几栋: '5', 几单元: '1', 房号: '501A', 户型: '一室一厅一卫', 押一付一: '3500'
  }
  await feishuSync.applySync(currentMaterialWinsDb, [record('SYNTHETIC-CURRENT-WINS', currentMaterialFields)], [
    { name: '501A.mp4', token: 'SYNTHETIC-CURRENT-WINS-TOKEN', videoKey: managedKey('501A-old.mp4') }
  ], 'A1', { dryRun: true })
  const currentMaterialKey = managedKey('501A-new.mp4')
  const currentMaterialUrl = `${controlledOrigin}/${currentMaterialKey}`
  await feishuSync.applySync(currentMaterialWinsDb, [record('SYNTHETIC-CURRENT-WINS', currentMaterialFields)], [
    { name: '501A.mp4', token: 'SYNTHETIC-CURRENT-WINS-TOKEN', videoKey: currentMaterialKey, videoUrl: currentMaterialUrl }
  ], 'A1', { dryRun: false })
  assert.strictEqual(currentMaterialWinsDb.listings[0].videoKey, currentMaterialKey, '本轮显式新视频必须优先于同 token 的旧 key')
  assert.strictEqual(currentMaterialWinsDb.listings[0].videoUrl, currentMaterialUrl, '本轮显式新视频 URL 必须随新 key 生效')

  for (const identityChanged of [false, true]) {
    const urlOnlyDb = makeDb()
    const recordId = `SYNTHETIC-URL-ONLY-${identityChanged ? 'CROSS' : 'SAME'}`
    const oldFields = {
      区域: '测试板块甲', 小区: '测试 URL 小区甲', 几栋: '6', 几单元: '1', 房号: '601A', 户型: '一室一厅一卫', 押一付一: '3600'
    }
    const nextFields = identityChanged
      ? { 区域: '测试板块乙', 小区: '测试 URL 小区乙', 几栋: '7', 几单元: '2', 房号: '702B', 户型: '两室一厅一卫', 押一付一: '4200' }
      : oldFields
    await feishuSync.applySync(urlOnlyDb, [record(recordId, oldFields)], [
      { name: '601A.mp4', token: `SYNTHETIC-URL-OLD-${identityChanged}`, videoKey: managedKey(`url-old-${identityChanged}.mp4`) }
    ], 'A1', { dryRun: true })
    const nextVideoUrl = `https://material.example.test/url-only-${identityChanged ? 'cross' : 'same'}.mp4`
    try {
      config.feishu.uploadToOss = false
      await feishuSync.applySync(urlOnlyDb, [record(recordId, nextFields)], [
        { name: `${nextFields.房号}.mp4`, token: `SYNTHETIC-URL-NEW-${identityChanged}`, videoUrl: nextVideoUrl }
      ], 'A1', { dryRun: false })
    } finally {
      config.feishu.uploadToOss = originalSameTokenUploadToOss
    }
    assert.strictEqual(urlOnlyDb.listings[0].videoKey, '', `${identityChanged ? '跨物理' : '同物理'}本轮 URL-only 素材必须显式清除旧 videoKey`)
    assert.strictEqual(urlOnlyDb.listings[0].videoUrl, nextVideoUrl, `${identityChanged ? '跨物理' : '同物理'}本轮 URL-only 素材必须使用本轮 URL`)
  }

  const historicalSameTokenDb = makeDb()
  const historicalSameTokenFields = {
    区域: '测试板块', 小区: '测试历史小区', 几栋: '4', 几单元: '1', 房号: '401A', 户型: '一室一厅一卫', 押一付一: '3100'
  }
  await feishuSync.applySync(historicalSameTokenDb, [record('SYNTHETIC-HISTORICAL-TOKEN', historicalSameTokenFields)], [
    { name: '401A.mp4', token: 'SYNTHETIC-HISTORICAL-SAME-TOKEN', videoKey: managedKey('401A.mp4') }
  ], 'A1', { dryRun: true })
  historicalSameTokenDb.listings[0].lifecycleStatus = 'active'
  historicalSameTokenDb.listings[0].status = '已出租'
  try {
    config.feishu.uploadToOss = false
    await feishuSync.applySync(historicalSameTokenDb, [record('SYNTHETIC-HISTORICAL-TOKEN', historicalSameTokenFields)], [
      { name: '401A.mp4', token: 'SYNTHETIC-HISTORICAL-SAME-TOKEN' }
    ], 'A1', { dryRun: false })
  } finally {
    config.feishu.uploadToOss = originalSameTokenUploadToOss
  }
  assert.strictEqual(historicalSameTokenDb.listings[0].videoKey, '', '非持续在架房源不得用同 token 复用旧视频 key')
  assert.notStrictEqual(historicalSameTokenDb.listings[0].videoMaterialStatus, '已匹配视频素材', '历史终态旧 key 不得被标成本轮素材成功')

  const historicalStates = [
    { lifecycleStatus: 'sold', status: '已成交' },
    { lifecycleStatus: 'active', status: '已签单待确认' },
    { lifecycleStatus: 'active', status: '已出租' },
    { lifecycleStatus: 'active', status: '不租了' },
    { lifecycleStatus: 'active', status: '暂停出租' },
    { lifecycleStatus: 'active', status: '未上架' },
    { lifecycleStatus: 'active', status: '不上架' },
    { lifecycleStatus: 'active', status: '未在租' },
    { lifecycleStatus: 'active', status: '不在租' },
    { lifecycleStatus: 'expired', status: '已失效' }
  ]
  for (const [index, historicalState] of historicalStates.entries()) {
    const historicalDb = makeDb()
    const roomNumber = `${index + 3}01A`
    const recordId = `SYNTHETIC-HISTORICAL-${index}`
    const fields = {
      区域: '测试板块',
      小区: '测试历史小区',
      几栋: '3',
      几单元: '1',
      房号: roomNumber,
      户型: '一室一厅一卫',
      押一付一: '3000'
    }
    await feishuSync.applySync(historicalDb, [record(recordId, fields)], [
      { name: `${roomNumber}.mp4`, token: `SYNTHETIC-${roomNumber}`, videoKey: managedKey(`${roomNumber}.mp4`) }
    ], 'A1', { dryRun: true })
    Object.assign(historicalDb.listings[0], historicalState)
    await feishuSync.applySync(historicalDb, [record(recordId, fields)], [], 'A1', { dryRun: true })
    assert.strictEqual(
      historicalDb.listings[0].videoKey,
      '',
      `${historicalState.lifecycleStatus}/${historicalState.status} 不是持续在架状态，重新同步缺素材时不得复活旧视频`
    )
    assert.strictEqual(historicalDb.listings[0].recommendationProfile.hasVideo, false, '历史终态重新同步缺素材后推荐画像必须为无视频')
  }

  const unmanagedVideoDb = makeDb()
  await feishuSync.applySync(unmanagedVideoDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '608B',
      户型: '一室一厅一卫',
      押一付一: '2860'
    })
  ], [
    { name: '608B.mp4', videoUrl: 'https://unmanaged.example/608B.mp4' }
  ], 'A1', { dryRun: true })
  assert.ok(unmanagedVideoDb.listings[0].videoUrl, '测试前置应先写入外部非受控视频 URL')
  await feishuSync.applySync(unmanagedVideoDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '608B',
      户型: '一室一厅一卫',
      押一付一: '2860'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(unmanagedVideoDb.listings[0].videoUrl, '', '外部任意 URL 不得借“沿用上次视频”进入公开保留路径')
  assert.strictEqual(unmanagedVideoDb.listings[0].videoKey, '', '非受控视频不得伪造受控 object key')
  assert.notStrictEqual(unmanagedVideoDb.listings[0].videoMaterialStatus, '沿用上次视频·素材待核', '非受控视频不得标记为已安全保留')
  assert.strictEqual(unmanagedVideoDb.listings[0].recommendationProfile.hasVideo, false, '非受控视频被清除后推荐画像不得继续宣称有视频')

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

  const retainedTransferDb = makeDb()
  await feishuSync.applySync(retainedTransferDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '610C',
      户型: '一室一厅一卫',
      押一付一: '2920'
    })
  ], [
    { name: '610C.mp4', token: 'SYNTHETIC-610C-OLD', videoUrl: 'https://example.com/610C.mp4', videoKey: managedKey('610C.mp4') }
  ], 'A1', { dryRun: true })
  const retainedTransferBefore = { ...retainedTransferDb.listings[0] }
  const originalFetch = global.fetch
  const originalUploadToOss = config.feishu.uploadToOss
  const originalRetryCount = config.feishu.materialTransferRetryCount
  const originalPutObjectBuffer = oss.putObjectBuffer
  const syntheticMissingPath = path.join(__dirname, '__synthetic_missing_media__', '610C.mp4')
  assert.strictEqual(fs.existsSync(syntheticMissingPath), false, '合成转存失败路径必须不存在，避免测试读取宿主文件')
  let syntheticFetchAttempts = 0
  let syntheticOssPutAttempts = 0
  let retainedTransferFailed
  try {
    // 无论宿主是否配置了真实 OSS，测试都用明确不存在的合成本地路径在读盘阶段稳定失败；
    // global.fetch 只作“不得联网”探针，若被调用即说明单测重新依赖了飞书/OSS 外部环境。
    config.feishu.uploadToOss = true
    config.feishu.materialTransferRetryCount = 0
    global.fetch = async () => {
      syntheticFetchAttempts += 1
      throw new Error('SYNTHETIC_TEST_MUST_NOT_USE_NETWORK')
    }
    oss.putObjectBuffer = async () => {
      syntheticOssPutAttempts += 1
      throw new Error('SYNTHETIC_TEST_MUST_NOT_UPLOAD_TO_OSS')
    }
    retainedTransferFailed = await feishuSync.applySync(retainedTransferDb, [
      row({
        区域: '闸弄口',
        小区: '京漾东韵府',
        几栋: '1',
        几单元: '2',
        房号: '610C',
        户型: '一室一厅一卫',
        押一付一: '2920'
      })
    ], [
      {
        name: '610C.mp4',
        token: 'SYNTHETIC-610C-NEW',
        key: 'synthetic-610c-material',
        sourcePath: 'SYNTHETIC/610C.mp4',
        localFilePath: syntheticMissingPath
      }
    ], 'A1', { dryRun: false })
  } finally {
    config.feishu.uploadToOss = originalUploadToOss
    config.feishu.materialTransferRetryCount = originalRetryCount
    oss.putObjectBuffer = originalPutObjectBuffer
    global.fetch = originalFetch
  }
  assert.strictEqual(syntheticFetchAttempts, 0, '飞书同步单测不得访问真实飞书或 OSS 网络')
  assert.strictEqual(syntheticOssPutAttempts, 0, '合成缺文件路径必须在读盘阶段失败，单测不得发起 OSS 写入')
  const retainedTransferListing = retainedTransferDb.listings[0]
  assert.strictEqual(retainedTransferFailed.materialTransferFailed, 1, '存量房源新素材转存失败也必须如实计数')
  assert.strictEqual(retainedTransferListing.videoKey, retainedTransferBefore.videoKey, '新素材转存失败不得抹掉存量受控视频')
  assert.strictEqual(retainedTransferListing.videoUrl, '', '新素材转存失败时仍须丢弃与受控 key 不同源的旧外链 URL')
  assert.strictEqual(retainedTransferListing.sourceMaterialToken, retainedTransferBefore.sourceMaterialToken, '转存失败时不得把新 token 绑定到旧视频，避免下轮错误复用')
  assert.strictEqual(retainedTransferListing.videoMaterialStatus, '沿用上次视频·素材待核', '转存失败沿用旧视频必须显式标记')
  assert.strictEqual(retainedTransferListing.videoMaterialFailureReason.length > 0, true, '沿用旧视频仍必须保留本轮转存失败原因')
  assert.strictEqual(retainedTransferListing.recommendationProfile.hasVideo, true, '转存失败但沿用旧视频时推荐画像仍应可播放')
  assert.ok((retainedTransferFailed.auditRows || []).some((item) => item.syncResult === '上架-沿用上次视频·转存待核' && item.failureReason), '转存失败沿用旧视频的逐行对账必须明确待核且保留原因')

  const retainedRecovered = await feishuSync.applySync(retainedTransferDb, [
    row({
      区域: '闸弄口',
      小区: '京漾东韵府',
      几栋: '1',
      几单元: '2',
      房号: '610C',
      户型: '一室一厅一卫',
      押一付一: '2920'
    })
  ], [
    { name: '610C.mp4', token: 'SYNTHETIC-610C-NEW', videoKey: managedKey('610C-new.mp4') }
  ], 'A1', { dryRun: true })
  const recoveredTransferListing = retainedTransferDb.listings[0]
  assert.strictEqual(retainedRecovered.updated, 1, '素材恢复后必须更新原房源')
  assert.strictEqual(recoveredTransferListing.missingVideoMaterial, false, '素材恢复后必须清除缺素材标记')
  assert.strictEqual(recoveredTransferListing.syncStatus, '已同步飞书', '素材恢复后必须恢复正常同步状态')
  assert.strictEqual(recoveredTransferListing.videoMaterialStatus, '已匹配视频素材', '素材恢复后必须恢复已匹配状态')
  assert.strictEqual(recoveredTransferListing.sourceMaterialToken, 'SYNTHETIC-610C-NEW', '素材恢复后必须绑定本轮成功的新 token')
  assert.strictEqual(recoveredTransferListing.videoKey, managedKey('610C-new.mp4'), '素材恢复后必须更新到本轮成功的新受控视频')
  assert.strictEqual('videoMaterialFailureReason' in recoveredTransferListing, false, '素材恢复后必须清除旧失败原因')

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
  const removedFootprint = db.footprints.find((item) => item.listingId === db.listings[0].id && item.actionType === 'listing_feishu_removed')
  assert.ok(removedFootprint, '飞书自动下架必须进入统一足迹入口')
  assert.deepStrictEqual(Object.keys(removedFootprint).sort(), ['id', 'viewerId', 'listingId', 'actionType', 'occurredAt', 'idempotencyKey'].sort(), '飞书自动下架足迹必须严格六字段')
  assert.strictEqual(removedFootprint.viewerId, 'A1', '操作者只能来自服务端同步身份')
  assert.ok(Number.isFinite(Date.parse(removedFootprint.occurredAt)), '发生时间必须由服务端生成 ISO 时间')

  const snapshot = feishuSync.sanitizeSheetSnapshot({
    title: '公司表 19800007777',
    sheetUrl: 'https://synthetic.feishu.example/sheets/PRIVATE_SHEET_TOKEN',
    range: 'PRIVATE_SHEET_TOKEN!A1:ZZ1000',
    cachedAt: '内部缓存时间',
    startRow: 7,
    startCol: 3,
    rows: [
      ['公司简介，联系电话：+86 198-0000-9999；座机：0571-12345678；微信号：private_wx_01'],
      ['备用联系 197 0000 8888'],
      ['区域', '小区', '房号', '联系电话', '户型描述', '看房方式密码', '备注', '微信号'],
      ['闸弄口', '京漾东韵府', '1-2-601D', '+86 139-0000-1111', '一室', '336699#', '水电自理', 'raw_wechat_02']
    ]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const snapshotText = JSON.stringify(snapshot)
  const compactSnapshotText = snapshotText.replace(/[+\s\-]/g, '')
  assert.ok(snapshotText.includes('联系电话'), '公司房源快照应保留联系电话列')
  ;['19800007777', '8619800009999', '19700008888', '8613900001111', '057112345678'].forEach((privatePhone) => {
    assert.ok(!compactSnapshotText.includes(privatePhone), `公司房源快照不得下发表头前简介或数据行私号 ${privatePhone}`)
  })
  ;['private_wx_01', 'raw_wechat_02'].forEach((privateWechat) => {
    assert.ok(!snapshotText.includes(privateWechat), `公司房源快照不得下发原始微信号 ${privateWechat}`)
  })
  ;['19900000001', '19900000002', '19900000003'].forEach((phone) => {
    assert.ok(snapshotText.includes(phone), `公司房源快照应保留服务器统一号码 ${phone}`)
  })
  assert.ok(snapshotText.includes('看房方式密码'), '公司房源快照应保留看房密码列')
  assert.ok(snapshotText.includes('336699'), '公司房源快照应保留看房密码内容')
  assert.ok(snapshotText.includes('1-2-601D'), '清洗联系方式时必须保留公司房号')
  assert.strictEqual(snapshot.columnCount, 8, '后置表头与数据行列数应一致')
  assert.strictEqual(snapshot.sensitiveStripped, true, '快照必须声明原始联系方式已替换')
  ;['sheetUrl', 'range', 'cachedAt', 'startRow', 'startCol', 'PRIVATE_SHEET_TOKEN'].forEach((privateMetadata) => {
    assert.ok(!snapshotText.includes(privateMetadata), `公开快照不得包含内部飞书定位元数据 ${privateMetadata}`)
  })

  const unsafeSnapshotTime = feishuSync.sanitizeSheetSnapshot({
    updatedAt: 'Tue, 14 Jul 2026 00:00:00 GMT (contact 19900007777)',
    rows: [['区域', '小区'], ['拱墅区', '合成小区']]
  }, { contactPhones: ['19900000001', '19900000002', '19900000003'] })
  assert.strictEqual(unsafeSnapshotTime.updatedAt, '', '公开快照不得原样返回可被 Date.parse 接受但夹带联系方式的核验时间')
  const safeSnapshotTime = feishuSync.sanitizeSheetSnapshot({
    updatedAt: '2026-07-14T10:20:30.000Z',
    rows: [['区域', '小区'], ['拱墅区', '合成小区']]
  }, { contactPhones: ['19900000001', '19900000002', '19900000003'] })
  assert.strictEqual(safeSnapshotTime.updatedAt, '2026-07-14T10:20:30.000Z', '公开快照必须保留严格合法的 ISO 更新时间')

  const contactVariantSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '公司表 188.0000.7777 wei xin:private_wei_xin_01 零宽 185\u200b0000\u200b6666 不可见 184\u20630000\u20635555 组合 183\u034f0000\ufe0f4444 中文 一八二零零零零三三三三 口语 幺八零零零零零幺幺幺幺 阿拉伯 ١٧٩٠٠٠٠٩٩٩٩ 键帽 1️⃣7️⃣8️⃣0️⃣0️⃣0️⃣0️⃣8️⃣8️⃣8️⃣8️⃣ 国家码 +86一七七零零零零七七七七 表情 181🫥0000🫥2222 日文点 187・0000・1111 阿拉伯逗号 187،0000،1111 字母 187a0000a1111 长字母 187abc0000abc1111 超长字母 187abcdefg0000abcdefg1111 汉字 187测试0000测试1111 伪地铁 187号线0000号线1111 安全词尾 139a1111a2222室 139a1111a2222房 139a1111a2222号房 139a1111a2222平方米 139a1111a2222㎡ 139a1111a2222m2 139a1111a2222元/月 139a1111a2222公里 客服4001234567 客服800a123a4567 电话88888888 电 话88888888 座机8888-8888 英文 tel:88888888 phone:8888-8888 p h o n e88888888 mobile:88888888 contact:88888888 Call 88888888 繁体 電話88888888 聯絡電話88888888 聯繫方式88888888 手機88888888 熱線88888888 聯絡88888888 噪声微信 微🫥信:privateid 微・信:privateid w🫥x:privateid we🫥chat:privateid v🫥信:privateid 合法数字 17号板块3号地铁5分钟1室1厅1卫2026年',
    rows: [
      ['备注 187/0000/8888 v信:private_vxin_01'],
      ['说明 186—0000—8888 微号:private_micro_01 we chat:private_we_chat_01'],
      ['1313室 统一咨询19900000001 私号19900000061 座机0571-88888888']
    ]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const contactVariantText = JSON.stringify(contactVariantSnapshot)
  const compactContactVariantText = contactVariantText.normalize('NFKC').replace(/[\u00AD\u034F\u180E\u200B-\u200F\u2060-\u206F\uFE00-\uFE0F\uFEFF+\s\-()./—]/g, '')
  ;['18800007777', '18700008888', '18600008888', '18500006666', '18400005555', '18300004444'].forEach((privatePhone) => {
    assert.ok(!compactContactVariantText.includes(privatePhone), `公开快照不得泄露点号/斜杠/长破折号拆分的私号 ${privatePhone}`)
  })
  ;['private_wei_xin_01', 'private_vxin_01', 'private_micro_01', 'private_we_chat_01'].forEach((privateWechat) => {
    assert.ok(!contactVariantText.includes(privateWechat), `公开快照不得泄露中英混写微信号 ${privateWechat}`)
  })
  ;['一八二零零零零三三三三', '幺八零零零零零幺幺幺幺', '١٧٩٠٠٠٠٩٩٩٩', '1️⃣7️⃣8️⃣0️⃣0️⃣0️⃣0️⃣8️⃣8️⃣8️⃣8️⃣', '+86一七七零零零零七七七七', '181🫥0000🫥2222'].forEach((privatePhone) => {
    assert.ok(!contactVariantText.includes(privatePhone), `公开快照不得泄露中文数字或表情分隔私号 ${privatePhone}`)
  })
  ;['187・0000・1111', '187،0000،1111', '187a0000a1111', '187abc0000abc1111', '187abcdefg0000abcdefg1111', '187测试0000测试1111', '187号线0000号线1111'].forEach((privatePhone) => {
    assert.ok(!contactVariantText.includes(privatePhone), `公开快照不得泄露任意字符或伪公共数字语义拆分的私号 ${privatePhone}`)
  })
  ;['139a1111a2222室', '139a1111a2222房', '139a1111a2222号房', '139a1111a2222平方米', '139a1111a2222㎡', '139a1111a2222m2', '139a1111a2222元/月', '139a1111a2222公里'].forEach((privatePhone) => {
    assert.ok(!contactVariantText.includes(privatePhone), `飞书快照不得用合法业务单位打断完整私号清洗 ${privatePhone}`)
    const isolatedSnapshotText = JSON.stringify(feishuSync.sanitizeSheetSnapshot({
      title: `公司表 ${privatePhone}`,
      rows: []
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    }))
    assert.ok(!isolatedSnapshotText.includes(privatePhone), `飞书快照单值场景不得用合法业务单位打断完整私号清洗 ${privatePhone}`)
  })
  assert.ok(contactVariantText.includes('17号板块3号地铁5分钟1室1厅1卫2026年'), '公开快照清洗私号时必须保留合法数字业务语义')
  assert.ok(contactVariantText.includes('19900000001'), '房号与私号相邻时必须完整保留服务器统一号码')
  assert.ok(!contactVariantText.includes('19900000061') && !contactVariantText.includes('0571-88888888'), '统一号码相邻的私号和座机仍必须完整脱敏')
  ;['4001234567', '800a123a4567', '电话88888888', '电 话88888888', '座机8888-8888', 'tel:88888888', 'phone:8888-8888', 'p h o n e88888888', 'mobile:88888888', 'contact:88888888', 'Call 88888888', '電話88888888', '聯絡電話88888888', '聯繫方式88888888', '手機88888888', '熱線88888888', '聯絡88888888', '微🫥信:privateid', '微・信:privateid', 'w🫥x:privateid', 'we🫥chat:privateid', 'v🫥信:privateid'].forEach((privateContact) => {
    assert.ok(!contactVariantText.includes(privateContact), `飞书快照不得泄露客服号、本地座机或噪声拆分微信 ${privateContact}`)
  })

  const adjacentContactCases = [
    '01064853453 19900000001',
    '19900000001 02112345678',
    '座机0571-88888888 标签 19900000001',
    '19900000001🫥010🫥6485🫥3453',
    '010a6485a3453标签19900000001',
    '0106485345319900000001',
    '4001234567 19900000001',
    '19900000001 800-123-4567'
  ]
  const adjacentContactSnapshot = feishuSync.sanitizeSheetSnapshot({ rows: adjacentContactCases.map((value) => [value]) }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const adjacentContactText = JSON.stringify(adjacentContactSnapshot)
  ;['01064853453', '02112345678', '0571-88888888', '010🫥6485🫥3453', '010a6485a3453', '4001234567', '800-123-4567'].forEach((privateContact) => {
    assert.ok(!adjacentContactText.includes(privateContact), `飞书快照相邻统一号码时不得泄露未配置电话 ${privateContact}`)
  })

  const isolatedFalseSafeSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '公司房源公开值独立测试',
    rows: [[FALSE_SAFE_SUFFIX_PHONE]]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const isolatedFalseSafeSnapshotText = JSON.stringify(isolatedFalseSafeSnapshot)
  assert.ok(!isolatedFalseSafeSnapshotText.includes(FALSE_SAFE_SUFFIX_PHONE), '飞书公司公开单值不得完整保留伪装成地铁语义的私号')

  const isolatedNoisyWechatSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '噪声拆分微信独立测试',
    rows: [[NOISY_WECHAT_GAP]]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  assert.ok(!JSON.stringify(isolatedNoisyWechatSnapshot).toLowerCase().includes(NOISY_WECHAT_ID), '飞书快照不得残留噪声拆分微信 ID realwx123')

  ;[NOISY_WECHAT_DECOY, ...GENERIC_ALPHA_CONTACTS].forEach((privateContact, index) => {
    const privateContactSnapshot = feishuSync.sanitizeSheetSnapshot({
      title: `通用字母联系方式独立测试 ${index + 1}`,
      rows: [[`安全文案 ${privateContact}`]]
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    })
    const privateContactText = JSON.stringify(privateContactSnapshot).toLowerCase()
    ;['realwx123', 'privateid', 'private_wx_01'].forEach((identifier) => {
      assert.ok(!privateContactText.includes(identifier), `飞书快照不得残留 decoy 或通用字母联系方式 ${identifier}：${privateContact}`)
    })
  })

  ;[FULLWIDTH_O_PHONE, ...MIXED_CHINESE_PHONE_VARIANTS].forEach((privatePhone, index) => {
    const privatePhoneSnapshot = feishuSync.sanitizeSheetSnapshot({
      title: `混合中文/全角 O 私号独立测试 ${index + 1}`,
      rows: [[`安全文案 ${privatePhone}`]]
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    })
    const privatePhoneText = JSON.stringify(privatePhoneSnapshot)
    const normalizedPrivatePhoneText = privatePhoneText.normalize('NFKC').replace(/[OoＯ]/g, '0').replace(/\D/g, '')
    assert.ok(!normalizedPrivatePhoneText.includes(index === 0 ? '18700001111' : '18800007777'), `飞书快照不得保留可归一还原的混合中文/全角 O 私号：${privatePhone}`)
    assert.ok(!privatePhoneText.includes(privatePhone), `飞书快照不得原样泄露混合中文/全角 O 私号：${privatePhone}`)
  })

  const isolatedTibetanPhoneSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '藏文数字私号独立测试',
    rows: [[TIBETAN_PHONE]]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const normalizedTibetanSnapshot = Array.from(JSON.stringify(isolatedTibetanPhoneSnapshot)).map((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint >= 0x0f20 && codePoint <= 0x0f29 ? String(codePoint - 0x0f20) : character
  }).join('').replace(/\D/g, '')
  assert.ok(!normalizedTibetanSnapshot.includes(PRIVATE_PHONE_DIGITS), '飞书快照不得保留或转写藏文数字私号')

  UNIT_PHONE_SMUGGLES.forEach((privateValue, index) => {
    const isolatedUnitPhoneSnapshot = feishuSync.sanitizeSheetSnapshot({
      title: `业务单位私号独立测试 ${index + 1}`,
      rows: [[privateValue]]
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    })
    const isolatedUnitPhoneText = JSON.stringify(isolatedUnitPhoneSnapshot)
    assert.ok(!isolatedUnitPhoneText.includes(privateValue), `飞书快照不得逐值完整保留业务单位拼接私号：${privateValue}`)
  })

  CONTACT_HEADER_CASES.forEach(({ header, privateValue }, index) => {
    const isolatedHeaderSnapshot = feishuSync.sanitizeSheetSnapshot({
      title: `敏感联系方式表头独立测试 ${index + 1}`,
      rows: [[header], [privateValue]]
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    })
    const isolatedHeaderText = JSON.stringify(isolatedHeaderSnapshot)
    assert.strictEqual(isolatedHeaderSnapshot.rows[1][0], '19900000001 / 19900000002 / 19900000003', `飞书表头 ${header} 对应数据整列必须替换为服务器统一号码`)
    assert.ok(!isolatedHeaderText.includes(privateValue), `飞书表头 ${header} 对应数据不得残留原始联系方式 ${privateValue}`)
  })

  const allowedAdjacentPrivateSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '统一号码与私号相邻独立测试',
    rows: [['统一19900000001 私号18700001111']]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const allowedAdjacentPrivateText = JSON.stringify(allowedAdjacentPrivateSnapshot)
  assert.ok(allowedAdjacentPrivateText.includes('19900000001'), '飞书单元中统一号码与私号相邻时必须保留统一号码')
  assert.ok(!allowedAdjacentPrivateText.includes('18700001111'), '飞书单元中统一号码与私号相邻时必须删除私号')
  assert.ok(!/YNZYALLOWED|[\uE000-\uF8FF]/u.test(allowedAdjacentPrivateText), '飞书公开快照不得残留内部号码保护哨兵或私用区字符')

  const positiveNumericSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '公司合法数字公开规则独立测试',
    rows: [
      ['区域', '小区', '房号', '看房方式密码', '备注'],
      ['拱墅区', '测试小区', '9-8-701', '88888888', `${VALID_DATE_COPY} ${COMPANY_ROAD_ADDRESS} 联系电话18800007777 ${PLACEHOLDER_LITERAL}`]
    ]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  const positiveNumericText = JSON.stringify(positiveNumericSnapshot)
  assert.ok(positiveNumericText.includes(VALID_DATE_COPY), '飞书快照必须原样保留合法日期与 ISO 时间')
  assert.ok(positiveNumericText.includes(COMPANY_ROAD_ADDRESS), '飞书快照必须原样保留缺少单元房号的道路门牌')
  assert.ok(positiveNumericText.includes('88888888'), '飞书快照必须原样保留公司 8 位门锁密码')
  assert.ok(positiveNumericText.includes(PLACEHOLDER_LITERAL), '飞书原文碰巧等于配置号码哨兵字面量时必须原样保留')
  assert.ok(!positiveNumericText.includes('18800007777'), '合法道路门牌同一备注字段中的私号仍必须删除')

  const structuralPhoneSnapshot = feishuSync.sanitizeSheetSnapshot({
    title: '地址结构不得白洗私号',
    rows: [['安全板块 18800007777栋1单元101室']]
  }, {
    contactPhones: ['19900000001', '19900000002', '19900000003']
  })
  assert.ok(!JSON.stringify(structuralPhoneSnapshot).replace(/\D/g, '').includes('18800007777'), '飞书地址结构不得把 11 位私号误当合法楼栋而白洗')

  LEGAL_PUBLIC_NUMERIC_VALUES.forEach((value, index) => {
    const isolatedLegalSnapshot = feishuSync.sanitizeSheetSnapshot({
      title: `合法业务数字独立测试 ${index + 1}`,
      rows: [[value]]
    }, {
      contactPhones: ['19900000001', '19900000002', '19900000003']
    })
    const isolatedLegalSnapshotText = JSON.stringify(isolatedLegalSnapshot)
    assert.ok(isolatedLegalSnapshotText.includes(value), `飞书快照必须逐值原样保留合法业务数字：${value}`)
  })

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

  assert.strictEqual(
    feishuSync._internal.roomIdentityKey({ community: '棠润府', building: '17', unit: '1', roomNumber: '1004A' }),
    '棠润府|17|1|1004A',
    '完整小区、楼栋、单元、房号应生成稳定物理键'
  )
  assert.strictEqual(
    feishuSync._internal.roomIdentityKey({ community: '棠润府', building: '-', unit: '无', roomNumber: '1004A' }),
    '',
    '楼栋占位值不应生成物理合并键'
  )
  assert.strictEqual(
    feishuSync._internal.roomIdentityKey({ community: '棠润府', building: 'null', roomNumber: '1004A' }),
    '',
    'null 占位值不应生成物理合并键'
  )
  assert.strictEqual(
    feishuSync.normalizeRecord(record('placeholder-room', {
      区域: '东新园',
      小区: '棠润府',
      几栋: '-',
      几单元: '无',
      房号: 'null',
      户型: '一室一厅一卫',
      押一付一: '3200'
    }), 4).roomIdentityKey,
    '',
    '飞书占位楼栋/房号归一后不得写入物理键'
  )

  const sparseDb = makeDb()
  sparseDb.listings.push(
    {
      id: 'SPARSE_A',
      externalSource: 'feishu',
      feishuRecordId: 'old-a',
      feishuRoomIdentityKey: '',
      community: '同小区',
      building: '',
      unit: '',
      roomNumber: '',
      status: '在租',
      lifecycleStatus: 'active'
    },
    {
      id: 'SPARSE_B',
      externalSource: 'feishu',
      feishuRecordId: 'old-b',
      feishuRoomIdentityKey: '',
      community: '同小区',
      building: '',
      unit: '',
      roomNumber: '',
      status: '在租',
      lifecycleStatus: 'active'
    }
  )
  const sparseIndex = feishuSync._internal.existingByExternalId(sparseDb)
  assert.strictEqual(sparseIndex.get('同小区'), undefined, '稀疏旧房源不得退化成小区名物理键')
  assert.strictEqual(sparseIndex.get('old-a').id, 'SPARSE_A', '稀疏旧房源仍应保留 record_id 精确索引')
  assert.strictEqual(sparseIndex.get('old-b').id, 'SPARSE_B', '稀疏旧房源不得互相覆盖')

  const reuseDb = makeDb()
  const reuseFirst = await feishuSync.applySync(reuseDb, [
    record('stable-a', {
      区域: '东新园',
      小区: '棠润府',
      几栋: '17',
      几单元: '1',
      房号: '1004A',
      户型: '一室一厅一卫',
      押一付一: '3200'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(reuseFirst.created, 1, '完整物理键首次同步应创建房源')
  const stableListingId = reuseDb.listings[0].id
  assert.strictEqual(reuseDb.listings[0].feishuRoomIdentityKey, '棠润府|17|1|1004A', '完整物理键应持久保存')

  const reuseSecond = await feishuSync.applySync(reuseDb, [
    record('stable-b', {
      区域: '东新园',
      小区: '棠润府',
      几栋: '17',
      几单元: '1',
      房号: '1004A',
      户型: '一室一厅一卫',
      押一付一: '3300'
    })
  ], [], 'A1', { dryRun: true })
  assert.strictEqual(reuseSecond.updated, 1, '同一物理房源 record_id 变化仍应复用原房源')
  assert.strictEqual(reuseDb.listings.length, 1, '物理键复用不应创建重复房源')
  assert.strictEqual(reuseDb.listings[0].id, stableListingId, 'record_id 变化后 listing.id 应保持稳定')
  assert.strictEqual(reuseDb.listings[0].feishuRecordId, 'stable-b', '复用后应更新为新的飞书 record_id')
  assert.strictEqual(reuseDb.listings[0].rent, 3300, '复用更新应写入新租金')
}

main().then(() => {
  console.log('feishu-sync-v1-test passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
