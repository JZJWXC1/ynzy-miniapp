'use strict'

const assert = require('assert')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const mockData = require(path.join(repoRoot, 'utils', 'mock-data'))
const apiClientPath = require.resolve(path.join(repoRoot, 'utils', 'api-client'))
const apiServicePath = require.resolve(path.join(repoRoot, 'utils', 'api-service'))
const llmServicePath = require.resolve(path.join(repoRoot, 'utils', 'llm-service'))
const PUBLIC_SMUGGLED_PHONE = '19900007777'
const PUBLIC_SMUGGLED_ADDRESS = '9栋8单元701室'
const PUBLIC_LABELED_ROOM = '房号702'
const PUBLIC_STANDALONE_SECRET = '9 8 9813'
const PUBLIC_SINGLE_BUILDING = '9'
const PUBLIC_SINGLE_UNIT = '8'
const PUBLIC_MEDIA_RAW_SECRET = 'https://example.com/19900007777-9-8-701.mp4'
const PUBLIC_EXACT_ADDRESS_IN_BLOCK = 'PRIVATE-EXACT-BLOCK-LOCATION-XYZ'
const PUBLIC_EXACT_ADDRESS_IN_COMMUNITY = 'PRIVATE-EXACT-COMMUNITY-LOCATION-XYZ'
const PUBLIC_SENSITIVE_REMARK_COPY = 'PRIVATE-SENSITIVE-REMARK-COPY'
const MOCK_PUBLIC_VIDEO_URL = 'https://mock-media.invalid/listing-video.mp4'
const MOCK_PRIVATE_COMPANY_PHONE = '19900000061'
const MOCK_PRIVATE_COMPANY_LANDLINE = '057188888888'
const MOCK_PRIVATE_COMPANY_WECHAT = 'private_wx_61'
const MOCK_PRIVATE_COMPANY_ZERO_WIDTH_PHONE = '187\u200b0000\u200b1111'
const MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE = '186\u20630000\u20632222'
const MOCK_PRIVATE_COMPANY_COMBINING_PHONE = '185\u034f0000\ufe0f3333'
const MOCK_PRIVATE_COMPANY_CHINESE_PHONE = '一八七零零零零一一一一'
const MOCK_PRIVATE_COMPANY_FINANCIAL_PHONE = '壹捌柒零零零零壹壹壹壹'
const MOCK_PRIVATE_COMPANY_EMOJI_PHONE = '187🫥0000🫥1111'
const MOCK_CHAINED_CONFUSABLE_PHONES = '187🫥0000🫥1111\u200b186🫥0000🫥2222'
const MOCK_KATAKANA_PHONE = '187・0000・1111'
const MOCK_ARABIC_COMMA_PHONE = '187،0000،1111'
const MOCK_ALPHA_PHONE = '187a0000a1111'
const MOCK_LONG_ALPHA_PHONE = '187abc0000abc1111'
const MOCK_VERY_LONG_ALPHA_PHONE = '187abcdefg0000abcdefg1111'
const MOCK_HAN_GAP_PHONE = '187测试0000测试1111'
const MOCK_FALSE_SAFE_SUFFIX_PHONE = '187号线0000号线1111'
const MOCK_SERVICE_PHONES = ['4001234567', '400-123-4567', '400a123a4567', '8001234567', '800a123a4567']
const MOCK_LABELED_LOCAL_PHONES = ['电话88888888', '电 话88888888', '座机8888-8888', '热线8888a8888', '客服8888🫥8888', '联系电话8888测试8888']
const MOCK_ENGLISH_LOCAL_PHONES = ['tel:88888888', 'phone:8888-8888', 'p h o n e88888888', 'mobile:88888888', 'contact:88888888', 'Call 88888888']
const MOCK_TRADITIONAL_LOCAL_PHONES = ['電話88888888', '聯絡電話88888888', '聯繫方式88888888', '手機88888888', '熱線88888888', '聯絡88888888']
const MOCK_NOISY_WECHAT_IDS = ['微🫥信:privateid', '微・信:privateid', 'w🫥x:privateid', 'we🫥chat:privateid', 'v🫥信:privateid']
const MOCK_ADDRESS_PHONE_SMUGGLES = ['房号139a1111a2222', '房号139🫥1111🫥2222', '房号一三九一一一一二二二二', '139a1111a2222室', '139a1111a2222房', '139a1111a2222号房', '路139a1111a2222号', '139a1111a2222楼', '139a1111a2222平方米', '139a1111a2222㎡', '139a1111a2222m2', '139a1111a2222元/月', '139a1111a2222公里']
const MOCK_PRIVATE_COMPANY_YAO_PHONE = '幺八七零零零零幺幺幺幺'
const MOCK_PRIVATE_COMPANY_ARABIC_PHONE = '١٨٧٠٠٠٠١١١١'
const MOCK_PRIVATE_COMPANY_KEYCAP_PHONE = '1️⃣8️⃣7️⃣0️⃣0️⃣0️⃣0️⃣1️⃣1️⃣1️⃣1️⃣'
const MOCK_PRIVATE_COMPANY_COUNTRY_PHONE = '+86一八七零零零零一一一一'
const PUBLIC_FINANCIAL_ADDRESS = '玖栋捌单元柒零壹室'
const PUBLIC_EMOJI_ADDRESS = '9🏠栋8🔑单元701室'
const PUBLIC_PUNCTUATED_ADDRESS = '9・栋8・单元701・室'
const PUBLIC_PUNCTUATED_COMPOSITE_ADDRESS = '9・8・701'
const PUBLIC_PUNCTUATED_ROOM_LABEL = '房号・701'
const PUBLIC_ALPHA_GAP_ADDRESS = '9abc栋8abc单元701abc室'
const PUBLIC_HAN_GAP_ADDRESS = '9测试栋8测试单元701测试室'
const PUBLIC_ALPHA_COMPOSITE_ADDRESS = '9abc8abc701'
const PUBLIC_FINANCIAL_WORD_ADDRESS = '柒佰零壹室'
const PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS = '柒🫥佰🫥零🫥壹🫥室'
const PUBLIC_ENGLISH_ADDRESS_LABELS = [
  'Room 701', 'Room 7Ｏ1', 'R o o m 701', 'room🫥701', 'Apt 701', 'Apartment 701',
  'Flat 701', 'Floor 9', 'Level 9', 'Tower 9', 'Block 9',
  'Unit 8', 'Unit B', 'Building 9', 'Building A', 'Bldg 9', 'No. 701'
]
const PUBLIC_CHINESE_ADDRESS_LABELS = ['9#楼', '9楼', '楼号9', '701户', '701门', '701号', '房间号701', '文一西路玖佰陆拾玖号']
const PUBLIC_TRADITIONAL_ADDRESS_LABELS = ['9棟', '8單元', 'A栋', 'A棟', 'B单元', 'B單元', '樓棟A', '楼栋A', '701號房', '房號701', '門牌號701', '樓棟9', '玖號樓', '玖棟捌單元柒零壹室']
const PUBLIC_SAFE_ENGLISH_NUMERIC_COPY = '2 rooms · unit price follows'
const PUBLIC_SEMANTIC_DIGITS = '3号线5分钟到188路公交站'
const PUBLIC_PHONE_SHAPED_SEMANTICS = '17号板块3号地铁5分钟1室1厅1卫2026年'
const PUBLIC_LEGAL_NUMERIC_LAYOUTS = [
  '17㎡三室1厅1卫',
  '17m²三室',
  '17m2三室',
  '17平方米三室'
]
const PUBLIC_NOISY_WECHAT_GAP = '微 信 a realwx123'
const PUBLIC_NOISY_WECHAT_DECOY = '微 信 abcdef realwx123'
const PUBLIC_NOISY_WECHAT_ID = 'realwx123'
const PUBLIC_GENERIC_ALPHA_CONTACTS = ['联系方式 privateid', '联系方式 private_wx_01', '联系房东 privateid', '联络方式 privateid', 'contact privateid']
const PUBLIC_EXACT_ADDRESS_NOISE_VARIANTS = [
  '推荐文一\uE000路万塘汇周边',
  '推荐文一§路万塘汇周边',
  '推荐文一测试路万塘汇周边',
  '推荐文一Ж路万塘汇周边'
]
const PUBLIC_FULLWIDTH_O_PHONE = '187000Ｏ1111'
const PUBLIC_MIXED_CHINESE_PHONE_VARIANTS = [
  '一八八测试零零零零测试七七七七',
  '壹捌捌测试零零零零测试柒柒柒柒',
  '一八八abc零零零零abc七七七七',
  '一八八🫥零零零零🫥七七七七'
]
const PUBLIC_VALID_DATE_COPY = '开放日期2026-07-14 更新时间2026-07-14T10:20:30.000Z'
const COMPANY_EIGHT_DIGIT_DOOR_PASSWORD = '88888888'
const COMPANY_ROAD_ADDRESS = '杭州市拱墅区文一西路969号园区北门'
const PUBLIC_TIBETAN_PHONE = '\u0f21\u0f28\u0f27\u0f20\u0f20\u0f20\u0f20\u0f21\u0f21\u0f21\u0f21'
const PUBLIC_PRIVATE_PHONE_DIGITS = '18700001111'
const PUBLIC_UNIT_PHONE_SMUGGLES = [
  '18㎡700㎡001㎡111㎡',
  '18公里700公里001公里111公里',
  '18元/月700元/月001元/月111元/月',
  '18号线7室0室0室00号线1室1室1室1室'
]
const PUBLIC_WANYANG_ADDRESS = '文一路万塘汇'
const PUBLIC_WANYANG_ADDRESS_VARIANTS = ['推荐文一🫥路万塘汇周边', '推荐文一·路万塘汇周边', ...PUBLIC_EXACT_ADDRESS_NOISE_VARIANTS]
const PUBLIC_ENGLISH_SUITE = 'Suite 888'
const PUBLIC_ADJACENT_CONTACT_COPY = '前置私号18700001111 统一19900000001 后置私号18600002222'
const MOCK_COMPANY_PUBLIC_PHONE = '19900000001'
const MOCK_PLACEHOLDER_COLLISION = '__YNZY_ALLOWED_PHONE_A__'

function listingPayload(roomNumber, source, overrides = {}) {
  return {
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '东新',
    communityName: '京漾东韵府',
    community: '京漾东韵府',
    building: '1',
    unit: '1',
    roomNumber,
    address: `杭州拱墅区京漾东韵府1栋1单元${roomNumber}室`,
    contact: '19900000061',
    landlordPhone: '19900000061',
    rent: 3200,
    layout: '整租两室1厅1卫',
    rentMode: '整租',
    room: '两室',
    hall: '1厅',
    bath: '1卫',
    features: ['电梯'],
    videoUrl: 'https://example.com/public-room-video.mp4',
    videoKey: `house-videos/synthetic/mock-preview-${roomNumber}.mp4`,
    viewingMethod: '联系房东',
    ownerType: source,
    houseSourceType: source,
    source,
    landlordCommissionPercent: 50,
    ...overrides
  }
}

function addListing(roomNumber, source, overrides) {
  const current = Date.now()
  while (Date.now() === current) {}
  return mockData.addNormalListing(listingPayload(roomNumber, source, overrides))
}

function ids(rows) {
  return (rows || []).map((item) => item.id).sort()
}

function mapIds(rows) {
  return Array.from(new Set((rows || []).flatMap((item) => item.activeListingIds || []))).sort()
}

