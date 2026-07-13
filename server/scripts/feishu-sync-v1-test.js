const assert = require('assert')
const feishuSync = require('../src/feishu-sync')

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
    { name: '601D.mp4', videoUrl: 'https://example.com/601D.mp4', videoKey: 'house-videos/601D.mp4' }
  ], 'A1', { dryRun: true })
  assert.ok(staleVideoDb.listings[0].videoUrl || staleVideoDb.listings[0].videoKey, '命中素材后应先写入视频字段')

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
  assert.strictEqual(staleMissingListing.videoUrl, '', '旧房源缺素材时必须清空旧 videoUrl')
  assert.strictEqual(staleMissingListing.videoKey, '', '旧房源缺素材时必须清空旧 videoKey')
  assert.strictEqual(staleMissingListing.recommendationProfile.hasVideo, false, '推荐画像也必须同步清空视频状态')

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