function assertGuestAssistantRows(rows, message) {
  const partnerRows = (rows || []).filter((item) => !item.companyListing)
  assert.ok(partnerRows.length > 0, `${message}：必须包含业主或二房东房源`)
  partnerRows.forEach((row) => {
    ;['building', 'unit', 'roomNumber', 'roomAddress', 'address', 'landlordPhone', 'contact', 'viewingMethod', 'viewingMethodText', 'viewingKeyLocation', 'viewingPassword', 'remark', 'uploader', 'uploaderId', 'reviewStatus', 'requiresManualReview', 'manualReviewReason', 'communityMatched', 'communityMatchStatus'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `${message}：游客合作卡片不得下发 ${field}`)
    })
    assert.ok(!String(row.sub || '').includes('上传人'), `${message}：游客合作卡片不得显示上传人`)
    const text = JSON.stringify(row)
    assert.ok(!text.includes(PUBLIC_SMUGGLED_PHONE), `${message}：公共字符串不得夹带手机号`)
    assert.ok(!text.includes(PUBLIC_SMUGGLED_ADDRESS), `${message}：公共字符串不得夹带楼栋单元房号`)
    assert.ok(!text.includes(PUBLIC_LABELED_ROOM), `${message}：公共字符串不得夹带显式标注房号`)
    assert.ok(!text.includes(PUBLIC_EXACT_ADDRESS_IN_BLOCK) && !text.includes(PUBLIC_EXACT_ADDRESS_IN_COMMUNITY), `${message}：公共字符串不得把完整地址值复制进板块或小区`)
    assert.ok(!text.includes(PUBLIC_SENSITIVE_REMARK_COPY), `${message}：公共字符串不得把敏感备注复制进板块`)
    assert.ok(!text.includes(PUBLIC_STANDALONE_SECRET), `${message}：公共字符串不得夹带空格分隔的楼栋单元房号`)
    assert.ok(!/(?:^|\s)9\s+8(?:\s|$)/.test(String(row.block || '')), `${message}：公共板块不得残留空格分隔的楼栋单元`)
    assert.ok(!/(?:^|\s)9(?:\s|$)/.test(String(row.block || '')), `${message}：公共板块不得残留单独夹带的一位数楼栋`)
    assert.ok(!/(?:^|\s)8(?:\s|$)/.test(String(row.layout || '')), `${message}：公开户型不得残留单独夹带的一位数单元`)
    assert.ok(!text.includes(PUBLIC_MEDIA_RAW_SECRET), `${message}：Mock 公共投影不得下发夹带敏感值的原视频 URL`)
  })
}

function assertAuthenticatedPartnerDisplay(row, rawListing, message, options = {}) {
  assert.ok(row && row.id, `${message}：必须返回合作房源`)
  ;['building', 'unit', 'roomNumber', 'roomAddress', 'address', 'landlordPhone', 'contact', 'viewingMethod', 'viewingMethodText', 'viewingKeyLocation', 'viewingPassword', 'remark', 'uploaderId'].forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `${message}：登录但未 sensitive-view 仍不得下发 ${field}`)
  })
  ;['reviewStatus', 'requiresManualReview', 'manualReviewReason', 'communityMatched', 'communityMatchStatus'].forEach((field) => {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `${message}：必须恢复登录态非敏感字段 ${field}`)
    assert.strictEqual(row[field], rawListing[field], `${message}：${field} 必须来自服务端数据层`)
  })
  if (options.detail) {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploader'), `${message}：详情不得新增 uploader`)
  } else {
    assert.ok(String(row.sub || '').includes('上传人 刘洋'), `${message}：卡片 sub 必须恢复可信 Mock 会话对应上传人文案`)
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploader'), `${message}：不得新增 uploader 对象字段`)
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploaderId'), `${message}：不得下发 uploaderId`)
}

function assertCompanyPublicContactSafe(value, message) {
  const serialized = JSON.stringify(value || {})
  assert.ok(!/YNZYALLOWED|[\uE000-\uF8FF]/u.test(serialized), `${message} 不得残留内部号码保护哨兵或私用区字符`)
  const visit = (current, pathText) => {
    if (typeof current === 'string') {
      const normalized = current.normalize('NFKC')
      const digits = normalized.replace(/\D/g, '')
      assert.ok(!digits.includes(MOCK_PRIVATE_COMPANY_PHONE), `${message}${pathText} 不得夹带非配置手机`)
      assert.ok(!digits.includes(MOCK_PRIVATE_COMPANY_LANDLINE), `${message}${pathText} 不得夹带座机`)
      assert.ok(!digits.includes(MOCK_PRIVATE_COMPANY_ZERO_WIDTH_PHONE.replace(/\D/g, '')), `${message}${pathText} 不得夹带零宽字符拆分手机`)
      assert.ok(!digits.includes(MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE.replace(/\D/g, '')), `${message}${pathText} 不得夹带默认不可见字符拆分手机`)
      assert.ok(!digits.includes(MOCK_PRIVATE_COMPANY_COMBINING_PHONE.replace(/\D/g, '')), `${message}${pathText} 不得夹带组合字符拆分手机`)
      assert.ok(!normalized.toLowerCase().includes(MOCK_PRIVATE_COMPANY_WECHAT), `${message}${pathText} 不得夹带显式微信号`)
      ;[MOCK_PRIVATE_COMPANY_CHINESE_PHONE, MOCK_PRIVATE_COMPANY_FINANCIAL_PHONE, MOCK_PRIVATE_COMPANY_YAO_PHONE, MOCK_PRIVATE_COMPANY_ARABIC_PHONE, MOCK_PRIVATE_COMPANY_KEYCAP_PHONE, MOCK_PRIVATE_COMPANY_COUNTRY_PHONE, MOCK_PRIVATE_COMPANY_EMOJI_PHONE, PUBLIC_FULLWIDTH_O_PHONE, ...PUBLIC_MIXED_CHINESE_PHONE_VARIANTS].forEach((privatePhone) => {
        assert.ok(!normalized.includes(privatePhone), `${message}${pathText} 不得夹带中文数字或非标分隔手机`)
      })
      ;[...MOCK_SERVICE_PHONES, ...MOCK_LABELED_LOCAL_PHONES, ...MOCK_ENGLISH_LOCAL_PHONES, ...MOCK_TRADITIONAL_LOCAL_PHONES, ...MOCK_NOISY_WECHAT_IDS, ...MOCK_ADDRESS_PHONE_SMUGGLES].forEach((privateContact) => {
        assert.ok(!normalized.includes(privateContact), `${message}${pathText} 不得夹带客服号、本地座机或噪声拆分微信 ${privateContact}，实际：${normalized}`)
      })
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${pathText}[${index}]`))
      return
    }
    if (current && typeof current === 'object') {
      Object.keys(current).forEach((key) => visit(current[key], `${pathText}.${key}`))
    }
  }
  visit(value, '')
}

async function run() {
  mockData.loginByPhone('13800010004')
  mockData.updateCommissionConfig({
    secondLandlordRate: 12,
    ownerRate: 18,
    secondLandlordPlatformRate: 10,
    ownerPlatformRate: 10
  })
  const company = addListing('9811', '公司房源', {
    companyListing: true,
    isCompanyListing: true
  })
  const otherDistrictCompany = addListing('9812', '公司房源', {
    companyListing: true,
    isCompanyListing: true,
    district: '上城区',
    area: '上城区',
    block: '闸弄口',
    communityName: '长木府',
    community: '长木府',
    address: '杭州上城区长木府1栋1单元9812室'
  })
  const corruptRent = addListing('9822', '二房东房源', {
    rent: PUBLIC_SMUGGLED_PHONE
  })
  const corruptLandlineRent = addListing('9823', '二房东房源', {
    rent: '057112345678'
  })
  const contactSmuggledCompany = addListing(`9821室 ＶＸ：${MOCK_PRIVATE_COMPANY_WECHAT}`, '公司房源', {
    city: `杭州 ＋８６（１９９）００００－００６１ 零宽 ${MOCK_PRIVATE_COMPANY_ZERO_WIDTH_PHONE} 不可见 ${MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE} 组合 ${MOCK_PRIVATE_COMPANY_COMBINING_PHONE} 中文 ${MOCK_PRIVATE_COMPANY_CHINESE_PHONE} 大写 ${MOCK_PRIVATE_COMPANY_FINANCIAL_PHONE} 口语 ${MOCK_PRIVATE_COMPANY_YAO_PHONE} 阿拉伯 ${MOCK_PRIVATE_COMPANY_ARABIC_PHONE} 键帽 ${MOCK_PRIVATE_COMPANY_KEYCAP_PHONE} 国家码 ${MOCK_PRIVATE_COMPANY_COUNTRY_PHONE} 表情 ${MOCK_PRIVATE_COMPANY_EMOJI_PHONE} 日文点 ${MOCK_KATAKANA_PHONE} 阿拉伯逗号 ${MOCK_ARABIC_COMMA_PHONE} 字母 ${MOCK_ALPHA_PHONE} 长字母 ${MOCK_LONG_ALPHA_PHONE} 超长字母 ${MOCK_VERY_LONG_ALPHA_PHONE} 汉字间隔 ${MOCK_HAN_GAP_PHONE} 伪地铁 ${MOCK_FALSE_SAFE_SUFFIX_PHONE} ${MOCK_SERVICE_PHONES.join(' ')} ${MOCK_LABELED_LOCAL_PHONES.join(' ')} ${MOCK_ENGLISH_LOCAL_PHONES.join(' ')} ${MOCK_TRADITIONAL_LOCAL_PHONES.join(' ')} ${MOCK_NOISY_WECHAT_IDS.join(' ')} ${MOCK_ADDRESS_PHONE_SMUGGLES.join(' ')}`,
    district: `拱墅区 （０５７１）８８８８－８８８８`,
    area: `拱墅区 （０５７１）８８８８－８８８８`,
    block: `东新 ＋８６（１９９）００００－００６１`,
    communityName: `京漾东韵府 微信号：${MOCK_PRIVATE_COMPANY_WECHAT}`,
    community: `京漾东韵府 微信号：${MOCK_PRIVATE_COMPANY_WECHAT}`,
    building: `2栋 联系微信 ${MOCK_PRIVATE_COMPANY_WECHAT}`,
    unit: '3单元 （０５７１）８８８８－８８８８',
    address: `杭州拱墅区京漾东韵府2栋3单元1313室 ${MOCK_PLACEHOLDER_COLLISION} 统一咨询${MOCK_COMPANY_PUBLIC_PHONE} 私号＋８６（１９９）００００－００６１ 座机（０５７１）８８８８－８８８８ ${PUBLIC_ADJACENT_CONTACT_COPY} 微信号：${MOCK_PRIVATE_COMPANY_WECHAT}`,
    layout: `整租一室 ＷＸ：${MOCK_PRIVATE_COMPANY_WECHAT}`,
    rentMode: `整租 ＷＸ：${MOCK_PRIVATE_COMPANY_WECHAT}`,
    room: '一室 ＋８６（１９９）００００－００６１',
    hall: '1厅 （０５７１）８８８８－８８８８',
    bath: `1卫 wechat:${MOCK_PRIVATE_COMPANY_WECHAT}`,
    contact: MOCK_PRIVATE_COMPANY_PHONE,
    landlordPhone: MOCK_PRIVATE_COMPANY_PHONE,
    viewingMethod: '密码',
    viewingPassword: `门锁 2468 联系微信 ${MOCK_PRIVATE_COMPANY_WECHAT}`,
    viewingKeyLocation: '前台抽屉 ＋８６（１９９）００００－００６１'
  })

  mockData.loginByPhone('13800010005')
  const owner = addListing('9813', '业主房源', {
    building: PUBLIC_SINGLE_BUILDING,
    unit: PUBLIC_SINGLE_UNIT,
    address: PUBLIC_EXACT_ADDRESS_IN_BLOCK,
    block: `东新 ${PUBLIC_STANDALONE_SECRET} 单独楼栋 ${PUBLIC_SINGLE_BUILDING} ${PUBLIC_SMUGGLED_PHONE} ${PUBLIC_SMUGGLED_ADDRESS} ${PUBLIC_LABELED_ROOM} 七〇一室 7O1室 ${PUBLIC_FINANCIAL_ADDRESS} ${PUBLIC_EMOJI_ADDRESS} ${PUBLIC_PUNCTUATED_ADDRESS} ${PUBLIC_PUNCTUATED_COMPOSITE_ADDRESS} ${PUBLIC_PUNCTUATED_ROOM_LABEL} ${PUBLIC_ALPHA_GAP_ADDRESS} ${PUBLIC_HAN_GAP_ADDRESS} ${PUBLIC_ALPHA_COMPOSITE_ADDRESS} ${PUBLIC_FINANCIAL_WORD_ADDRESS} ${PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS} ${PUBLIC_ENGLISH_ADDRESS_LABELS.join(' ')} ${PUBLIC_CHINESE_ADDRESS_LABELS.join(' ')} ${PUBLIC_TRADITIONAL_ADDRESS_LABELS.join(' ')} ${MOCK_PRIVATE_COMPANY_CHINESE_PHONE} ${MOCK_PRIVATE_COMPANY_YAO_PHONE} ${MOCK_PRIVATE_COMPANY_ARABIC_PHONE} ${MOCK_PRIVATE_COMPANY_KEYCAP_PHONE} ${MOCK_PRIVATE_COMPANY_COUNTRY_PHONE} ${MOCK_PRIVATE_COMPANY_EMOJI_PHONE} ${MOCK_CHAINED_CONFUSABLE_PHONES} ${MOCK_KATAKANA_PHONE} ${MOCK_ARABIC_COMMA_PHONE} ${MOCK_ALPHA_PHONE} ${MOCK_LONG_ALPHA_PHONE} ${MOCK_VERY_LONG_ALPHA_PHONE} ${MOCK_HAN_GAP_PHONE} ${MOCK_FALSE_SAFE_SUFFIX_PHONE} ${MOCK_SERVICE_PHONES.join(' ')} ${MOCK_LABELED_LOCAL_PHONES.join(' ')} ${MOCK_ENGLISH_LOCAL_PHONES.join(' ')} ${MOCK_TRADITIONAL_LOCAL_PHONES.join(' ')} ${MOCK_NOISY_WECHAT_IDS.join(' ')} ${PUBLIC_EXACT_ADDRESS_IN_BLOCK} ${PUBLIC_SENSITIVE_REMARK_COPY} ${PUBLIC_SEMANTIC_DIGITS} ${PUBLIC_PHONE_SHAPED_SEMANTICS} ${PUBLIC_SAFE_ENGLISH_NUMERIC_COPY}`,
    communityName: `京漾东韵府 ${MOCK_PRIVATE_COMPANY_ZERO_WIDTH_PHONE} ${MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE} ${MOCK_PRIVATE_COMPANY_COMBINING_PHONE} ${PUBLIC_EXACT_ADDRESS_IN_COMMUNITY}`,
    community: `京漾东韵府 ${MOCK_PRIVATE_COMPANY_ZERO_WIDTH_PHONE} ${MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE} ${MOCK_PRIVATE_COMPANY_COMBINING_PHONE} ${PUBLIC_EXACT_ADDRESS_IN_COMMUNITY}`,
    viewingPassword: PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
    remark: PUBLIC_SENSITIVE_REMARK_COPY,
    layout: `整租两室1厅1卫 单独单元 ${PUBLIC_SINGLE_UNIT} ${PUBLIC_SMUGGLED_PHONE} ${PUBLIC_SMUGGLED_ADDRESS}`,
    videoUrl: PUBLIC_MEDIA_RAW_SECRET
  })
  const secondLandlord = addListing('101', '二房东房源', {
    block: '17号板块',
    communityName: '101国际城',
    community: '101国际城',
    building: '17',
    unit: '1',
    roomNumber: '101',
    address: '杭州拱墅区101国际城17栋1单元101室',
    layout: '17㎡三室1厅1卫 17m²三室 17m2三室 17平方米三室',
    room: '三室'
  })

  const failures = []
  let guestCommissionWithResidualMockUser = null
  async function check(name, assertion) {
    try {
      await assertion()
    } catch (error) {
      failures.push({ name, error })
      console.error(`[RED] ${name}: ${error.message}`)
    }
  }

  await check('Mock 公司公开投影值级清除私号/座机/微信且保留原公开规则', () => {
    const listRow = mockData.getListings({ category: '公司房源' }).find((item) => item.id === contactSmuggledCompany.id)
    const homeRow = mockData.getHomeListings({ publicGuest: true }).find((item) => item.id === contactSmuggledCompany.id)
    const matchRow = mockData.matchListings({ companyOnly: true, budget: 4000 }).listings.find((item) => item.id === contactSmuggledCompany.id)
    const detail = mockData.getListingDetail(contactSmuggledCompany.id, { publicGuest: true })
    const detailAgain = mockData.getListingDetail(contactSmuggledCompany.id, { publicGuest: true })
    const mapRow = mockData.getMapPins({ sourceType: '公司房源' }).find((item) => item.id === contactSmuggledCompany.id)
    const nearbyRow = mockData.getNearbyListings(owner.id, { publicGuest: true }).listings.find((item) => item.id === contactSmuggledCompany.id)
    const legacySensitive = mockData.addSensitiveFootprint(contactSmuggledCompany.id, 'SV-MOCK-COMPANY-CONTACT-001').sensitive

    mockData.setFavorite(contactSmuggledCompany.id, true)
    const favoriteRow = mockData.getFavorites({}).find((item) => item.id === contactSmuggledCompany.id)
    mockData.setFavorite(contactSmuggledCompany.id, false)

    ;[
      ['列表', listRow],
      ['首页', homeRow],
      ['匹配', matchRow],
      ['详情', detail],
      ['地图', mapRow],
      ['附近', nearbyRow],
      ['收藏', favoriteRow],
      ['旧版敏感查看兼容', legacySensitive]
    ].forEach(([label, row]) => {
      assert.ok(row, `Mock 公司${label}入口必须返回合成房源`)
      assertCompanyPublicContactSafe(row, `Mock 公司${label}`)
    })

    assert.deepStrictEqual(detailAgain, detail, '公司公开投影重复读取必须幂等且不得逐次破坏正文')
    assert.ok(String(detail.building || '').includes('2栋'), '公司楼栋正文必须照旧公开')
    assert.ok(String(detail.unit || '').includes('3单元'), '公司单元正文必须照旧公开')
    assert.ok(String(detail.roomNumber || '').includes('9821室'), '公司房号正文必须照旧公开')
    assert.ok(String(detail.address || '').includes('2栋3单元1313室'), '公司完整地址必须照旧公开')
    assert.ok(String(detail.address || '').includes(MOCK_COMPANY_PUBLIC_PHONE), `地址中服务器配置号码必须保留，实际：${detail.address}`)
    assert.ok(!String(detail.address || '').includes('18700001111') && !String(detail.address || '').includes('18600002222'), 'Mock 公司统一号码前后的两个私号必须同时删除')
    assert.ok(String(detail.address || '').includes(MOCK_PLACEHOLDER_COLLISION), 'Mock 公司原始文案碰巧等于内部占位符时不得被改写')
    assert.ok(!/YNZYALLOWED|[\uE000-\uF8FF]/u.test(JSON.stringify(detail)), 'Mock 公司公开详情不得残留内部号码保护哨兵或私用区字符')
    assert.ok(String(detail.viewingPassword || '').includes('门锁 2468'), '公司看房密码正文必须照旧公开')
    assert.ok(String(detail.viewingKeyLocation || '').includes('前台抽屉'), '公司钥匙位置正文必须照旧公开')
    assert.deepStrictEqual(detail.companyContactPhones, ['19900000001', '19900000002', '19900000003'])
    assert.strictEqual(detail.landlordPhone, MOCK_COMPANY_PUBLIC_PHONE)
    assert.strictEqual(detail.contact, MOCK_COMPANY_PUBLIC_PHONE)
    assert.ok(!mockData.getListings({ category: '公司房源', block: MOCK_PRIVATE_COMPANY_PHONE }).some((item) => item.id === contactSmuggledCompany.id), '公司私号不得成为列表筛选 oracle')
    assert.ok(!mockData.matchListings({ companyOnly: true, area: MOCK_PRIVATE_COMPANY_PHONE }).listings.some((item) => item.id === contactSmuggledCompany.id), '公司私号不得成为匹配 oracle')
  })

  await check('Mock 列表 district 与服务端一致', () => {
    const districtRows = mockData.getListings({ district: '拱墅区' })
    assert.deepStrictEqual(ids(districtRows), [company.id, contactSmuggledCompany.id, owner.id, secondLandlord.id, corruptRent.id, corruptLandlineRent.id].sort())
    assert.ok(!ids(districtRows).includes(otherDistrictCompany.id), 'district 不得被忽略')
  })

  await check('Mock 卡片动态佣金、媒体字段与服务端一致', () => {
    const rows = mockData.getListings({})
    const companyRow = rows.find((item) => item.id === company.id)
    const ownerRow = rows.find((item) => item.id === owner.id)
    const secondLandlordRow = rows.find((item) => item.id === secondLandlord.id)
    const corruptRentRow = rows.find((item) => item.id === corruptRent.id)
    const corruptLandlineRentRow = rows.find((item) => item.id === corruptLandlineRent.id)
    assert.ok(companyRow && ownerRow && secondLandlordRow && corruptRentRow && corruptLandlineRentRow)
    assert.strictEqual(companyRow.tag, '公司房源')
    assert.ok(companyRow.sub.includes('公司房源成交不抽佣，带看中介全佣'))
    assert.ok(!companyRow.sub.includes('30%'), '公司房源不得显示历史 30%')
    assert.strictEqual(ownerRow.tag, '18%')
    assert.ok(ownerRow.sub.includes('28%'))
    assert.strictEqual(secondLandlordRow.tag, '12%')
    assert.ok(secondLandlordRow.sub.includes('22%'))
    assert.strictEqual(secondLandlordRow.block, '17号板块', 'Mock 不得把短数字楼栋从合法板块名中误删')
    assert.strictEqual(secondLandlordRow.community, '101国际城', 'Mock 不得把短数字房号从合法小区名中误删')
    assert.strictEqual(secondLandlordRow.layout, '17㎡三室1厅1卫 17m²三室 17m2三室 17平方米三室', 'Mock 不得把面积单位后的三室误判为精确房号')
    const ownerText = JSON.stringify(ownerRow)
    assert.ok(!ownerText.includes('187\u200b0000\u200b1111'), 'Mock 合作房源不得泄露零宽字符拆分的手机号')
    assert.ok(!ownerText.includes(MOCK_PRIVATE_COMPANY_INVISIBLE_PHONE) && !ownerText.includes(MOCK_PRIVATE_COMPANY_COMBINING_PHONE), 'Mock 合作房源不得泄露默认不可见或组合字符拆分的手机号')
    ;[MOCK_PRIVATE_COMPANY_CHINESE_PHONE, MOCK_PRIVATE_COMPANY_YAO_PHONE, MOCK_PRIVATE_COMPANY_ARABIC_PHONE, MOCK_PRIVATE_COMPANY_KEYCAP_PHONE, MOCK_PRIVATE_COMPANY_COUNTRY_PHONE, MOCK_PRIVATE_COMPANY_EMOJI_PHONE].forEach((privatePhone) => {
      assert.ok(!ownerText.includes(privatePhone), `Mock 合作房源不得泄露中文/异体数字或非标分隔手机号 ${privatePhone}`)
    })
    assert.ok(!ownerText.includes(MOCK_CHAINED_CONFUSABLE_PHONES), 'Mock 不得泄露相邻的多个 emoji/零宽分隔手机号')
    ;[MOCK_KATAKANA_PHONE, MOCK_ARABIC_COMMA_PHONE, MOCK_ALPHA_PHONE, MOCK_LONG_ALPHA_PHONE, MOCK_VERY_LONG_ALPHA_PHONE, MOCK_HAN_GAP_PHONE, MOCK_FALSE_SAFE_SUFFIX_PHONE, ...MOCK_SERVICE_PHONES, ...MOCK_LABELED_LOCAL_PHONES, ...MOCK_ENGLISH_LOCAL_PHONES, ...MOCK_TRADITIONAL_LOCAL_PHONES, ...MOCK_NOISY_WECHAT_IDS, PUBLIC_PUNCTUATED_ADDRESS, PUBLIC_PUNCTUATED_COMPOSITE_ADDRESS, PUBLIC_PUNCTUATED_ROOM_LABEL, PUBLIC_ALPHA_GAP_ADDRESS, PUBLIC_HAN_GAP_ADDRESS, PUBLIC_ALPHA_COMPOSITE_ADDRESS, PUBLIC_FINANCIAL_WORD_ADDRESS, PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS, ...PUBLIC_ENGLISH_ADDRESS_LABELS, ...PUBLIC_CHINESE_ADDRESS_LABELS, ...PUBLIC_TRADITIONAL_ADDRESS_LABELS].forEach((privateValue) => {
      assert.ok(!ownerText.includes(privateValue), `Mock 不得泄露任意分隔符夹带的电话或精确地址 ${privateValue}`)
    })
    assert.ok(String(ownerRow.block || '').includes(PUBLIC_SEMANTIC_DIGITS), `Mock 地铁/步行/公交数字语义不得被误删，实际：${ownerRow.block || ''}`)
    assert.ok(String(ownerRow.block || '').includes(PUBLIC_PHONE_SHAPED_SEMANTICS), 'Mock 公共语义数字不得因拼出手机号形状被误删')
    assert.ok(String(ownerRow.block || '').replace(/[·\s]+/g, ' ').includes('2 rooms unit price follows'), 'Mock 合法英文数字业务文案不得被多语言地址清洗误删')
    assert.ok(!ownerText.includes('七〇一室') && !ownerText.includes('7O1室'), 'Mock 合作房源不得泄露中文数字/O混淆的精确房号')
    assert.ok(!ownerText.includes(PUBLIC_FINANCIAL_ADDRESS) && !ownerText.includes(PUBLIC_EMOJI_ADDRESS), 'Mock 合作房源不得泄露金融中文数字或表情分隔的精确地址')
    assert.ok(!ownerText.includes(PUBLIC_SENSITIVE_REMARK_COPY), 'Mock 合作房源不得把敏感备注复制进公共板块')
    assert.ok(!ownerText.includes('PRIVATE-EXACT'), 'Mock 已知完整地址清除后不得残留可拼接的合成地址前缀')
    assert.ok(JSON.stringify(secondLandlordRow).includes('三室'), 'Mock 必须保留合法户型“三室”')
    assert.strictEqual(corruptRentRow.rent, 0, 'Mock 畸形存量租金不得进入公开 DTO')
    assert.strictEqual(corruptRentRow.price, '', 'Mock 畸形存量租金不得拼入公开价格文案')
    assert.strictEqual(mockData.getListingDetail(corruptRent.id, { publicGuest: true }).rent, '0', 'Mock 详情不得下发 NaN 或畸形租金原文')
    assert.strictEqual(corruptLandlineRentRow.rent, 0, 'Mock 座机形状的存量租金不得进入公开 DTO')
    assert.strictEqual(corruptLandlineRentRow.price, '', 'Mock 座机形状的存量租金不得拼入公开价格文案')
    assert.strictEqual(mockData.getListingDetail(corruptLandlineRent.id, { publicGuest: true }).rent, '0', 'Mock 详情不得下发座机形状的租金原文')
    ;[companyRow, ownerRow, secondLandlordRow].forEach((row) => {
      assert.strictEqual(row.hasVideo, true, '列表必须返回 hasVideo')
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'coverUrl'), '列表必须返回 coverUrl')
    })
  })

  await check('Mock 不存在详情抛出 404', () => {
    assert.throws(
      () => mockData.getListingDetail('MOCK-MISSING-LISTING', { companyOnly: false }),
      (error) => error && error.statusCode === 404
    )
  })

  let authToken = ''
  const calls = []
  require.cache[apiClientPath] = {
    id: apiClientPath,
    filename: apiClientPath,
    loaded: true,
    exports: {
      getAuthToken: () => authToken,
      buildUrl: (baseUrl, pathname) => `${String(baseUrl || '').replace(/\/$/, '')}${pathname}`,
      authHeader: () => authToken ? { Authorization: `Bearer ${authToken}` } : {},
      call(options) {
        calls.push(options)
        const executeMock = (requestData) => Promise.resolve().then(() => options.mock(requestData))
        return executeMock(options.data).catch((error) => {
          if (!error || error.statusCode !== 401 || options.publicReadAuthFallback !== true || !authToken) throw error
          authToken = ''
          const method = String(options.method || 'GET').toUpperCase()
          const mayReplayAnonymous = method === 'GET' || (
            method === 'POST' &&
            options.retryAnonymousOnAuthFailure === true &&
            error.data &&
            error.data.authFailurePhase === 'pre_execution'
          )
          if (!mayReplayAnonymous) throw error
          const anonymousData = typeof options.buildAnonymousRetryData === 'function'
            ? options.buildAnonymousRetryData(options.data)
            : options.data
          return executeMock(anonymousData)
        })
      },
      uploadFile(options) {
        calls.push(options)
        return Promise.resolve().then(() => options.mock()).then((data) => ({ code: 0, data })).catch((error) => {
          if (error && error.statusCode === 401 && authToken) authToken = ''
          throw error
        })
      }
    }
  }
  delete require.cache[apiServicePath]
  delete require.cache[llmServicePath]
  const apiService = require(apiServicePath)
  const llmService = require(llmServicePath)
  const signedOwner = await apiService.loginByPhone('13800010005', 'mock-password-not-validated')
  let validOwnerToken = signedOwner.token
  assert.ok(validOwnerToken, 'Mock 登录必须返回数据层签发的可验证 token')

  await check('Mock API 助手伪 token 必须在执行前拒绝并仅匿名重放一次', async () => {
    authToken = 'synthetic-forged-api-chat-token'
    const result = await apiService.chatAssistant({ form: { budget: 4000, area: '拱墅区', layout: '两室' } })
    assert.strictEqual(authToken, '', 'Mock API 助手遇到伪 token 必须清除当前凭据')
    assertGuestAssistantRows(result.listings, '伪 token 匿名重放后的 Mock API 助手')
  })

  await check('Mock 所有公共可选身份入口统一拒绝伪 token 并按接口语义降级', async () => {
    const publicCalls = [
      ['公司表快照', () => apiService.getCompanySheetSnapshot()],
      ['公开分佣配置', () => apiService.getCommissionConfig()],
      ['助手反馈', () => apiService.submitAssistantFeedback({ feedbackType: 'other', userId: 'FORGED-USER' })]
    ]
    for (const [label, invoke] of publicCalls) {
      authToken = `synthetic-forged-${label}`
      const result = await invoke()
      assert.strictEqual(authToken, '', `${label} 遇到伪 token 必须先清除凭据再匿名重放`)
      assert.ok(result && typeof result === 'object', `${label} 匿名重放后仍应返回公开结果`)
    }
    authToken = 'synthetic-forged-asr-token'
    await assert.rejects(
      apiService.transcribeVoice('/tmp/synthetic-voice.mp3', { duration: 1000 }),
      (error) => error && error.statusCode === 401 && error.data && error.data.authFailurePhase === 'pre_execution',
      'ASR Mock 遇到伪 token 必须与生产一致拒绝，且不得擅自重放上传'
    )
    assert.strictEqual(authToken, '', 'ASR Mock 401 必须清除伪 token')

    authToken = ''
    const snapshot = await apiService.getCompanySheetSnapshot()
    assert.strictEqual(snapshot.updatedAt, '', 'Mock 公司表无可信更新时间时必须返回空串，与生产严格日期 DTO 一致')
  })

  const matchPayload = {
    confirmed: true,
    form: {
      budget: 4000,
      area: '拱墅区',
      layout: '两室'
    }
  }
  await check('游客 Mock 找房助手匹配全部有效来源且保持公开投影', () => {
    authToken = ''
    const guestMatch = llmService.buildLocalMatch(matchPayload)
    assert.ok(guestMatch.listings.length > 0)
    assertGuestAssistantRows(guestMatch.listings, '游客本地兜底')
    authToken = validOwnerToken
    const brokerMatch = llmService.buildLocalMatch(matchPayload)
    assert.ok(brokerMatch.listings.some((item) => !item.companyListing), '登录后仍应匹配业主/二房东房源')
    assertGuestAssistantRows(brokerMatch.listings, '合法登录后的本地兜底')
  })

  await check('游客 Mock 助手三条入口统一隐藏房号上传人且精确地址不能参与匹配', async () => {
    authToken = ''
    const direct = mockData.matchListings({ publicGuest: true, budget: 4000, area: '拱墅区', layout: '两室' })
    assertGuestAssistantRows(direct.listings, 'Mock 数据层匹配')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, area: '9813' }).listings, [], '游客助手不得用精确房号命中合作房源')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, area: PUBLIC_SMUGGLED_PHONE }).listings, [], '游客助手不得用夹带手机号命中合作房源')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, layout: PUBLIC_SMUGGLED_ADDRESS }).listings, [], '游客助手不得用楼栋单元房号命中合作房源')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, area: PUBLIC_LABELED_ROOM }).listings, [], '游客助手不得用显式标注房号命中合作房源')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, area: PUBLIC_SINGLE_BUILDING }).listings, [], '游客助手不得用单字符楼栋号命中合作房源')
    assert.deepStrictEqual(mockData.matchListings({ publicGuest: true, layout: PUBLIC_SINGLE_UNIT }).listings, [], '游客助手不得用单字符单元号命中合作房源')

    const apiMatch = await apiService.matchListings({ budget: 4000, area: '拱墅区', layout: '两室' })
    assertGuestAssistantRows(apiMatch.listings, 'API Mock 匹配')
    const assistant = await apiService.chatAssistant({ form: { budget: 4000, area: '拱墅区', layout: '两室' } })
    assertGuestAssistantRows(assistant.listings, 'API Mock 助手')

    authToken = validOwnerToken
    const loggedMatch = await apiService.matchListings({ budget: 4000, area: '拱墅区', layout: '两室' })
    const loggedOwnerCard = loggedMatch.listings.find((item) => item.id === owner.id)
    assertAuthenticatedPartnerDisplay(loggedOwnerCard, owner, '合法登录后的普通 Mock 匹配')
    const loggedAssistant = await apiService.chatAssistant({ form: { budget: 4000, area: '拱墅区', layout: '两室' } })
    assertGuestAssistantRows(loggedAssistant.listings, '合法登录后的 Mock 助手仍须公共投影')
    authToken = ''
  })

  await check('游客今日任务不发登录接口请求', async () => {
    authToken = ''
    const before = calls.length
    const result = await apiService.getTodayTasks()
    assert.strictEqual(calls.length, before, '游客首页不得请求 /mini/today-tasks 或 /mini/profile')
    assert.strictEqual(result.summary.pendingCount, 0)
    assert.ok(result.tasks.every((item) => Number(item.count || 0) === 0))
  })

  await check('小程序 Mock 公开分佣配置使用白名单且后台审计字段仍保留', async () => {
    const internalConfig = mockData.getCommissionConfig()
    assert.ok(Object.prototype.hasOwnProperty.call(internalConfig, 'updatedAt'), '后台 Mock 配置仍需保留更新时间')
    assert.ok(Object.prototype.hasOwnProperty.call(internalConfig, 'updatedBy'), '后台 Mock 配置仍需保留操作人')

    const publicConfig = await apiService.getCommissionConfig()
    assert.deepStrictEqual(Object.keys(publicConfig).sort(), [
      'companyRate',
      'ownerPlatformRate',
      'ownerRate',
      'platformRates',
      'secondLandlordPlatformRate',
      'secondLandlordRate',
      'totalRate',
      'uploaderRates'
    ].sort(), '小程序 Mock 公开配置必须与生产白名单字段完全一致')
    assert.ok(!Object.prototype.hasOwnProperty.call(publicConfig, 'updatedAt'))
    assert.ok(!Object.prototype.hasOwnProperty.call(publicConfig, 'updatedBy'))
  })

  await check('Mock 分佣记录必须走数据层而非硬编码空数组', async () => {
    authToken = ''
    await assert.rejects(
      apiService.getCommissionRecords(),
      (error) => error && error.statusCode === 401,
      '未登录 Mock 必须与生产一致拒绝读取账号分佣记录'
    )
    authToken = validOwnerToken
    const fixture = [{ id: 'MOCK-COMMISSION-1', role: '我是上传人', status: '待确认' }]
    const original = mockData.getCommissionRecords
    mockData.getCommissionRecords = () => fixture
    try {
      assert.deepStrictEqual(await apiService.getCommissionRecords(), fixture)
    } finally {
      if (original) mockData.getCommissionRecords = original
      else delete mockData.getCommissionRecords
    }
  })

  await check('Mock map pins 与服务端同为小区聚合 DTO', async () => {
    authToken = validOwnerToken
    const pins = await apiService.getMapPins({ sourceType: '业主房源', area: '拱墅区' })
    assert.deepStrictEqual(mapIds(pins), [owner.id])
    assert.ok(pins.every((item) => Array.isArray(item.listings) && Array.isArray(item.activeListingIds)))
    assert.ok(pins.every((item) => item.coordinateLevel && item.coordinateStatus), '小区点必须带坐标可信度口径')
    assert.ok(pins.flatMap((item) => item.listings || []).every((item) => item.hasVideo === true), 'Mock 地图合作房源必须保留视频标记')
    assert.ok(!JSON.stringify(pins).includes('19900000061'), '地图聚合 DTO 不得包含联系方式')
  })

  await check('Mock 游客合作详情保留视频且不下发跳单敏感字段', async () => {
    authToken = ''
    const detail = await apiService.getListingDetail(owner.id)
    const companyDetail = await apiService.getListingDetail(company.id)
    assert.ok(!Object.prototype.hasOwnProperty.call(companyDetail, 'videoKey'), 'Mock 公司公开详情同样不得泄露内部视频对象键')
    guestCommissionWithResidualMockUser = detail.commissionBreakdown
    assert.strictEqual(detail.videoUrl, MOCK_PUBLIC_VIDEO_URL, 'Mock 公共详情只能返回不含原对象名的合成视频 URL')
    assert.strictEqual(detail.community, '京漾东韵府')
    ;['building', 'unit', 'roomNumber', 'roomAddress', 'address', 'landlordPhone', 'contact', 'viewingMethod', 'viewingMethodText', 'viewingKeyLocation', 'viewingPassword', 'remark', 'videoKey'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(detail, field), `Mock 游客合作详情不得下发 ${field}`)
    })
    ;['reviewStatus', 'requiresManualReview', 'manualReviewReason', 'communityMatched', 'communityMatchStatus', 'uploader'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(detail, field), `Mock 游客合作详情不得下发登录内部字段 ${field}`)
    })
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, area: '9813' }), [], '游客用精确房号搜索不得命中合作房源')
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, block: PUBLIC_SMUGGLED_PHONE }), [], '游客列表不得把夹带手机号变成筛选 oracle')
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, layout: PUBLIC_SMUGGLED_ADDRESS }), [], '游客列表不得把楼栋单元房号变成筛选 oracle')
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, block: PUBLIC_LABELED_ROOM }), [], '游客列表不得把显式标注房号变成筛选 oracle')
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, block: PUBLIC_SINGLE_BUILDING }), [], '游客列表不得把单字符楼栋号变成筛选 oracle')
    assert.deepStrictEqual(mockData.getListings({ publicGuest: true, layout: PUBLIC_SINGLE_UNIT }), [], '游客列表不得把单字符单元号变成筛选 oracle')
    assert.ok(mockData.getListings({ publicGuest: true, community: '京漾东韵府' }).some((item) => item.id === owner.id), '游客按小区搜索必须命中合作房源')
    authToken = validOwnerToken
    const loggedOwnDetail = await apiService.getListingDetail(owner.id)
    assertAuthenticatedPartnerDisplay(loggedOwnDetail, owner, '合法登录但未 sensitive-view 的合作详情', { detail: true })
    assert.notDeepStrictEqual(loggedOwnDetail.commissionBreakdown, guestCommissionWithResidualMockUser, '登录上传人自带佣金规则仍应与游客公共详情区分')
    const anonymousRefreshDetail = await apiService.getListingDetail(owner.id, { anonymous: true })
    assert.strictEqual(anonymousRefreshDetail.ownListing, false, 'Mock 匿名媒体刷新不得沿用残留登录用户身份')
    assert.deepStrictEqual(anonymousRefreshDetail.commissionBreakdown, guestCommissionWithResidualMockUser, 'Mock 匿名媒体刷新必须与生产一样返回游客公共投影')
    authToken = ''
  })

  await check('Mock 游客公开读取不扩大任何账号写权限', async () => {
    authToken = ''
    const protectedCalls = [
      () => apiService.setFavorite(owner.id, true),
      () => apiService.addSensitiveFootprint(owner.id, 'SV-MOCK-GUEST-001'),
      () => apiService.recordPhoneCallOpened(owner.id, 'CALL-MOCK-GUEST-001'),
      () => apiService.recordVideoShare(owner.id, { channel: 'wechat-video' }),
      () => apiService.recordShowing(owner.id, {})
    ]
    for (const invoke of protectedCalls) {
      await assert.rejects(invoke(), (error) => error && error.statusCode === 401)
    }
  })

  await check('Mock fresh 默认用户下伪 token 也不能绕过任何写接口或认证接口', async () => {
    mockData.loginByPhone('13800010005')
    authToken = 'synthetic-fresh-forged-token'
    const protectedCalls = [
      () => apiService.setFavorite(owner.id, true),
      () => apiService.addSensitiveFootprint(owner.id, 'SV-MOCK-FORGED-001'),
      () => apiService.recordPhoneCallOpened(owner.id, 'CALL-MOCK-FORGED-001'),
      () => apiService.recordVideoShare(owner.id, { channel: 'wechat-video' }),
      () => apiService.recordShowing(owner.id, {}),
      () => apiService.getCurrentUser(),
      () => apiService.changePassword('old-password', 'new-password'),
      () => apiService.logout(),
      () => apiService.getClientReports(),
      () => apiService.createClientReport(owner.id, {}),
      () => apiService.getDealRecords(),
      () => apiService.createDealFromReport('REPORT-FORGED', {}),
      () => apiService.registerDeal(owner.id),
      () => apiService.getFootprintRecords(),
      () => apiService.getOwnedListings(),
      () => apiService.verifyMyListing(owner.id, '未出租'),
      () => apiService.getEditableListing(owner.id),
      () => apiService.updateNormalListing(owner.id, { rent: 3210 }),
      () => apiService.getProfileState(),
      () => apiService.getTodayTasks(),
      () => apiService.createRentalNeed({ community: '合成小区' }),
      () => apiService.rechargePoints(1),
      () => apiService.getCommissionRecords(),
      () => apiService.getGroupState(),
      () => apiService.uploadGroupListing({}),
      () => apiService.createGroupScreenshotUploadPolicy({ fileName: 'synthetic.jpg' }),
      () => apiService.createShowingPhotoUploadPolicy({ fileName: 'synthetic.jpg' }),
      () => apiService.createVideoUploadPolicy({ fileName: 'synthetic.mp4' }),
      () => apiService.unlockGroup('GROUP-FORGED'),
      () => apiService.addNormalListing(listingPayload('9899', '业主房源'))
    ]
    for (const invoke of protectedCalls) {
      await assert.rejects(invoke(), (error) => error && error.statusCode === 401)
    }
    authToken = validOwnerToken
    assert.strictEqual((await apiService.getCurrentUser()).id, 'U005', '真正签发的 Mock token 必须绑定并恢复对应用户')
    assert.strictEqual((await apiService.setFavorite(owner.id, true)).favorited, true, '真正签发的 Mock token 应允许合法收藏')
    await apiService.setFavorite(owner.id, false)
  })

  await check('Mock 公司 sensitive-view 只能返回统一三号码', async () => {
    authToken = validOwnerToken
    const response = await apiService.addSensitiveFootprint(company.id, 'SV-MOCK-COMPANY-001')
    assert.deepStrictEqual(response.sensitive.companyContactPhones, ['19900000001', '19900000002', '19900000003'])
    assert.strictEqual(response.sensitive.landlordPhone, '19900000001')
    assert.ok(!JSON.stringify(response).includes(MOCK_PRIVATE_COMPANY_PHONE), 'Mock 公司敏感兼容响应不得泄露房源原始私号')
  })

  await check('Mock 伪造或过期非空 token 不能绕过收藏账号门', async () => {
    authToken = validOwnerToken
    await apiService.logout()
    authToken = 'synthetic-stale-or-forged-token'
    const staleRows = await apiService.getListings({ category: '业主房源' })
    assertGuestAssistantRows(staleRows, '伪造非空 token 的 Mock 列表')
    const staleDetail = await apiService.getListingDetail(owner.id)
    ;['building', 'unit', 'roomNumber', 'roomAddress', 'address', 'landlordPhone', 'contact', 'viewingMethod', 'viewingPassword', 'remark', 'uploaderId'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(staleDetail, field), `伪造非空 token 的 Mock 详情不得下发 ${field}`)
    })
    assert.deepStrictEqual(staleDetail.commissionBreakdown, guestCommissionWithResidualMockUser, '游客佣金展示不得受残留 Mock 用户身份影响')
    const stalePins = await apiService.getMapPins({ sourceType: '业主房源' })
    assert.ok(!JSON.stringify(stalePins).includes('9813'), '伪造非空 token 的 Mock 地图不得泄露精确房号')
    const staleAssistant = llmService.buildLocalMatch(matchPayload)
    assertGuestAssistantRows(staleAssistant.listings, '伪造非空 token 的本地助手')
    assert.deepStrictEqual(await apiService.getFavoriteIds(), [], '失效 token 清理后，卡片可选收藏态应降级为空集合')
    const protectedFavorites = [
      () => apiService.getFavorites({}),
      () => apiService.setFavorite(owner.id, true)
    ]
    for (const invoke of protectedFavorites) {
      await assert.rejects(invoke(), (error) => error && error.statusCode === 401)
    }
    assert.throws(
      () => mockData.setFavorite(owner.id, true),
      (error) => error && error.statusCode === 401,
      'Mock 数据层也不得写入空 userId 收藏'
    )
    authToken = ''
    const reloggedOwner = await apiService.loginByPhone('13800010005', 'mock-password-not-validated')
    validOwnerToken = reloggedOwner.token
    authToken = validOwnerToken
  })

  await check('Mock 已下架详情返回结构化且脱敏的 unavailable', async () => {
    mockData.verifyMyListing(secondLandlord.id, '已出租')
    const unavailable = mockData.getListingDetail(secondLandlord.id, { publicGuest: false })
    assert.strictEqual(unavailable.unavailable, true)
    assert.strictEqual(unavailable.id, secondLandlord.id)
    assert.strictEqual(unavailable.reason, 'down')
    assert.ok(unavailable.reasonText)
    ;['updatedAt', 'syncedAt', 'feishuLastSyncAt'].forEach((field) => {
      assert.ok(!unavailable[field] || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?$/.test(unavailable[field]), `Mock unavailable 的 ${field} 只能为空或合法日期时间`)
    })
    assert.ok(!/1[3-9]\d{9}/.test(String(unavailable.feishuLastSyncAction || '')), 'Mock unavailable 同步动作不得夹带手机号')
    ;['address', 'landlordPhone', 'contact', 'videoUrl', 'videoKey', 'uploaderId'].forEach((field) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(unavailable, field), `unavailable 不得包含 ${field}`)
    })
    assert.throws(
      () => mockData.getListingDetail(secondLandlord.id, { publicGuest: true }),
      (error) => error && error.statusCode === 404,
      '游客 Mock 对失效合作房源必须与不存在统一返回 404'
    )
  })

  await check('API Mock 不存在详情继续抛出 404', async () => {
    authToken = validOwnerToken
    await assert.rejects(
      apiService.getListingDetail('MOCK-MISSING-LISTING'),
      (error) => error && error.statusCode === 404
    )
  })

  await check('Mock 本人和后台核验入口都不能把待审核房源旁路上架', () => {
    mockData.loginByPhone('13800010004')
    const pending = addListing('9815', '业主房源')
    assert.strictEqual(pending.status, '待审核', '管理员上传业主房源应进入待审核，作为稳定测试前提')
    assert.strictEqual(pending.reviewStatus, '待审核')

    const beforeMyVerify = mockData.getEditableListing(pending.id)
    assert.throws(
      () => mockData.verifyMyListing(pending.id, '未出租'),
      (error) => error && error.statusCode === 409 && /审核/.test(error.message),
      'Mock 本人核验不得旁路上架待审核房源'
    )
    assert.deepStrictEqual(mockData.getEditableListing(pending.id), beforeMyVerify, 'Mock 本人核验被拒后必须零变化')

    const beforeAdminVerify = mockData.getEditableListing(pending.id)
    assert.throws(
      () => mockData.verifyAdminListing(pending.id),
      (error) => error && error.statusCode === 409 && /审核/.test(error.message),
      'Mock 后台核验不得旁路上架待审核房源'
    )
    assert.deepStrictEqual(mockData.getEditableListing(pending.id), beforeAdminVerify, 'Mock 后台核验被拒后必须零变化')
  })

  await check('Mock 公司房源与生产一致允许缺房东手机号和视频', () => {
    mockData.loginByPhone('13800010004')
    const optionalContactCompany = addListing('9816', '公司房源', {
      companyListing: true,
      isCompanyListing: true,
      contact: '',
      landlordPhone: '',
      videoKey: '',
      videoUrl: '',
      features: ['无']
    })
    assert.strictEqual(optionalContactCompany.companyListing, true)
    assert.strictEqual(optionalContactCompany.landlordPhone, '')
    assert.strictEqual(optionalContactCompany.videoKey, '')
    assert.ok(optionalContactCompany.features.includes('免押金'), 'Mock 公司新建必须补默认免押金')
    assert.ok(optionalContactCompany.features.includes('电梯'), 'Mock 公司新建必须与生产一致补默认电梯')
    const companyRow = mockData.getListings({}).find((item) => item.id === optionalContactCompany.id)
    assert.ok(companyRow)
    assert.strictEqual(companyRow.hasVideo, false)
    const editedWithoutContact = mockData.updateNormalListing(optionalContactCompany.id, { rent: 3300 })
    assert.strictEqual(Number(editedWithoutContact.rent), 3300)
    assert.strictEqual(editedWithoutContact.landlordPhone, '', '编辑无号公司房源时不得反向强制补号')
    const editedCompanyDefaults = mockData.updateNormalListing(optionalContactCompany.id, { features: ['无'] })
    assert.ok(editedCompanyDefaults.features.includes('免押金'), 'Mock 公司编辑时不得移除默认免押金')
    assert.ok(editedCompanyDefaults.features.includes('电梯'), 'Mock 公司编辑时不得移除默认电梯')
    const clearedContact = mockData.updateNormalListing(company.id, { contact: '' })
    assert.strictEqual(clearedContact.landlordPhone, '', 'Mock 应与生产一致允许显式清空公司房源已有手机号')
    assert.throws(
      () => mockData.updateNormalListing(company.id, { contact: 'TEST-PHONE' }),
      /11 位房东手机号/,
      '公司房源非空手机号仍必须校验格式'
    )
    assert.throws(
      () => mockData.updateNormalListing(optionalContactCompany.id, {
        companyListing: false,
        ownerType: '二房东房源',
        source: '二房东房源',
        contact: '19900000061'
      }),
      /视频/,
      'Mock 不得允许无视频公司房源直接切换为合作来源'
    )
    const converted = mockData.updateNormalListing(optionalContactCompany.id, {
      companyListing: false,
      ownerType: '二房东房源',
      source: '二房东房源',
      contact: '19900000061',
      videoKey: 'house-videos/synthetic/mock-company-converted.mp4'
    })
    assert.strictEqual(converted.companyListing, false)
    assert.strictEqual(converted.videoKey, 'house-videos/synthetic/mock-company-converted.mp4')

    const ordinary = addListing('9817', '二房东房源', { features: ['无'] })
    assert.ok(!ordinary.features.includes('免押金'), '合作房源不得被补公司默认免押金')
    assert.ok(!ordinary.features.includes('电梯'), '合作房源不得被补公司默认电梯')
  })

  await check('Mock 已知完整地址整体移除且不残留道路前缀', () => {
    mockData.loginByPhone('13800010005')
    ;[
      '杭州拱墅区文一西路969号3栋2单元701室',
      '文一西路969号',
      '浙江省杭州市拱墅区东新路88号'
    ].forEach((fullAddress, index) => {
      const exactAddressListing = addListing(String(9830 + index), '业主房源', {
        block: fullAddress,
        address: fullAddress,
        fullAddress
      })
      const exactAddressPublic = mockData.getListings({}).find((item) => item.id === exactAddressListing.id)
      assert.ok(exactAddressPublic, `Mock 必须返回完整地址边界样本 ${fullAddress}`)
      assert.strictEqual(exactAddressPublic.block, '拱墅区', `Mock 已知完整地址必须整体移除并回退公开区域：${fullAddress}`)
    })
  })

  await check('Mock 公司字段逐值阻断合法业务词尾私号绕过', () => {
    mockData.loginByPhone('13800010004')
    MOCK_ADDRESS_PHONE_SMUGGLES.forEach((privatePhone, index) => {
      const isolatedCompanyListing = addListing(String(9850 + index), '公司房源', {
        city: `杭州 ${privatePhone}`,
        companyListing: true,
        isCompanyListing: true,
        noCommission: true
      })
      const isolatedCompanyPublic = mockData.getListings({}).find((item) => item.id === isolatedCompanyListing.id)
      assert.ok(isolatedCompanyPublic, `Mock 公司安全词尾攻击样本必须进入公共投影 ${privatePhone}`)
      assert.ok(!JSON.stringify(isolatedCompanyPublic).includes(privatePhone), `Mock 公司字段不得用合法业务词尾打断完整私号清洗 ${privatePhone}`)
    })
  })

  await check('Mock 公司公开 block 单值阻断伪地铁私号', () => {
    mockData.loginByPhone('13800010004')
    const isolatedCompanyListing = addListing('9890', '公司房源', {
      block: MOCK_FALSE_SAFE_SUFFIX_PHONE,
      companyListing: true,
      isCompanyListing: true,
      noCommission: true
    })
    const isolatedCompanyPublic = mockData.getListings({}).find((item) => item.id === isolatedCompanyListing.id)
    assert.ok(isolatedCompanyPublic, 'Mock 独立公司伪地铁私号样本必须进入公共投影')
    assert.notStrictEqual(isolatedCompanyPublic.block, MOCK_FALSE_SAFE_SUFFIX_PHONE, 'Mock 公司公开 block 单值不得完整保留伪装成地铁语义的私号')
    assert.ok(!JSON.stringify(isolatedCompanyPublic).includes(MOCK_FALSE_SAFE_SUFFIX_PHONE), 'Mock 公司独立样本任何公开字段均不得保留完整伪地铁私号')
  })

  await check('Mock 合作房源 block 单值阻断汉字间隔精确地址', () => {
    mockData.loginByPhone('13800010005')
    const isolatedPartnerListing = addListing('9891', '业主房源', {
      block: PUBLIC_HAN_GAP_ADDRESS,
      communityName: '汉字间隔地址独立测试小区',
      community: '汉字间隔地址独立测试小区',
      building: '9',
      unit: '8',
      roomNumber: '701',
      address: '杭州拱墅区汉字间隔地址独立测试小区9栋8单元701室'
    })
    const isolatedPartnerPublic = mockData.getListings({}).find((item) => item.id === isolatedPartnerListing.id)
    assert.ok(isolatedPartnerPublic, 'Mock 独立合作房源汉字间隔地址样本必须进入公共投影')
    assert.ok(!String(isolatedPartnerPublic.block || '').includes(PUBLIC_HAN_GAP_ADDRESS), 'Mock 合作房源 block 单值不得泄露汉字间隔的楼栋单元房号')
  })

  await check('Mock 真实 1栋1单元101室独立保留合法数字 block', () => {
    mockData.loginByPhone('13800010005')
    const isolatedLegalBlockListing = addListing('9892', '业主房源', {
      block: PUBLIC_PHONE_SHAPED_SEMANTICS,
      communityName: '合法数字板块独立测试小区',
      community: '合法数字板块独立测试小区',
      building: '1',
      unit: '1',
      roomNumber: '101',
      address: '杭州拱墅区合法数字板块独立测试小区1栋1单元101室'
    })
    const isolatedLegalBlockPublic = mockData.getListings({}).find((item) => item.id === isolatedLegalBlockListing.id)
    assert.ok(isolatedLegalBlockPublic, 'Mock 独立合法数字 block 样本必须进入公共投影')
    assert.strictEqual(isolatedLegalBlockPublic.block, PUBLIC_PHONE_SHAPED_SEMANTICS, 'Mock 真实 1栋1单元101室不得导致合法数字 block 被截断或改写')
  })

  for (let index = 0; index < PUBLIC_LEGAL_NUMERIC_LAYOUTS.length; index += 1) {
    const layout = PUBLIC_LEGAL_NUMERIC_LAYOUTS[index]
    await check(`Mock 真实 1栋1单元101室独立保留合法 layout ${index + 1}`, () => {
      mockData.loginByPhone('13800010005')
      const community = `合法数字户型独立测试小区${index + 1}`
      const isolatedLegalLayoutListing = addListing(String(9893 + index), '业主房源', {
        block: '合法数字户型测试板块',
        communityName: community,
        community,
        building: '1',
        unit: '1',
        roomNumber: '101',
        address: `杭州拱墅区${community}1栋1单元101室`,
        layout
      })
      const isolatedLegalLayoutPublic = mockData.getListings({}).find((item) => item.id === isolatedLegalLayoutListing.id)
      assert.ok(isolatedLegalLayoutPublic, `Mock 独立合法数字 layout 样本必须进入公共投影：${layout}`)
      assert.strictEqual(isolatedLegalLayoutPublic.layout, layout, `Mock 真实 1栋1单元101室不得导致合法 layout 被截断或改写：${layout}`)
    })
  }

  await check('Mock 公司原文 17㎡三室 保留平方米符号', () => {
    mockData.loginByPhone('13800010004')
    const companySquareMeterListing = addListing('9900', '公司房源', {
      layout: '17㎡三室',
      communityName: 'Mock公司合法面积户型独立测试小区',
      community: 'Mock公司合法面积户型独立测试小区',
      companyListing: true,
      isCompanyListing: true,
      noCommission: true
    })
    const companySquareMeterPublic = mockData.getListings({}).find((item) => item.id === companySquareMeterListing.id)
    assert.ok(companySquareMeterPublic, 'Mock 独立公司合法面积户型样本必须进入公共投影')
    assert.strictEqual(companySquareMeterPublic.layout, '17㎡三室', 'Mock 公司原文 17㎡三室 必须保留平方米符号，不得改写')
  })

  await check('Mock 生产同口径阻断无数字噪声联系方式与异体中文手机号', () => {
    mockData.loginByPhone('13800010005')
    const privateValues = [
      '微🫥信:privateid',
      'p🫥hone:privateid',
      '房🫥东电话:privateid',
      'landlordphone:privateid',
      'mycontact:a1_b2',
      'p🫥hone:a1 b2',
      'c🫥ontact:real wx123',
      '电话是privateid',
      '联系方式为privateid',
      '房东电话即abc123',
      '联系人小王电话privateid',
      '电话:小王abc123',
      '联系方式:小李privateid',
      '热线:小张a1b2',
      'owner@example.com',
      'email:owner@example.com',
      '房东邮箱:owner@example.com',
      'ｏｗｎｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ',
      '加微:abc123',
      '加V:abc123',
      'V号:abc123',
      'QQ号:privateid',
      '小红书号 privateid',
      '抖音账号 privateid',
      '钉钉ID privateid',
      'Telegram @privateid',
      'WhatsApp privateid',
      'Line privateid',
      '个人主页 https://example.invalid/u/privateid',
      '二维码见 www.example.invalid/privateid',
      'owner(at)example.invalid',
      'owner [at] example [dot] invalid',
      '联系方式 privateid；contact privateid',
      '幺參參幺幺幺幺幺幺幺幺'
    ]
    privateValues.forEach((privateValue, index) => {
      const community = `Mock合作无数字联系方式小区${index + 1}`
      const row = addListing(`993${index}`, '二房东房源', {
        block: `Mock安全板块 ${privateValue}`,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.ok(projected, 'Mock 合作无数字联系方式样本必须进入公共投影')
      const normalized = String(projected.block || '').replace(/[\s,，;；:：\-—_·]+/g, '')
      assert.strictEqual(normalized, 'Mock安全板块', `Mock 不得残留噪声联系方式/异体手机号：${privateValue}`)
    })
  })

  await check('Mock 合作访问凭据 fail-closed、公司同文案继续公开', () => {
    const privateAccessValues = [
      '密🫥码:a1_b2-c3',
      '密🫥码:12-34',
      'p🫥in:12-34',
      '钥🫥匙:门-口花盆',
      '密🫥码:12 34',
      '密码就是 12 34',
      'pass🫥word:a1 b2',
      '钥🫥匙:门 口花盆',
      '钥🫥匙在门口花盆',
      '开🫥门找保安',
      '门🫥禁问前台'
      ,'房卡在前台'
      ,'门卡在保安处'
      ,'前台取卡'
      ,'找管家拿卡'
      ,'accesscode:1234'
      ,'lockcode:1234'
      ,'entrycode:1234'
      ,'入户码 1234'
      ,'进门码 1234'
      ,'大门口令 1234'
      ,'看房方式：物业带看'
      ,'看房：联系房东'
      ,'带看方式：管家带看'
      ,'查看方式：自行看房'
      ,'看房方式：租客开门'
      ,'租客在家直接敲门'
      ,'物业带看'
      ,'管家带看'
      ,'提前预约房东'
      ,'门口有人直接进'
      ,'电话联系看房'
      ,'白天电话联系租客'
    ]
    mockData.loginByPhone('13800010005')
    privateAccessValues.forEach((privateValue, index) => {
      const community = `Mock合作访问凭据小区${index + 1}`
      const row = addListing(`994${index}`, '业主房源', {
        block: `Mock安全板块 ${privateValue}`,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.strictEqual(
        String(projected.block || '').replace(/[\s,，;；:：\-—_·]+/g, ''),
        'Mock安全板块',
        `Mock 合作房源不得残留访问凭据尾部：${privateValue}`
      )
    })

    mockData.loginByPhone('13800010004')
    const companyAccess = '密🫥码:a1_b2-c3'
    const companyCommunity = 'Mock公司访问凭据正向小区'
    const companyAccessRow = addListing('9950', '公司房源', {
      block: `Mock公司板块 ${companyAccess}`,
      communityName: companyCommunity,
      community: companyCommunity,
      companyListing: true,
      isCompanyListing: true,
      noCommission: true
    })
    const companyProjected = mockData.getListings({ publicGuest: true }).find((item) => item.id === companyAccessRow.id)
    assert.ok(String(companyProjected.block || '').includes(companyAccess), 'Mock 公司钥匙/密码仍须保持完整公开')
  })

  await check('Mock 公司公开字段不得夹带前缀联系方式，普通英文词不得误伤', () => {
    mockData.loginByPhone('13800010004')
    ;[
      'landlordwechat:privateid',
      'ownerphone:privateid',
      'agentwx:privateid',
      'p🫥hone:a1 b2',
      'c🫥ontact:real wx123',
      '电话是privateid',
      '联系方式为privateid',
      '房东电话即abc123',
      '联系人小王电话privateid',
      '电话:小王abc123',
      '联系方式:小李privateid',
      '热线:小张a1b2',
      'owner@example.com',
      'email:owner@example.com',
      '房东邮箱:owner@example.com',
      'ｏｗｎｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ',
      '加微:abc123',
      '加V:abc123',
      'V号:abc123',
      'QQ号:privateid',
      '小红书号 privateid',
      '抖音账号 privateid',
      '钉钉ID privateid',
      'Telegram @privateid',
      'WhatsApp privateid',
      'Line privateid',
      '个人主页 https://example.invalid/u/privateid',
      '二维码见 www.example.invalid/privateid',
      'owner(at)example.invalid',
      'owner [at] example [dot] invalid',
      '联系方式 privateid；contact privateid'
    ].forEach((privateContact, index) => {
      const community = `Mock公司前缀联系方式小区${index + 1}`
      const row = addListing(`996${index}`, '公司房源', {
        block: `Mock公司板块 ${privateContact}`,
        communityName: community,
        community,
        companyListing: true,
        isCompanyListing: true,
        noCommission: true
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.strictEqual(
        String(projected.block || '').replace(/[\s,，;；:：\-—_·]+/g, ''),
        'Mock公司板块',
        `Mock 公司字段只能保留服务器统一号码，不得夹带第四联系方式：${privateContact}`
      )
    })

    mockData.loginByPhone('13800010005')
    const positive = 'contactless payment · telephonebook available'
    const positiveCommunity = 'Mock普通英文词正向小区'
    const positiveRow = addListing('9970', '二房东房源', {
      block: positive,
      communityName: positiveCommunity,
      community: positiveCommunity
    })
    const positiveProjected = mockData.getListings({ publicGuest: true }).find((item) => item.id === positiveRow.id)
    assert.strictEqual(
      String(positiveProjected.block || '').replace(/[·\s]+/g, ' ').trim(),
      positive.replace(/[·\s]+/g, ' ').trim(),
      'Mock 普通英文词不得被联系方式标签误伤'
    )
  })

  await check('Mock 合作多字母及中文楼栋单元楼层全部隐藏', () => {
    mockData.loginByPhone('13800010005')
    ;[
      'Building AB',
      'Tower AB',
      'Unit AB',
      'AB栋',
      'AB12室',
      '甲栋',
      '乙单元',
      '丙幢',
      '东栋',
      '西楼',
      '南座',
      '北单元',
      '负一层',
      '地下二层',
      'B2层',
      '12A栋',
      'A-北栋',
      '楼栋甲乙',
      '房号甲',
      '甲室',
      '甲乙室',
      'Building ABCDE',
      'Building NORTH',
      'AB Tower',
      'A1 Building',
      '1号楼2门701',
      '1幢2梯701',
      '1座2梯701',
      'Unit 2-B',
      'A-1栋',
      'B1层',
      '负1F',
      '9栋8单元7-01',
      '7层01',
      '7楼01',
      '7F01',
      'A-701室',
      '1/2/701',
      '1\\2\\701',
      '1.2.701',
      '1#2#701',
      '9—8—701',
      '9_8_701',
      '9 8 701',
      '9🫥8🫥701',
      '一/二/七零一',
      '壹/贰/柒零壹',
      '١/٢/٧٠١',
      '１．２．７０１',
      '一🫥二🫥七零一',
      '文一西路969',
      '文一西路969弄',
      '文一西路九六九',
      '文一西路玖陆玖',
      '文一西路９６９',
      'Wenyi Rd 969',
      'Wenyi Rd 九六九',
      '969 Wenyi West Road',
      '九六九 Wenyi West Road'
    ].forEach((privateAddress, index) => {
      const community = `Mock合作地址 token 小区${index + 1}`
      const row = addListing(`998${index}`, '二房东房源', {
        block: privateAddress,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.strictEqual(
        String(projected.block || '').replace(/[\s,，;；:：\-—_·]+/g, ''),
        '拱墅区',
        `Mock 合作房源不得公开多字母或中文楼栋/单元/楼层 token：${privateAddress}`
      )
    })
  })

  await check('Mock 三段地址不误伤业务数字、自然文案与敏感后缀严格分离', () => {
    mockData.loginByPhone('13800010005')
    ;['版本1.2.70', '比例1/2/100', '日期1/2/2026', '1.2.30公里'].forEach((publicCopy, index) => {
      const community = `Mock合法业务数字小区${index + 1}`
      const row = addListing(`9988${index}`, '二房东房源', {
        block: publicCopy,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.strictEqual(String(projected.block || '').replace(/\s+/g, ''), publicCopy, `Mock 不得误删版本/比例/日期/距离：${publicCopy}`)
    })

    ;['安全板块 phone booth nearby wx:abc123', 'wx:abc123；安全板块 phone booth nearby'].forEach((mixedCopy, index) => {
      const community = `Mock合法设施联系方式混排小区${index + 1}`
      const row = addListing(`9989${index}`, '二房东房源', {
        block: mixedCopy,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      assert.ok(String(projected.block || '').includes('安全板块 phone booth nearby'), `Mock 必须保留联系方式前后的合法设施文案：${mixedCopy}`)
      assert.ok(!String(projected.block || '').toLowerCase().includes('abc123'), `Mock 必须删除混排站外账号：${mixedCopy}`)
    })

    ;['安全板块 密码1234，近地铁', '安全板块 钥匙在前台；近地铁', '安全板块 入户码1234。近地铁', '安全板块 看房方式：物业带看；近地铁'].forEach((mixedSecret, index) => {
      const community = `Mock敏感段合法后缀小区${index + 1}`
      const row = addListing(`9990${index}`, '业主房源', {
        block: mixedSecret,
        communityName: community,
        community
      })
      const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
      const text = String(projected.block || '')
      assert.ok(text.includes('安全板块') && text.includes('近地铁'), `Mock 删除敏感段时必须保留合法后缀：${mixedSecret}`)
      assert.ok(!/(?:1234|钥匙|入户码|看房方式|物业带看)/.test(text), `Mock 不得残留访问凭据或看房方式：${mixedSecret}`)
    })

    const collision = '安全板块 phone booth nearby'
    const collisionCommunity = 'Mock自然短语敏感值碰撞小区'
    const collisionRow = addListing('99909', '二房东房源', {
      block: collision,
      viewingKeyLocation: collision,
      communityName: collisionCommunity,
      community: collisionCommunity
    })
    const collisionProjected = mockData.getListings({ publicGuest: true }).find((item) => item.id === collisionRow.id)
    assert.ok(!String(collisionProjected.block || '').includes(collision), 'Mock 公开短语与真实取钥匙位置碰撞时必须按敏感值删除')
  })

  await check('Mock 公司与合作普通联系方式词组和设施文案保持公开', () => {
    ;[
      'phone booth nearby',
      'mobile home style',
      'call center nearby',
      'contact person available',
      'key features include elevator',
      '门禁系统完善',
      '密码锁很方便',
      '钥匙房很方便',
      '安全板块 phone booth nearby',
      '安全板块 mobile home style',
      '安全板块 call center nearby',
      '安全板块 contact person available',
      '安全板块 key features include elevator',
      '西湖区 Building better homes',
      '余杭区 Tower bridge nearby',
      '安全板块 密码系统正常',
      '安全板块 钥匙功能很方便'
    ].forEach((publicCopy, copyIndex) => {
      ;[
        { label: '公司', source: '公司房源', phone: '13800010004' },
        { label: '合作', source: '二房东房源', phone: '13800010005' }
      ].forEach(({ label, source, phone }, sourceIndex) => {
        mockData.loginByPhone(phone)
        const community = `Mock${label}普通设施文案小区${copyIndex + 1}`
        const row = addListing(`999${copyIndex}${sourceIndex}`, source, {
          block: publicCopy,
          communityName: community,
          community,
          companyListing: source === '公司房源',
          isCompanyListing: source === '公司房源',
          noCommission: source === '公司房源'
        })
        const projected = mockData.getListings({ publicGuest: true }).find((item) => item.id === row.id)
        assert.strictEqual(projected.block, publicCopy, `Mock ${label}普通设施/自然语言不得被误伤：${publicCopy}`)
      })
    })
  })

  for (const sourceCase of [
    { label: '公司', source: '公司房源', companyListing: true },
    { label: '合作', source: '业主房源', companyListing: false }
  ]) {
    const { label, source, companyListing } = sourceCase
    await check(`Mock ${label}字段独立阻断噪声拆分微信 ID`, () => {
      mockData.loginByPhone(companyListing ? '13800010004' : '13800010005')
      const community = `Mock${label}噪声微信独立测试小区`
      const noisyWechatListing = addListing(companyListing ? '9901' : '9902', source, {
        block: PUBLIC_NOISY_WECHAT_GAP,
        communityName: community,
        community,
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing
      })
      const noisyWechatPublic = mockData.getListings({}).find((item) => item.id === noisyWechatListing.id)
      assert.ok(noisyWechatPublic, `Mock 独立${label}噪声微信样本必须进入公共投影`)
      assert.ok(!String(noisyWechatPublic.block || '').toLowerCase().includes(PUBLIC_NOISY_WECHAT_ID), `Mock ${label}公开字段不得残留噪声拆分微信 ID`)
    })

    await check(`Mock ${label}字段独立阻断藏文数字私号`, () => {
      mockData.loginByPhone(companyListing ? '13800010004' : '13800010005')
      const community = `Mock${label}藏文数字私号独立测试小区`
      const tibetanPhoneListing = addListing(companyListing ? '9903' : '9904', source, {
        block: PUBLIC_TIBETAN_PHONE,
        communityName: community,
        community,
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing
      })
      const tibetanPhonePublic = mockData.getListings({}).find((item) => item.id === tibetanPhoneListing.id)
      assert.ok(tibetanPhonePublic, `Mock 独立${label}藏文数字私号样本必须进入公共投影`)
      const normalizedTibetanBlock = Array.from(String(tibetanPhonePublic.block || '')).map((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint >= 0x0f20 && codePoint <= 0x0f29 ? String(codePoint - 0x0f20) : character
      }).join('').replace(/\D/g, '')
      assert.ok(!normalizedTibetanBlock.includes(PUBLIC_PRIVATE_PHONE_DIGITS), `Mock ${label}公开字段不得保留或转写藏文数字私号`)
    })

    for (let index = 0; index < PUBLIC_UNIT_PHONE_SMUGGLES.length; index += 1) {
      const privateValue = PUBLIC_UNIT_PHONE_SMUGGLES[index]
      await check(`Mock ${label}字段逐值阻断业务单位拼接私号 ${index + 1}`, () => {
        mockData.loginByPhone(companyListing ? '13800010004' : '13800010005')
        const community = `Mock${label}业务单位私号独立测试小区${index + 1}`
        const unitPhoneListing = addListing(`${companyListing ? '991' : '992'}${index}`, source, {
          block: privateValue,
          communityName: community,
          community,
          companyListing,
          isCompanyListing: companyListing,
          noCommission: companyListing
        })
        const unitPhonePublic = mockData.getListings({}).find((item) => item.id === unitPhoneListing.id)
        assert.ok(unitPhonePublic, `Mock 独立${label}业务单位私号样本必须进入公共投影：${privateValue}`)
        assert.notStrictEqual(unitPhonePublic.block, privateValue, `Mock ${label}公开字段不得完整保留业务单位拼接私号：${privateValue}`)
        assert.ok(!String(unitPhonePublic.block || '').replace(/\D/g, '').includes(PUBLIC_PRIVATE_PHONE_DIGITS), `Mock ${label}公开字段清洗后不得仍可还原业务单位拼接私号：${privateValue}`)
      })
    }
  }

  for (let index = 0; index < PUBLIC_WANYANG_ADDRESS_VARIANTS.length; index += 1) {
    const block = PUBLIC_WANYANG_ADDRESS_VARIANTS[index]
    await check(`Mock 合作房源逐值阻断完整地址变体 ${index + 1}`, () => {
      mockData.loginByPhone('13800010005')
      const community = `Mock完整地址变体独立测试小区${index + 1}`
      const addressVariantListing = addListing(String(9930 + index), '业主房源', {
        block,
        communityName: community,
        community,
        address: PUBLIC_WANYANG_ADDRESS,
        fullAddress: PUBLIC_WANYANG_ADDRESS,
        building: '1',
        unit: '1',
        roomNumber: '101'
      })
      const addressVariantPublic = mockData.getListings({}).find((item) => item.id === addressVariantListing.id)
      assert.ok(addressVariantPublic, `Mock 独立合作房源完整地址变体样本必须进入公共投影：${block}`)
      const normalizedAddressBlock = String(addressVariantPublic.block || '')
        .normalize('NFKC')
        .replace(/[\uE000-\uF8FF🫥·§Ж\s]/gu, '')
        .replace(/测试/g, '')
      assert.ok(!normalizedAddressBlock.includes(PUBLIC_WANYANG_ADDRESS), `Mock 合作房源 block 清洗后不得还原完整地址：${block}`)
      assert.ok(!(normalizedAddressBlock.includes('文一') && normalizedAddressBlock.includes('路万塘汇')), `Mock 合作房源 block 不得保留可拼接地址片段：${block}`)
    })
  }

  await check('Mock A栋/B單元/Building A/Flat/Floor/Level/Tower/Block 精确地址标签不得公开', () => {
    mockData.loginByPhone('13800010005')
    const preciseAddresses = PUBLIC_ENGLISH_ADDRESS_LABELS.concat(PUBLIC_TRADITIONAL_ADDRESS_LABELS)
    const community = 'Mock精确标签测试小区'
    const preciseAddressListing = addListing('9950', '业主房源', {
      block: preciseAddresses.join('；'),
      communityName: community,
      community,
      building: '2',
      unit: '3',
      address: `杭州拱墅区${community}2栋3单元909室`
    })
    const preciseAddressPublic = mockData.getListings({ publicGuest: true }).find((item) => item.id === preciseAddressListing.id)
    assert.ok(preciseAddressPublic)
    const publicText = String(preciseAddressPublic.block || '')
    preciseAddresses.forEach((preciseAddress) => {
      assert.ok(!publicText.includes(preciseAddress), `Mock 精确地址标签不得公开：${preciseAddress}`)
    })
  })

  for (const sourceCase of [
    { label: '公司', source: '公司房源', companyListing: true, phone: '13800010004' },
    { label: '合作', source: '业主房源', companyListing: false, phone: '13800010005' }
  ]) {
    const { label, source, companyListing, phone } = sourceCase
    await check(`Mock ${label}字段阻断 decoy/通用字母联系方式`, () => {
      mockData.loginByPhone(phone)
      const privateContacts = [PUBLIC_NOISY_WECHAT_DECOY].concat(PUBLIC_GENERIC_ALPHA_CONTACTS)
      const community = `Mock${label}字母联系方式测试小区`
      const contactListing = addListing(companyListing ? '10020' : '10040', source, {
        block: `安全板块 ${privateContacts.join('；')}`,
        communityName: community,
        community,
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing
      })
      const contactPublic = mockData.getListings({ publicGuest: true }).find((item) => item.id === contactListing.id)
      assert.ok(contactPublic)
      const contactText = String(contactPublic.block || '').toLowerCase()
      ;['realwx123', 'privateid', 'private_wx_01'].forEach((identifier) => {
        assert.ok(!contactText.includes(identifier), `Mock ${label}公开字段不得残留 ${identifier}`)
      })
    })

    await check(`Mock ${label}字段阻断混合中文/全角 O 私号`, () => {
      mockData.loginByPhone(phone)
      const privatePhones = [PUBLIC_FULLWIDTH_O_PHONE].concat(PUBLIC_MIXED_CHINESE_PHONE_VARIANTS)
      const community = `Mock${label}混合私号测试小区`
      const privatePhoneListing = addListing(companyListing ? '10060' : '10080', source, {
        block: `安全板块 ${privatePhones.join('；')}`,
        communityName: community,
        community,
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing
      })
      const privatePhonePublic = mockData.getListings({ publicGuest: true }).find((item) => item.id === privatePhoneListing.id)
      assert.ok(privatePhonePublic)
      const publicText = String(privatePhonePublic.block || '')
      const normalizedPhoneText = publicText.normalize('NFKC').replace(/[OoＯ]/g, '0').replace(/\D/g, '')
      assert.ok(!normalizedPhoneText.includes('18700001111') && !normalizedPhoneText.includes('18800007777'), `Mock ${label}公开字段不得保留可归一私号`)
      privatePhones.forEach((privatePhone) => {
        assert.ok(!publicText.includes(privatePhone), `Mock ${label}公开字段不得原样泄露混合私号：${privatePhone}`)
      })
    })
  }

  await check('Mock 合法日期/道路门牌/8 位公司密码与哨兵字面量保持原规则', () => {
    mockData.loginByPhone('13800010004')
    const companyPositiveListing = addListing('10120', '公司房源', {
      title: `公司公开文案 ${MOCK_PLACEHOLDER_COLLISION}`,
      block: PUBLIC_VALID_DATE_COPY,
      address: `${COMPANY_ROAD_ADDRESS} 联系电话18800007777 ${MOCK_PLACEHOLDER_COLLISION}`,
      fullAddress: `${COMPANY_ROAD_ADDRESS} 联系电话18800007777 ${MOCK_PLACEHOLDER_COLLISION}`,
      viewingMethod: '密码',
      viewingPassword: COMPANY_EIGHT_DIGIT_DOOR_PASSWORD,
      companyListing: true,
      isCompanyListing: true,
      noCommission: true
    })
    const companyPositiveCard = mockData.getListings({ publicGuest: true }).find((item) => item.id === companyPositiveListing.id)
    const companyPositiveDetail = mockData.getListingDetail(companyPositiveListing.id, { publicGuest: true, viewerId: '' })
    assert.strictEqual(companyPositiveCard.block, PUBLIC_VALID_DATE_COPY, 'Mock 合法日期与 ISO 时间必须原样保留')
    assert.ok(String(companyPositiveDetail.address || '').includes(COMPANY_ROAD_ADDRESS), 'Mock 缺少单元房号的道路门牌必须原样保留')
    assert.ok(!String(companyPositiveDetail.address || '').includes('18800007777'), 'Mock 道路门牌同字段私号仍必须删除')
    assert.strictEqual(companyPositiveDetail.viewingPassword, COMPANY_EIGHT_DIGIT_DOOR_PASSWORD, 'Mock 公司 8 位门锁密码必须原样保留')
    assert.ok(JSON.stringify(companyPositiveDetail).includes(MOCK_PLACEHOLDER_COLLISION), 'Mock 用户原文中的号码保护哨兵字面量必须原样保留')
  })

  await check('Mock 地址结构不得白洗 11 位私号', () => {
    mockData.loginByPhone('13800010004')
    const structuralPhoneListing = addListing('10121', '公司房源', {
      block: '安全板块 18800007777栋1单元101室',
      companyListing: true,
      isCompanyListing: true,
      noCommission: true
    })
    const structuralPhonePublic = mockData.getListings({ publicGuest: true }).find((item) => item.id === structuralPhoneListing.id)
    assert.ok(!String(structuralPhonePublic.block || '').replace(/\D/g, '').includes('18800007777'), 'Mock 楼栋/单元/房号结构不得把 11 位私号误当地址白洗')
  })

  await check('Mock 合作房源独立阻断英文精确房号 Suite 888', () => {
    mockData.loginByPhone('13800010005')
    const community = 'Mock英文精确房号独立测试小区'
    const englishSuiteListing = addListing('888', '业主房源', {
      block: PUBLIC_ENGLISH_SUITE,
      communityName: community,
      community,
      address: PUBLIC_ENGLISH_SUITE,
      fullAddress: PUBLIC_ENGLISH_SUITE,
      building: '1',
      unit: '1',
      roomNumber: '888'
    })
    const englishSuitePublic = mockData.getListings({}).find((item) => item.id === englishSuiteListing.id)
    assert.ok(englishSuitePublic, 'Mock 独立合作房源英文精确房号样本必须进入公共投影')
    assert.ok(!JSON.stringify(englishSuitePublic).toLowerCase().includes(PUBLIC_ENGLISH_SUITE.toLowerCase()), 'Mock 合作房源公共投影不得泄露英文精确房号 Suite 888')
  })

  await check('Mock 公司地图坐标元数据只使用固定枚举', async () => {
    mockData.loginByPhone('13800010004')
    const coordinateCompany = addListing('9899', '公司房源', {
      companyListing: true,
      isCompanyListing: true,
      communityName: '合成坐标枚举小区',
      community: '合成坐标枚举小区',
      address: '合成坐标枚举小区1栋1单元9899室',
      mapLatitude: 30.456,
      mapLongitude: 120.456,
      coordinateSource: 'admin-verified-coordinate contact privateid 19900000061'
    })
    const pin = mockData.getMapPins({ sourceType: '公司房源' }).find((item) => item.id === coordinateCompany.id)
    assert.ok(pin, 'Mock 公司坐标样本必须进入地图')
    assert.strictEqual(pin.coordinateSource, 'admin-verified-coordinate')
    assert.ok(!JSON.stringify(pin).includes('privateid') && !JSON.stringify(pin).includes('19900000061'), 'Mock 公司地图不得下发脏坐标来源文案')
  })

  if (failures.length) {
    const error = new Error(`Mock/预览契约仍有 ${failures.length} 项未满足：${failures.map((item) => item.name).join('；')}`)
    error.failures = failures
    throw error
  }

  console.log('mock-preview-parity-v1-test passed')
}

run().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
