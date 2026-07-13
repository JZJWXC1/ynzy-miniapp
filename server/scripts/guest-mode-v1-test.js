const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { hashPassword } = require('../src/auth-util')
const domain = require('../src/domain')
const BROKER_PASSWORD = 'broker-pass-123'
const PUBLIC_FIELD_SECRET_PHONE = '19900007777'
const PUBLIC_FIELD_SECRET_ADDRESS = '9栋8单元701室'
const PUBLIC_FIELD_LEGACY_ROOM = '9-8-701'
const PUBLIC_FIELD_SECRET_TAG = 'VX-PUBLIC-FIELD-SECRET'
const PUBLIC_ZERO_WIDTH_PHONE = '187\u200b0000\u200b1111'
const PUBLIC_DEFAULT_IGNORABLE_PHONE = '186\u20630000\u20632222'
const PUBLIC_COMBINING_PHONE = '185\u034f0000\ufe0f3333'
const PUBLIC_CHINESE_PHONE = '一八七零零零零一一一一'
const PUBLIC_FINANCIAL_PHONE = '壹捌柒零零零零壹壹壹壹'
const PUBLIC_EMOJI_PHONE = '187🫥0000🫥1111'
const PUBLIC_CHAINED_CONFUSABLE_PHONES = '187🫥0000🫥1111\u200b186🫥0000🫥2222'
const PUBLIC_KATAKANA_PHONE = '187・0000・1111'
const PUBLIC_ARABIC_COMMA_PHONE = '187،0000،1111'
const PUBLIC_ALPHA_PHONE = '187a0000a1111'
const PUBLIC_LONG_ALPHA_PHONE = '187abc0000abc1111'
const PUBLIC_VERY_LONG_ALPHA_PHONE = '187abcdefg0000abcdefg1111'
const PUBLIC_HAN_GAP_PHONE = '187测试0000测试1111'
const PUBLIC_FALSE_SAFE_SUFFIX_PHONE = '187号线0000号线1111'
const PUBLIC_SERVICE_PHONES = ['4001234567', '400-123-4567', '400a123a4567', '8001234567', '800a123a4567']
const PUBLIC_LABELED_LOCAL_PHONES = ['电话88888888', '电 话88888888', '座机8888-8888', '热线8888a8888', '客服8888🫥8888', '联系电话8888测试8888']
const PUBLIC_ENGLISH_LOCAL_PHONES = ['tel:88888888', 'phone:8888-8888', 'p h o n e88888888', 'mobile:88888888', 'contact:88888888', 'Call 88888888']
const PUBLIC_TRADITIONAL_LOCAL_PHONES = ['電話88888888', '聯絡電話88888888', '聯繫方式88888888', '手機88888888', '熱線88888888', '聯絡88888888']
const PUBLIC_NOISY_WECHAT_IDS = ['微🫥信:privateid', '微・信:privateid', 'w🫥x:privateid', 'we🫥chat:privateid', 'v🫥信:privateid']
const PUBLIC_ADDRESS_PHONE_SMUGGLES = ['房号139a1111a2222', '房号139🫥1111🫥2222', '房号一三九一一一一二二二二', '139a1111a2222室', '139a1111a2222房', '139a1111a2222号房', '路139a1111a2222号', '139a1111a2222楼', '139a1111a2222平方米', '139a1111a2222㎡', '139a1111a2222m2', '139a1111a2222元/月', '139a1111a2222公里']
const PUBLIC_YAO_PHONE = '幺八七零零零零幺幺幺幺'
const PUBLIC_ARABIC_INDIC_PHONE = '١٨٧٠٠٠٠١١١١'
const PUBLIC_KEYCAP_PHONE = '1️⃣8️⃣7️⃣0️⃣0️⃣0️⃣0️⃣1️⃣1️⃣1️⃣1️⃣'
const PUBLIC_COUNTRY_CODE_PHONE = '+86一八七零零零零一一一一'
const PUBLIC_FINANCIAL_ADDRESS = '玖栋捌单元柒零壹室'
const PUBLIC_EMOJI_ADDRESS = '9🏠栋8🔑单元701室'
const PUBLIC_CONFUSABLE_ROOM_CN = '七〇一室'
const PUBLIC_CONFUSABLE_ROOM_LATIN = '7O1室'
const PUBLIC_EXACT_ADDRESS_IN_BLOCK = 'PRIVATE-EXACT-BLOCK-LOCATION-XYZ'
const PUBLIC_EXACT_ADDRESS_IN_COMMUNITY = 'PRIVATE-EXACT-COMMUNITY-LOCATION-XYZ'
const PUBLIC_SENSITIVE_REMARK_COPY = 'PRIVATE-SENSITIVE-REMARK-COPY'
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
const PUBLIC_MEDIA_SECRET_KEY = 'house-videos/legacy/游客合作小区9栋8单元701室-19900007777.mp4'
const COMPANY_PRIVATE_MOBILE = '19800006666'
const COMPANY_PRIVATE_FULLWIDTH_MOBILE = '１９８００００６６６'
const COMPANY_PRIVATE_LANDLINE = '0571-87654321'
const COMPANY_PRIVATE_PAREN_LANDLINE = '(0571)8888-8888'
const COMPANY_PRIVATE_WECHAT = 'company_private_wx'
const COMPANY_PRIVATE_WECHAT_VARIANTS = ['private_wei_xin', 'private_we_chat', 'private_vxin', 'private_micro_id']
const COMPANY_PRIVATE_PUNCTUATED_MOBILE = '18700001111'
const COMPANY_RAW_LISTING_PHONE = '13922223333'
const COMPANY_PRIVATE_LOCAL_LANDLINES = ['01064853453', '02112345678']
const COMPANY_PLACEHOLDER_COLLISION = '__YNZY_ALLOWED_PHONE_A__'

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-guest-mode-'))
const dataFile = path.join(tempDir, 'db.json')
const mediaPreloadFile = path.join(tempDir, 'synthetic-oss-preload.js')
const port = 39000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function writeSyntheticOssPreload() {
  const preload = `
const https = require('https')
const { EventEmitter } = require('events')
const { Readable } = require('stream')
const originalRequest = https.request.bind(https)
const jpegBody = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/Iaf/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z', 'base64')
https.request = function syntheticOssRequest(input, options, callback) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.hostname !== 'synthetic-bucket.oss-cn-example.aliyuncs.com') {
    return originalRequest(input, options, callback)
  }
  const request = new EventEmitter()
  request.setTimeout = function setTimeoutNoop() { return request }
  request.destroy = function destroyNoop() {}
  request.end = function endSyntheticRequest() {
    process.nextTick(function respond() {
      const cover = url.searchParams.has('x-oss-process')
      const body = cover ? jpegBody : Buffer.from('synthetic-video')
      const response = Readable.from(String((options && options.method) || 'GET').toUpperCase() === 'HEAD' ? [] : [body])
      response.statusCode = 200
      response.headers = {
        'content-type': cover ? 'image/jpeg' : 'video/mp4',
        'content-length': String(body.length)
      }
      callback(response)
    })
  }
  return request
}
`
  fs.writeFileSync(mediaPreloadFile, preload, 'utf8')
}

function listing(overrides = {}) {
  const now = nowText()
  return {
    id: 'L0',
    title: '游客模式测试房源',
    shortTitle: '游客模式测试小区',
    uploaderId: 'U1',
    rent: 2800,
    layout: '整租两室一厅',
    city: '杭州',
    district: '拱墅区',
    area: '拱墅区',
    block: '测试板块',
    community: '游客模式测试小区',
    building: '1幢',
    unit: '1单元',
    roomNumber: '101',
    address: '杭州拱墅区游客模式测试小区1幢1单元101室',
    landlordPhone: '13911112222',
    status: '在租',
    reviewStatus: '无需审核',
    lifecycleStatus: 'active',
    ownerType: '二房东房源',
    houseSourceType: '二房东房源',
    type: '整租',
    rentMode: '整租',
    source: '普通上传',
    videoUrl: '',
    videoKey: PUBLIC_MEDIA_SECRET_KEY,
    lastVerifiedAt: now,
    updatedAt: now,
    createdAt: now,
    mapLatitude: 30.35,
    mapLongitude: 120.16,
    coordinateSource: 'admin-verified-coordinate',
    coordinateVerified: true,
    ...overrides
  }
}

function seedDb() {
  const db = {
    currentUserId: 'U1',
    users: [
      { id: 'U1', name: '测试中介', phone: '13900000001', role: '中介', authed: '手机号登录', passwordHash: hashPassword(BROKER_PASSWORD) },
      { id: 'U2', name: '其他中介', phone: '13900000002', role: '中介', authed: '手机号登录', passwordHash: hashPassword(BROKER_PASSWORD) }
    ],
    listings: [
      listing({
        id: 'GUEST_COMPANY',
        city: `杭州 ${PUBLIC_NOISY_WECHAT_IDS.join(' ')} ${PUBLIC_ENGLISH_LOCAL_PHONES.join(' ')} ${PUBLIC_TRADITIONAL_LOCAL_PHONES.join(' ')} ${PUBLIC_ADDRESS_PHONE_SMUGGLES.join(' ')}`,
        title: `游客可见公司房源 ${COMPANY_PRIVATE_MOBILE} 全角 ${COMPANY_PRIVATE_FULLWIDTH_MOBILE} 座机 ${COMPANY_PRIVATE_PAREN_LANDLINE} 点号 187.0000.1111 零宽 ${PUBLIC_ZERO_WIDTH_PHONE} 不可见 ${PUBLIC_DEFAULT_IGNORABLE_PHONE} 组合 ${PUBLIC_COMBINING_PHONE} 中文 ${PUBLIC_CHINESE_PHONE} 大写 ${PUBLIC_FINANCIAL_PHONE} 口语 ${PUBLIC_YAO_PHONE} 阿拉伯 ${PUBLIC_ARABIC_INDIC_PHONE} 键帽 ${PUBLIC_KEYCAP_PHONE} 国家码 ${PUBLIC_COUNTRY_CODE_PHONE} 表情 ${PUBLIC_EMOJI_PHONE} 全角O ${PUBLIC_FULLWIDTH_O_PHONE} 混合中文 ${PUBLIC_MIXED_CHINESE_PHONE_VARIANTS.join(' ')} 日文点 ${PUBLIC_KATAKANA_PHONE} 阿拉伯逗号 ${PUBLIC_ARABIC_COMMA_PHONE} 字母 ${PUBLIC_ALPHA_PHONE} 长字母 ${PUBLIC_LONG_ALPHA_PHONE} 超长字母 ${PUBLIC_VERY_LONG_ALPHA_PHONE} 汉字间隔 ${PUBLIC_HAN_GAP_PHONE} 伪地铁 ${PUBLIC_FALSE_SAFE_SUFFIX_PHONE} ${PUBLIC_SERVICE_PHONES.join(' ')} ${PUBLIC_LABELED_LOCAL_PHONES.join(' ')} ${PUBLIC_NOISY_WECHAT_IDS.join(' ')}`,
        shortTitle: `游客公司小区 微信号:${COMPANY_PRIVATE_WECHAT}`,
        community: `游客公司小区 微信号:${COMPANY_PRIVATE_WECHAT} 斜杠 187/0000/1111`,
        block: `公司测试板块 ${COMPANY_PRIVATE_MOBILE} 长破折号 187—0000—1111`,
        layout: `整租两室一厅 ${COMPANY_PRIVATE_LANDLINE}`,
        address: `杭州拱墅区游客公司小区1幢1单元1313室 ${COMPANY_PLACEHOLDER_COLLISION} 座机${COMPANY_PRIVATE_LOCAL_LANDLINES[0]} 统一咨询19900000001 后置座机${COMPANY_PRIVATE_LOCAL_LANDLINES[1]} ${PUBLIC_ADJACENT_CONTACT_COPY} 联系电话:${COMPANY_PRIVATE_MOBILE}`,
        ownerType: '公司房源',
        houseSourceType: '公司房源',
        source: '公司房源',
        companyListing: true,
        isCompanyListing: true,
        noCommission: true,
        videoUrl: '',
        videoKey: '',
        landlordPhone: COMPANY_RAW_LISTING_PHONE,
        viewingPassword: '246810#',
        remark: `水电自理 微信号:${COMPANY_PRIVATE_WECHAT} wei xin:${COMPANY_PRIVATE_WECHAT_VARIANTS[0]}`,
        videoLabel: `房源实拍 联系电话:${COMPANY_PRIVATE_MOBILE} we chat:${COMPANY_PRIVATE_WECHAT_VARIANTS[1]}`,
        features: ['免押金', `近地铁 ${COMPANY_PRIVATE_MOBILE}`, `v信:${COMPANY_PRIVATE_WECHAT_VARIANTS[2]}`, `微号:${COMPANY_PRIVATE_WECHAT_VARIANTS[3]}`],
        coordinateSource: `admin-verified-coordinate contact privateid ${PUBLIC_FIELD_SECRET_PHONE}`,
        coordinateStatus: `verified contact privateid ${PUBLIC_FIELD_SECRET_PHONE}`,
        coordinateLabel: `verified contact privateid ${PUBLIC_FIELD_SECRET_PHONE}`
      }),
      listing({
        id: 'GUEST_PARTNER',
        title: '游客可见合作房源',
        shortTitle: '游客合作小区',
        community: `游客合作小区 ${PUBLIC_ZERO_WIDTH_PHONE} ${PUBLIC_DEFAULT_IGNORABLE_PHONE} ${PUBLIC_COMBINING_PHONE} ${PUBLIC_EXACT_ADDRESS_IN_COMMUNITY}`,
        block: `测试板块 9 8 701 单独楼栋 9 ${PUBLIC_FIELD_SECRET_PHONE} ${PUBLIC_FIELD_SECRET_ADDRESS} ${PUBLIC_FIELD_LEGACY_ROOM} 房号702 ${PUBLIC_CONFUSABLE_ROOM_CN} ${PUBLIC_CONFUSABLE_ROOM_LATIN} ${PUBLIC_FINANCIAL_ADDRESS} ${PUBLIC_EMOJI_ADDRESS} ${PUBLIC_PUNCTUATED_ADDRESS} ${PUBLIC_PUNCTUATED_COMPOSITE_ADDRESS} ${PUBLIC_PUNCTUATED_ROOM_LABEL} ${PUBLIC_ALPHA_GAP_ADDRESS} ${PUBLIC_HAN_GAP_ADDRESS} ${PUBLIC_ALPHA_COMPOSITE_ADDRESS} ${PUBLIC_FINANCIAL_WORD_ADDRESS} ${PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS} ${PUBLIC_ENGLISH_ADDRESS_LABELS.join(' ')} ${PUBLIC_CHINESE_ADDRESS_LABELS.join(' ')} ${PUBLIC_TRADITIONAL_ADDRESS_LABELS.join(' ')} ${PUBLIC_CHINESE_PHONE} ${PUBLIC_YAO_PHONE} ${PUBLIC_ARABIC_INDIC_PHONE} ${PUBLIC_KEYCAP_PHONE} ${PUBLIC_COUNTRY_CODE_PHONE} ${PUBLIC_EMOJI_PHONE} ${PUBLIC_FULLWIDTH_O_PHONE} ${PUBLIC_MIXED_CHINESE_PHONE_VARIANTS.join(' ')} ${PUBLIC_CHAINED_CONFUSABLE_PHONES} ${PUBLIC_KATAKANA_PHONE} ${PUBLIC_ARABIC_COMMA_PHONE} ${PUBLIC_ALPHA_PHONE} ${PUBLIC_LONG_ALPHA_PHONE} ${PUBLIC_VERY_LONG_ALPHA_PHONE} ${PUBLIC_HAN_GAP_PHONE} ${PUBLIC_FALSE_SAFE_SUFFIX_PHONE} ${PUBLIC_SERVICE_PHONES.join(' ')} ${PUBLIC_LABELED_LOCAL_PHONES.join(' ')} ${PUBLIC_ENGLISH_LOCAL_PHONES.join(' ')} ${PUBLIC_TRADITIONAL_LOCAL_PHONES.join(' ')} ${PUBLIC_NOISY_WECHAT_IDS.join(' ')} ${PUBLIC_EXACT_ADDRESS_IN_BLOCK} ${PUBLIC_SENSITIVE_REMARK_COPY} ${PUBLIC_SEMANTIC_DIGITS} ${PUBLIC_PHONE_SHAPED_SEMANTICS} ${PUBLIC_SAFE_ENGLISH_NUMERIC_COPY}`,
        layout: `整租两室一厅 9 8 701 单独单元 8 ${PUBLIC_FIELD_SECRET_PHONE} ${PUBLIC_FIELD_SECRET_ADDRESS} ${PUBLIC_FIELD_LEGACY_ROOM}`,
        tags: ['近地铁', PUBLIC_FIELD_SECRET_TAG],
        building: '9',
        unit: '8',
        roomNumber: '701',
        room: '两室',
        roomAddress: PUBLIC_FIELD_LEGACY_ROOM,
        address: '杭州拱墅区游客合作小区9栋8单元701室',
        fullAddress: PUBLIC_EXACT_ADDRESS_IN_BLOCK,
        locationSummary: PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
        landlordPhone: '13933334444',
        viewingMethod: '密码',
        viewingPassword: 'PARTNER-SECRET-2468',
        viewingKeyLocation: 'PARTNER-SECRET-KEY',
        remark: 'PARTNER-SECRET-REMARK 门口鞋柜取钥匙',
        ownerType: '二房东房源',
        houseSourceType: '二房东房源',
        source: '普通上传',
        sourceType: PUBLIC_FIELD_SECRET_PHONE,
        note: '游客合作小区',
        memo: PUBLIC_SENSITIVE_REMARK_COPY,
        reviewStatus: '已通过',
        requiresManualReview: false,
        manualReviewReason: `AUTH-INTERNAL-SYNTHETIC-REASON contact privateid ${PUBLIC_FIELD_SECRET_PHONE} ${PUBLIC_FIELD_SECRET_ADDRESS}`,
        communityMatched: true,
        communityMatchStatus: '已匹配',
        status: `在租 ${PUBLIC_FIELD_SECRET_PHONE}`,
        rent: PUBLIC_FIELD_SECRET_PHONE,
        mapLatitude: 30.361234,
        mapLongitude: 120.171234
      }),
      listing({
        id: 'GUEST_OWNER',
        title: '游客可见业主房源',
        shortTitle: '101国际城',
        block: '17号板块',
        community: '101国际城',
        layout: '17㎡三室一厅 17m²三室 17m2三室 17平方米三室',
        room: '三室',
        building: '17',
        unit: '1',
        roomNumber: '101',
        address: '杭州拱墅区101国际城17栋1单元101室',
        fullAddress: '杭州拱墅区101国际城17栋1单元101室',
        landlordPhone: '13955556666',
        viewingMethod: '钥匙',
        viewingKeyLocation: 'OWNER-SECRET-KEY',
        viewingPassword: 'OWNER-SECRET-PASSWORD',
        remark: 'OWNER-SECRET-REMARK 楼下便利店拿钥匙',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        source: '业主房源',
        companyListing: false,
        isCompanyListing: false,
        requiresManualReview: true,
        reviewStatus: '已通过',
        mapLatitude: 30.371234,
        mapLongitude: 120.181234
      }),
      listing({
        id: 'GUEST_DIRTY_RENTED',
        updatedAt: `2026-07-14T10:20:30.000Z ${PUBLIC_FIELD_SECRET_PHONE}`,
        syncedAt: '2026-07-14T10:20:30.000Z',
        feishuLastSyncAction: `synthetic-sync contact privateid ${PUBLIC_FIELD_SECRET_PHONE} ${PUBLIC_FIELD_SECRET_ADDRESS}`,
        feishuLastSyncAt: `2026-07-14T10:21:30.000Z ${PUBLIC_FIELD_SECRET_ADDRESS}`,
        status: `已出租 ${PUBLIC_FIELD_SECRET_PHONE}`,
        lifecycleStatus: 'active',
        videoKey: 'house-videos/synthetic/dirty-rented.mp4'
      }),
      listing({
        id: 'GUEST_DIRTY_WITHDRAWN',
        status: '不租了',
        lifecycleStatus: 'active',
        videoKey: 'house-videos/synthetic/dirty-withdrawn.mp4'
      }),
      listing({
        id: 'GUEST_DIRTY_PAUSED',
        status: '暂停出租',
        lifecycleStatus: 'active',
        videoKey: 'house-videos/synthetic/dirty-paused.mp4'
      }),
      listing({
        id: 'GUEST_PENDING_OWNER',
        title: '本人待审核合成视频房源',
        shortTitle: '待审核媒体小区',
        community: '待审核媒体小区',
        block: '测试板块',
        building: '2',
        unit: '3',
        roomNumber: '909',
        address: '杭州拱墅区待审核媒体小区2栋3单元909室',
        ownerType: '业主房源',
        houseSourceType: '业主房源',
        source: '业主房源',
        reviewStatus: '待审核',
        requiresManualReview: true,
        manualReviewReason: '合成待审核样本',
        status: '待审核',
        videoUrl: '',
        videoKey: 'house-videos/synthetic/pending-owner-review.mp4'
      })
    ],
    rentalNeeds: [
      {
        id: 'N1',
        brokerId: 'U1',
        rawText: '客户找游客公司小区两室',
        confirmedNeed: { community: '游客公司小区', layout: '两室', budget: 3000 },
        status: 'active'
      }
    ],
    footprints: [],
    clientReports: [],
    dealRecords: [],
    commissionRecords: [],
    commissionConfig: {
      secondLandlordRate: 21,
      secondLandlordPlatformRate: 9,
      ownerRate: 22,
      ownerPlatformRate: 8,
      updatedAt: nowText(),
      updatedBy: 'PRIVATE_ADMIN_ID'
    },
    companySheetSnapshot: {
      title: '游客模式公司房源表 19800007777',
      sheetUrl: 'https://synthetic.feishu.example/sheets/PRIVATE_SHEET_TOKEN',
      range: 'PRIVATE_SHEET_TOKEN!A1:ZZ1000',
      cachedAt: '内部缓存时间',
      startRow: 5,
      startCol: 2,
      updatedAt: nowText(),
      rows: [
        ['公司简介，联系电话：+86 198-0000-9999；座机：0571-12345678；微信号：private_wx_01'],
        ['区域', '小区', '房号', '户型描述', '户型分类', '押一付一', '押二付一', '看房方式密码', '备注', '房东电话', '微信号'],
        ['拱墅', '游客公司小区', '1-1-101', '两室一厅', '两室', '2800', '2600', '246810#', '水电自理', '139 0000 1111', 'raw_wechat_02']
      ],
      rowCount: 3,
      columnCount: 11
    }
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        let parsed = {}
        try {
          parsed = raw ? JSON.parse(raw) : {}
        } catch (error) {
          parsed = { raw }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 12000) {
    try {
      const res = await request('GET', '/healthz')
      if (res.statusCode === 200) return true
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

function dataOf(response) {
  return response.body && response.body.data
}

const PARTNER_SENSITIVE_FIELDS = [
  'building', 'unit', 'roomNumber', 'roomAddress', 'address', 'fullAddress',
  'landlordPhone', 'contact', 'companyContactPhones', 'companyContactPhoneText',
  'viewingMethod', 'viewingMethodText', 'viewingKeyLocation', 'keyLocation',
  'viewingPassword', 'showingPassword', 'password', 'remark', 'note', 'memo'
]

const AUTHENTICATED_INTERNAL_DISPLAY_FIELDS = [
  'reviewStatus', 'requiresManualReview', 'manualReviewReason', 'communityMatched', 'communityMatchStatus'
]

const PARTNER_SENSITIVE_VALUES = [
  '隐私二幢', '隐私三单元', '隐私302', '13933334444', 'PARTNER-SECRET',
  '隐私五幢', '隐私六单元', '隐私601', '13955556666', 'OWNER-SECRET',
  PUBLIC_FIELD_SECRET_PHONE, PUBLIC_FIELD_SECRET_ADDRESS, PUBLIC_FIELD_SECRET_TAG,
  PUBLIC_FIELD_LEGACY_ROOM, '房号702', PUBLIC_ZERO_WIDTH_PHONE, PUBLIC_DEFAULT_IGNORABLE_PHONE, PUBLIC_COMBINING_PHONE,
  PUBLIC_CHINESE_PHONE, PUBLIC_FINANCIAL_PHONE, PUBLIC_YAO_PHONE, PUBLIC_ARABIC_INDIC_PHONE, PUBLIC_KEYCAP_PHONE,
  PUBLIC_COUNTRY_CODE_PHONE, PUBLIC_EMOJI_PHONE, PUBLIC_FULLWIDTH_O_PHONE, ...PUBLIC_MIXED_CHINESE_PHONE_VARIANTS, PUBLIC_CHAINED_CONFUSABLE_PHONES, PUBLIC_KATAKANA_PHONE, PUBLIC_ARABIC_COMMA_PHONE, PUBLIC_ALPHA_PHONE, PUBLIC_LONG_ALPHA_PHONE, PUBLIC_VERY_LONG_ALPHA_PHONE, PUBLIC_HAN_GAP_PHONE, PUBLIC_FALSE_SAFE_SUFFIX_PHONE,
  ...PUBLIC_SERVICE_PHONES, ...PUBLIC_LABELED_LOCAL_PHONES, ...PUBLIC_ENGLISH_LOCAL_PHONES, ...PUBLIC_TRADITIONAL_LOCAL_PHONES, ...PUBLIC_NOISY_WECHAT_IDS,
  PUBLIC_FINANCIAL_ADDRESS, PUBLIC_EMOJI_ADDRESS, PUBLIC_PUNCTUATED_ADDRESS, PUBLIC_PUNCTUATED_COMPOSITE_ADDRESS, PUBLIC_PUNCTUATED_ROOM_LABEL, PUBLIC_ALPHA_GAP_ADDRESS, PUBLIC_HAN_GAP_ADDRESS, PUBLIC_ALPHA_COMPOSITE_ADDRESS, PUBLIC_FINANCIAL_WORD_ADDRESS, PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS,
  ...PUBLIC_ENGLISH_ADDRESS_LABELS, ...PUBLIC_CHINESE_ADDRESS_LABELS, ...PUBLIC_TRADITIONAL_ADDRESS_LABELS,
  PUBLIC_CONFUSABLE_ROOM_CN, PUBLIC_CONFUSABLE_ROOM_LATIN, PUBLIC_EXACT_ADDRESS_IN_BLOCK, PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
  PUBLIC_SENSITIVE_REMARK_COPY
]

function assertPublicPartnerRow(row, context) {
  assert.ok(row && row.id, `${context} 必须返回房源`)
  assert.strictEqual(row.city, '杭州', `${context} 必须保留真实公开城市`)
  assert.strictEqual(row.district || row.area, '拱墅区', `${context} 必须保留真实公开区域`)
  assert.ok(row.block, `${context} 必须公开板块`)
  assert.ok(row.community, `${context} 必须公开小区`)
  PARTNER_SENSITIVE_FIELDS.forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `${context} 不得下发敏感字段 ${field}`)
  })
  const text = JSON.stringify(row)
  PARTNER_SENSITIVE_VALUES.forEach((value) => {
    assert.ok(!text.includes(value), `${context} 不得包含敏感值 ${value}`)
  })
}

function requestBuffer(method, targetPath, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function assertGuestInternalFieldsAbsent(row, context) {
  AUTHENTICATED_INTERNAL_DISPLAY_FIELDS.concat(['uploader', 'uploaderId']).forEach((field) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row || {}, field), `${context} 游客投影不得下发登录内部字段 ${field}`)
  })
  assert.ok(!String((row && row.sub) || '').includes('上传人'), `${context} 游客卡片不得显示上传人文案`)
}

function assertAuthenticatedPartnerDisplay(row, context, options = {}) {
  assertPublicPartnerRow(row, context)
  const expected = {
    reviewStatus: '已通过',
    requiresManualReview: false,
    manualReviewReason: 'AUTH-INTERNAL-SYNTHETIC-REASON',
    communityMatched: true,
    communityMatchStatus: '已匹配'
  }
  Object.entries(expected).forEach(([field, value]) => {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `${context} 必须恢复登录态非敏感字段 ${field}`)
    assert.strictEqual(row[field], value, `${context} 的 ${field} 必须来自服务端存量值`)
  })
  if (options.detail) {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploader'), `${context} 详情不得新增 uploader`)
  } else {
    assert.ok(String(row.sub || '').includes('上传人 测试中介'), `${context} 卡片 sub 必须恢复服务端可信上传人文案`)
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploader'), `${context} 不得新增 uploader 对象字段`)
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'uploaderId'), `${context} 不得下发 uploaderId`)
}

function assertAllPublicSources(rows, context) {
  assert.ok(Array.isArray(rows), `${context} 必须返回数组`)
  assert.deepStrictEqual(rows.map((row) => row.id).sort(), ['GUEST_COMPANY', 'GUEST_OWNER', 'GUEST_PARTNER'], `${context} 必须公开全部三类有效房源`)
  rows.filter((row) => !row.companyListing).forEach((row) => assertPublicPartnerRow(row, `${context}/${row.id}`))
  rows.filter((row) => !row.companyListing).forEach((row) => assertGuestInternalFieldsAbsent(row, `${context}/${row.id}`))
  assertNoCompanyPrivateContact(rows.find((row) => row.companyListing), `${context}/公司房源`)
  const text = JSON.stringify(rows)
  assert.ok(!text.includes(PUBLIC_MEDIA_SECRET_KEY), `${context} 不得下发历史视频对象键`)
  assert.ok(!/OSSAccessKeyId|Signature/.test(text), `${context} 不得下发 OSS 签名 URL`)
  rows.filter((row) => row.hasVideo).forEach((row) => {
    assert.ok(String(row.videoUrl || '').startsWith(`${baseUrl}/mini/listings/${row.id}/media/video?token=`), `${context}/${row.id} 视频必须使用 API 域不透明能力 URL`)
    assert.ok(String(row.coverUrl || '').startsWith(`${baseUrl}/mini/listings/${row.id}/media/cover?token=`), `${context}/${row.id} 封面必须使用 API 域不透明能力 URL`)
  })
}

function assertNoCompanyPrivateContact(value, context) {
  const text = JSON.stringify(value || {})
  assert.ok(!/YNZYALLOWED|[\uE000-\uF8FF]/u.test(text), `${context} 不得残留内部号码保护哨兵或私用区字符`)
  const compact = text.normalize('NFKC').replace(/[\u00AD\u034F\u180E\u200B-\u200F\u2060-\u206F\uFE00-\uFE0F\uFEFF+\s\-()./—]/g, '')
  ;[COMPANY_PRIVATE_MOBILE, COMPANY_PRIVATE_LANDLINE.replace(/\D/g, ''), COMPANY_PRIVATE_PAREN_LANDLINE.replace(/\D/g, ''), COMPANY_PRIVATE_PUNCTUATED_MOBILE, '18600002222', '18500003333', COMPANY_RAW_LISTING_PHONE, ...COMPANY_PRIVATE_LOCAL_LANDLINES].forEach((privateContact) => {
    assert.ok(!compact.includes(privateContact), `${context} 不得包含公司房源原始联系方式 ${privateContact}`)
  })
  ;[PUBLIC_CHINESE_PHONE, PUBLIC_FINANCIAL_PHONE, PUBLIC_YAO_PHONE, PUBLIC_ARABIC_INDIC_PHONE, PUBLIC_KEYCAP_PHONE, PUBLIC_COUNTRY_CODE_PHONE, PUBLIC_EMOJI_PHONE, PUBLIC_FULLWIDTH_O_PHONE, ...PUBLIC_MIXED_CHINESE_PHONE_VARIANTS, PUBLIC_KATAKANA_PHONE, PUBLIC_ARABIC_COMMA_PHONE, PUBLIC_ALPHA_PHONE, PUBLIC_LONG_ALPHA_PHONE, PUBLIC_VERY_LONG_ALPHA_PHONE, PUBLIC_HAN_GAP_PHONE, PUBLIC_FALSE_SAFE_SUFFIX_PHONE].forEach((privateContact) => {
    assert.ok(!text.includes(privateContact), `${context} 不得包含中文数字或非标分隔的公司私号 ${privateContact}`)
  })
  ;[...PUBLIC_SERVICE_PHONES, ...PUBLIC_LABELED_LOCAL_PHONES, ...PUBLIC_ENGLISH_LOCAL_PHONES, ...PUBLIC_TRADITIONAL_LOCAL_PHONES, ...PUBLIC_NOISY_WECHAT_IDS, ...PUBLIC_ADDRESS_PHONE_SMUGGLES].forEach((privateContact) => {
    assert.ok(!text.includes(privateContact), `${context} 不得包含客服号、本地座机或噪声拆分微信 ${privateContact}`)
  })
  assert.ok(!text.includes(COMPANY_PRIVATE_WECHAT), `${context} 不得包含公司房源原始微信号`)
  COMPANY_PRIVATE_WECHAT_VARIANTS.forEach((privateWechat) => {
    assert.ok(!text.includes(privateWechat), `${context} 不得包含空格/中英混写的公司房源原始微信号 ${privateWechat}`)
  })
}

function listingIdsFromPins(rows) {
  return Array.from(new Set((rows || []).flatMap((item) => item.activeListingIds || []))).sort()
}

async function run() {
  PUBLIC_ADDRESS_PHONE_SMUGGLES.forEach((privatePhone, index) => {
    const isolatedCompanyListing = listing({
      id: `ISOLATED-COMPANY-SAFE-SUFFIX-${index + 1}`,
      city: `杭州 ${privatePhone}`,
      ownerType: '公司房源',
      houseSourceType: '公司房源',
      source: '公司房源',
      companyListing: true,
      isCompanyListing: true,
      noCommission: true,
      landlordPhone: COMPANY_RAW_LISTING_PHONE
    })
    const isolatedCompanyPublic = domain.filterListings({ listings: [isolatedCompanyListing] }, { publicGuest: true })[0]
    assert.ok(isolatedCompanyPublic, `公司安全词尾攻击样本必须进入公共投影 ${privatePhone}`)
    assert.ok(!JSON.stringify(isolatedCompanyPublic).includes(privatePhone), `公司公开字段不得用合法业务词尾打断完整私号清洗 ${privatePhone}`)
  })
  const reviewedAsciiAlias = listing({
    id: 'REVIEWED-ASCII-ALIAS',
    community: PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
    address: PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
    fullAddress: PUBLIC_EXACT_ADDRESS_IN_COMMUNITY,
    reviewStatus: '已通过',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    coordinateVerified: true,
    rent: '057112345678'
  })
  const reviewedAsciiPublic = domain.filterListings({ listings: [reviewedAsciiAlias] }, { publicGuest: true })[0]
  assert.ok(reviewedAsciiPublic, '已审核合作房源必须进入公共投影测试')
  assert.ok(!JSON.stringify(reviewedAsciiPublic).includes(PUBLIC_EXACT_ADDRESS_IN_COMMUNITY), '审核/坐标标记不能让完整地址值自我白名单成公共小区')
  assert.strictEqual(reviewedAsciiPublic.rent, 0, '座机形状的纯数字租金不得进入公共 DTO')
  const reviewedChineseAlias = listing({
    id: 'REVIEWED-CHINESE-ALIAS',
    community: '京漾东韵府北门内侧',
    address: '京漾东韵府北门内侧',
    fullAddress: '京漾东韵府北门内侧',
    reviewStatus: '已通过',
    communityMatched: true,
    communityMatchStatus: '已匹配',
    coordinateVerified: true
  })
  const reviewedChinesePublic = domain.filterListings({ listings: [reviewedChineseAlias] }, { publicGuest: true })[0]
  assert.ok(!JSON.stringify(reviewedChinesePublic).includes('京漾东韵府北门内侧'), '非服务端小区词库精确命中的中文完整地址不得因审核标记自我白名单')
  const falseSafeSuffixListing = listing({
    id: 'FALSE-SAFE-SUFFIX-PHONE',
    block: PUBLIC_FALSE_SAFE_SUFFIX_PHONE,
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    landlordPhone: COMPANY_RAW_LISTING_PHONE
  })
  const falseSafeSuffixPublic = domain.filterListings({ listings: [falseSafeSuffixListing] }, { publicGuest: true })[0]
  assert.ok(falseSafeSuffixPublic, '独立公司伪地铁私号样本必须进入公共投影')
  assert.notStrictEqual(falseSafeSuffixPublic.block, PUBLIC_FALSE_SAFE_SUFFIX_PHONE, '公司公开 block 单值不得完整保留伪装成地铁语义的私号')
  assert.ok(!JSON.stringify(falseSafeSuffixPublic).includes(PUBLIC_FALSE_SAFE_SUFFIX_PHONE), '较长数字 token 的尾部不得被误认作合法地铁号并打断私号清洗')

  const independentHanGapAddressListing = listing({
    id: 'INDEPENDENT-HAN-GAP-ADDRESS',
    block: PUBLIC_HAN_GAP_ADDRESS,
    building: '9',
    unit: '8',
    roomNumber: '701',
    address: '杭州拱墅区游客模式测试小区9栋8单元701室'
  })
  const independentHanGapAddressPublic = domain.filterListings({ listings: [independentHanGapAddressListing] }, { publicGuest: true })[0]
  assert.ok(independentHanGapAddressPublic, '独立合作房源汉字间隔精确地址样本必须进入公共投影')
  assert.ok(!String(independentHanGapAddressPublic.block || '').includes(PUBLIC_HAN_GAP_ADDRESS), '合作房源 block 单值不得泄露汉字间隔的楼栋单元房号')

  const independentLegalBlockListing = listing({
    id: 'INDEPENDENT-LEGAL-NUMERIC-BLOCK',
    block: PUBLIC_PHONE_SHAPED_SEMANTICS,
    building: '1',
    unit: '1',
    roomNumber: '101'
  })
  const independentLegalBlockPublic = domain.filterListings({ listings: [independentLegalBlockListing] }, { publicGuest: true })[0]
  assert.ok(independentLegalBlockPublic, '独立合法数字 block 样本必须进入公共投影')
  assert.strictEqual(independentLegalBlockPublic.block, PUBLIC_PHONE_SHAPED_SEMANTICS, '真实 1栋1单元101室不得导致合法数字 block 被截断或改写')

  PUBLIC_LEGAL_NUMERIC_LAYOUTS.forEach((layout, index) => {
    const independentLegalLayoutListing = listing({
      id: `INDEPENDENT-LEGAL-NUMERIC-LAYOUT-${index + 1}`,
      block: '合法数字户型测试板块',
      layout,
      building: '1',
      unit: '1',
      roomNumber: '101'
    })
    const independentLegalLayoutPublic = domain.filterListings({ listings: [independentLegalLayoutListing] }, { publicGuest: true })[0]
    assert.ok(independentLegalLayoutPublic, `独立合法数字 layout 样本必须进入公共投影：${layout}`)
    assert.strictEqual(independentLegalLayoutPublic.layout, layout, `真实 1栋1单元101室不得导致合法 layout 被截断或改写：${layout}`)
  })

  const independentCompanySquareMeterListing = listing({
    id: 'INDEPENDENT-COMPANY-SQUARE-METER-LAYOUT',
    layout: '17㎡三室',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    landlordPhone: COMPANY_RAW_LISTING_PHONE
  })
  const independentCompanySquareMeterPublic = domain.filterListings({ listings: [independentCompanySquareMeterListing] }, { publicGuest: true })[0]
  assert.ok(independentCompanySquareMeterPublic, '独立公司合法面积户型样本必须进入公共投影')
  assert.strictEqual(independentCompanySquareMeterPublic.layout, '17㎡三室', '公司原文 17㎡三室 必须保留平方米符号，不得改写')

  ;[
    { label: '公司', source: '公司房源', companyListing: true },
    { label: '合作', source: '二房东房源', companyListing: false }
  ].forEach(({ label, source, companyListing }, index) => {
    const noisyWechatListing = listing({
      id: `INDEPENDENT-${label}-NOISY-WECHAT-GAP`,
      block: PUBLIC_NOISY_WECHAT_GAP,
      ownerType: source,
      houseSourceType: source,
      source: companyListing ? '公司房源' : '普通上传',
      companyListing,
      isCompanyListing: companyListing,
      noCommission: companyListing,
      landlordPhone: companyListing ? COMPANY_RAW_LISTING_PHONE : '13911112222'
    })
    const noisyWechatPublic = domain.filterListings({ listings: [noisyWechatListing] }, { publicGuest: true })[0]
    assert.ok(noisyWechatPublic, `独立${label}噪声微信样本必须进入公共投影`)
    assert.ok(!String(noisyWechatPublic.block || '').toLowerCase().includes(PUBLIC_NOISY_WECHAT_ID), `${label}公开字段不得残留噪声拆分微信 ID`)

    const tibetanPhoneListing = listing({
      id: `INDEPENDENT-${label}-TIBETAN-PHONE`,
      block: PUBLIC_TIBETAN_PHONE,
      ownerType: source,
      houseSourceType: source,
      source: companyListing ? '公司房源' : '普通上传',
      companyListing,
      isCompanyListing: companyListing,
      noCommission: companyListing,
      landlordPhone: companyListing ? COMPANY_RAW_LISTING_PHONE : '13911112222'
    })
    const tibetanPhonePublic = domain.filterListings({ listings: [tibetanPhoneListing] }, { publicGuest: true })[0]
    assert.ok(tibetanPhonePublic, `独立${label}藏文数字私号样本必须进入公共投影`)
    const normalizedTibetanBlock = Array.from(String(tibetanPhonePublic.block || '')).map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint >= 0x0f20 && codePoint <= 0x0f29 ? String(codePoint - 0x0f20) : character
    }).join('').replace(/\D/g, '')
    assert.ok(!normalizedTibetanBlock.includes(PUBLIC_PRIVATE_PHONE_DIGITS), `${label}公开字段不得保留或转写藏文数字私号`)

    PUBLIC_UNIT_PHONE_SMUGGLES.forEach((privateValue, valueIndex) => {
      const unitPhoneListing = listing({
        id: `INDEPENDENT-${label}-UNIT-PHONE-${valueIndex + 1}`,
        block: privateValue,
        ownerType: source,
        houseSourceType: source,
        source: companyListing ? '公司房源' : '普通上传',
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing,
        reviewStatus: companyListing ? '无需审核' : '已通过',
        landlordPhone: companyListing ? COMPANY_RAW_LISTING_PHONE : '13911112222'
      })
      const unitPhonePublic = domain.filterListings({ listings: [unitPhoneListing] }, { publicGuest: true })[0]
      assert.ok(unitPhonePublic, `独立${label}业务单位私号样本必须进入公共投影：${privateValue}`)
      assert.notStrictEqual(unitPhonePublic.block, privateValue, `${label}公开字段不得逐值完整保留业务单位拼接私号：${privateValue}`)
      assert.ok(!String(unitPhonePublic.block || '').replace(/\D/g, '').includes(PUBLIC_PRIVATE_PHONE_DIGITS), `${label}公开字段清洗后不得仍可还原业务单位拼接私号：${privateValue}`)
    })
  })

  PUBLIC_WANYANG_ADDRESS_VARIANTS.forEach((block, index) => {
    const addressVariantListing = listing({
      id: `INDEPENDENT-WANYANG-ADDRESS-VARIANT-${index + 1}`,
      block,
      address: PUBLIC_WANYANG_ADDRESS,
      fullAddress: PUBLIC_WANYANG_ADDRESS,
      building: '1',
      unit: '1',
      roomNumber: '101'
    })
    const addressVariantPublic = domain.filterListings({ listings: [addressVariantListing] }, { publicGuest: true })[0]
    assert.ok(addressVariantPublic, `独立合作房源完整地址变体样本必须进入公共投影：${block}`)
    const normalizedAddressBlock = String(addressVariantPublic.block || '')
      .normalize('NFKC')
      .replace(/[\uE000-\uF8FF🫥·§Ж\s]/gu, '')
      .replace(/测试/g, '')
    assert.ok(!normalizedAddressBlock.includes(PUBLIC_WANYANG_ADDRESS), `合作房源 block 清洗后不得还原完整地址：${block}`)
    assert.ok(!(normalizedAddressBlock.includes('文一') && normalizedAddressBlock.includes('路万塘汇')), `合作房源 block 不得保留可拼接成精确地址的前后片段：${block}`)
  })

  ;[...PUBLIC_ENGLISH_ADDRESS_LABELS, ...PUBLIC_TRADITIONAL_ADDRESS_LABELS].forEach((preciseAddress, index) => {
    const preciseAddressListing = listing({
      id: `INDEPENDENT-PRECISE-ADDRESS-LABEL-${index + 1}`,
      block: preciseAddress,
      building: '2',
      unit: '3',
      roomNumber: '909',
      address: '杭州拱墅区游客模式测试小区2栋3单元909室'
    })
    const preciseAddressPublic = domain.filterListings({ listings: [preciseAddressListing] }, { publicGuest: true })[0]
    assert.ok(preciseAddressPublic, `精确地址标签样本必须进入公共投影：${preciseAddress}`)
    assert.strictEqual(preciseAddressPublic.block, '拱墅区', `A栋/B單元/Building A/Flat/Floor/Level/Tower/Block 等精确标签必须整字段回退：${preciseAddress}`)
  })

  ;[
    PUBLIC_NOISY_WECHAT_DECOY,
    ...PUBLIC_GENERIC_ALPHA_CONTACTS
  ].forEach((privateContact, contactIndex) => {
    ;[
      { label: '公司', source: '公司房源', companyListing: true },
      { label: '合作', source: '二房东房源', companyListing: false }
    ].forEach(({ label, source, companyListing }, sourceIndex) => {
      const contactListing = listing({
        id: `INDEPENDENT-${label}-ALPHA-CONTACT-${contactIndex + 1}-${sourceIndex + 1}`,
        block: `安全板块 ${privateContact}`,
        ownerType: source,
        houseSourceType: source,
        source: companyListing ? '公司房源' : '普通上传',
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing,
        landlordPhone: companyListing ? COMPANY_RAW_LISTING_PHONE : '13911112222'
      })
      const contactPublic = domain.filterListings({ listings: [contactListing] }, { publicGuest: true })[0]
      assert.ok(contactPublic, `${label}通用字母联系方式样本必须进入公共投影`)
      const contactText = String(contactPublic.block || '').toLowerCase()
      ;['realwx123', 'privateid', 'private_wx_01'].forEach((identifier) => {
        assert.ok(!contactText.includes(identifier), `${label}公开字段不得残留 decoy 或通用字母联系方式 ${identifier}：${privateContact}`)
      })
    })
  })

  ;[
    PUBLIC_FULLWIDTH_O_PHONE,
    ...PUBLIC_MIXED_CHINESE_PHONE_VARIANTS
  ].forEach((privatePhone, phoneIndex) => {
    ;[
      { label: '公司', source: '公司房源', companyListing: true },
      { label: '合作', source: '业主房源', companyListing: false }
    ].forEach(({ label, source, companyListing }, sourceIndex) => {
      const privatePhoneListing = listing({
        id: `INDEPENDENT-${label}-MIXED-PRIVATE-PHONE-${phoneIndex + 1}-${sourceIndex + 1}`,
        block: `安全板块 ${privatePhone}`,
        ownerType: source,
        houseSourceType: source,
        source: companyListing ? '公司房源' : source,
        companyListing,
        isCompanyListing: companyListing,
        noCommission: companyListing,
        reviewStatus: companyListing ? '无需审核' : '已通过',
        landlordPhone: companyListing ? COMPANY_RAW_LISTING_PHONE : '13911112222'
      })
      const privatePhonePublic = domain.filterListings({ listings: [privatePhoneListing] }, { publicGuest: true })[0]
      assert.ok(privatePhonePublic, `${label}混合中文/全角 O 私号样本必须进入公共投影`)
      const normalizedPhoneText = String(privatePhonePublic.block || '').normalize('NFKC').replace(/[OoＯ]/g, '0').replace(/\D/g, '')
      assert.ok(!normalizedPhoneText.includes(phoneIndex === 0 ? '18700001111' : '18800007777'), `${label}公开字段不得保留可归一还原的混合中文或全角 O 私号：${privatePhone}`)
      assert.ok(!String(privatePhonePublic.block || '').includes(privatePhone), `${label}公开字段不得原样泄露混合中文或全角 O 私号：${privatePhone}`)
    })
  })

  const companyPositiveListing = listing({
    id: 'INDEPENDENT-COMPANY-POSITIVE-NUMERIC-COPY',
    title: `公司公开文案 ${COMPANY_PLACEHOLDER_COLLISION}`,
    block: PUBLIC_VALID_DATE_COPY,
    address: `${COMPANY_ROAD_ADDRESS} 联系电话18800007777 ${COMPANY_PLACEHOLDER_COLLISION}`,
    fullAddress: `${COMPANY_ROAD_ADDRESS} 联系电话18800007777 ${COMPANY_PLACEHOLDER_COLLISION}`,
    viewingMethod: '密码',
    viewingPassword: COMPANY_EIGHT_DIGIT_DOOR_PASSWORD,
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    landlordPhone: COMPANY_RAW_LISTING_PHONE
  })
  const companyPositiveDb = { listings: [companyPositiveListing], users: [] }
  const companyPositiveCard = domain.filterListings(companyPositiveDb, { publicGuest: true })[0]
  const companyPositiveDetail = domain.listingDetail(companyPositiveDb, companyPositiveListing.id)
  assert.strictEqual(companyPositiveCard.block, PUBLIC_VALID_DATE_COPY, '合法日期与 ISO 时间必须原样保留，不能被电话号码清洗误删')
  assert.ok(String(companyPositiveDetail.address || '').includes(COMPANY_ROAD_ADDRESS), '缺少单元房号的合法道路门牌必须原样保留')
  assert.ok(!String(companyPositiveDetail.address || '').includes('18800007777'), '合法道路门牌同字段中的私号仍必须删除')
  assert.strictEqual(companyPositiveDetail.viewingPassword, COMPANY_EIGHT_DIGIT_DOOR_PASSWORD, '公司 8 位门锁密码必须按原规则公开保留')
  assert.ok(JSON.stringify(companyPositiveDetail).includes(COMPANY_PLACEHOLDER_COLLISION), '用户原文等于配置号码保护哨兵字面量时必须原样保留')

  const structuralPhoneListing = listing({
    id: 'INDEPENDENT-COMPANY-STRUCTURAL-PHONE',
    block: '安全板块 18800007777栋1单元101室',
    ownerType: '公司房源',
    houseSourceType: '公司房源',
    source: '公司房源',
    companyListing: true,
    isCompanyListing: true,
    noCommission: true,
    landlordPhone: COMPANY_RAW_LISTING_PHONE
  })
  const structuralPhonePublic = domain.filterListings({ listings: [structuralPhoneListing] }, { publicGuest: true })[0]
  assert.ok(!String(structuralPhonePublic.block || '').replace(/\D/g, '').includes('18800007777'), '楼栋/单元/房号结构不得把 11 位私号误当合法地址而白洗')

  const englishSuiteListing = listing({
    id: 'INDEPENDENT-ENGLISH-EXACT-SUITE',
    block: PUBLIC_ENGLISH_SUITE,
    address: PUBLIC_ENGLISH_SUITE,
    fullAddress: PUBLIC_ENGLISH_SUITE,
    building: '1',
    unit: '1',
    roomNumber: '888'
  })
  const englishSuitePublic = domain.filterListings({ listings: [englishSuiteListing] }, { publicGuest: true })[0]
  assert.ok(englishSuitePublic, '独立合作房源英文精确房号样本必须进入公共投影')
  assert.ok(!JSON.stringify(englishSuitePublic).toLowerCase().includes(PUBLIC_ENGLISH_SUITE.toLowerCase()), '合作房源公共投影不得泄露英文精确房号 Suite 888')

  ;[
    '杭州拱墅区文一西路969号3栋2单元701室',
    '文一西路969号',
    '浙江省杭州市拱墅区东新路88号'
  ].forEach((fullAddress, index) => {
    const exactAddressListing = listing({
      id: `EXACT-ADDRESS-PREFIX-${index + 1}`,
      block: fullAddress,
      address: fullAddress,
      fullAddress,
      building: '3',
      unit: '2',
      roomNumber: '701'
    })
    const exactAddressPublic = domain.filterListings({ listings: [exactAddressListing] }, { publicGuest: true })[0]
    assert.strictEqual(exactAddressPublic.block, '拱墅区', `已知完整地址必须整体移除并回退公开区域，不得残留道路前缀：${fullAddress}`)
  })
  const independentSensitiveCopyListing = listing({
    id: 'INDEPENDENT-MULTILINGUAL-SENSITIVE-COPY',
    building: '1',
    unit: '1',
    roomNumber: '101',
    block: [
      '安全板块',
      PUBLIC_FINANCIAL_WORD_ADDRESS,
      PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS,
      ...PUBLIC_ENGLISH_ADDRESS_LABELS,
      ...PUBLIC_CHINESE_ADDRESS_LABELS,
      ...PUBLIC_TRADITIONAL_ADDRESS_LABELS,
      ...PUBLIC_ENGLISH_LOCAL_PHONES,
      ...PUBLIC_TRADITIONAL_LOCAL_PHONES,
      ...PUBLIC_NOISY_WECHAT_IDS,
      PUBLIC_SAFE_ENGLISH_NUMERIC_COPY
    ].join(' ')
  })
  const independentSensitiveCopyPublic = domain.filterListings({ listings: [independentSensitiveCopyListing] }, { publicGuest: true })[0]
  const independentSensitiveCopyText = JSON.stringify(independentSensitiveCopyPublic)
  ;[
    PUBLIC_FINANCIAL_WORD_ADDRESS,
    PUBLIC_EMOJI_FINANCIAL_WORD_ADDRESS,
    ...PUBLIC_ENGLISH_ADDRESS_LABELS,
    ...PUBLIC_CHINESE_ADDRESS_LABELS,
    ...PUBLIC_TRADITIONAL_ADDRESS_LABELS,
    ...PUBLIC_ENGLISH_LOCAL_PHONES,
    ...PUBLIC_TRADITIONAL_LOCAL_PHONES,
    ...PUBLIC_NOISY_WECHAT_IDS
  ].forEach((privateValue) => {
    assert.ok(!independentSensitiveCopyText.includes(privateValue), `独立字段不得泄露多语言电话或精确地址 ${privateValue}`)
  })
  const normalizedSafeEnglishBlock = String(independentSensitiveCopyPublic.block || '').replace(/[·\s]+/g, ' ').trim()
  assert.ok(normalizedSafeEnglishBlock.includes('2 rooms unit price follows'), `合法英文数字业务文案不得被多语言地址清洗误删，实际：${independentSensitiveCopyPublic.block || ''}`)
  const knownCommunityAlias = listing({
    id: 'KNOWN-COMMUNITY-ALIAS',
    community: '京漾东韵府',
    address: '京漾东韵府',
    fullAddress: '京漾东韵府'
  })
  const knownCommunityPublic = domain.filterListings({ listings: [knownCommunityAlias] }, { publicGuest: true })[0]
  assert.strictEqual(knownCommunityPublic.community, '京漾东韵府', '服务端小区库精确命中的存量 address===community 必须继续公开小区名')

  seedDb()
  writeSyntheticOssPreload()
  const server = spawn(process.execPath, ['-r', mediaPreloadFile, 'src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      V1_DISABLE_LEGACY_ROUTES: '1',
      TRUST_PROXY: '1',
      AUTH_TOKEN_SECRET: 'guest-mode-test-secret',
      COMPANY_CONTACT_PHONES: '19900000001,19900000002,19900000003',
      MINI_REQUEST_DOMAIN: baseUrl,
      ALI_OSS_BUCKET: 'synthetic-bucket',
      ALI_OSS_REGION: 'oss-cn-example',
      ALI_OSS_ACCESS_KEY_ID: 'synthetic-access-key-id',
      ALI_OSS_ACCESS_KEY_SECRET: 'synthetic-access-key-secret',
      ALI_OSS_PUBLIC_BASE_URL: 'https://synthetic-bucket.oss-cn-example.aliyuncs.com'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  server.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })

  try {
    assert.ok(await waitForServer(), `游客模式测试服务未启动：${output}`)

    const guestListings = await request('GET', '/mini/listings')
    assert.strictEqual(guestListings.statusCode, 200, '匿名列表接口应返回 200')
    assert.ok(String(guestListings.headers['cache-control'] || '').includes('no-store'), '含媒体能力地址的匿名列表不得被共享缓存')
    assertAllPublicSources(dataOf(guestListings), '匿名列表')

    const guestCompanyListings = await request('GET', '/mini/listings?category=%E5%85%AC%E5%8F%B8%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(dataOf(guestCompanyListings).map((item) => item.id), ['GUEST_COMPANY'], '游客选择公司房源应只返回公司房源')
    const guestOwnerListings = await request('GET', '/mini/listings?category=%E4%B8%9A%E4%B8%BB%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(dataOf(guestOwnerListings).map((item) => item.id), ['GUEST_OWNER'], '游客选择业主房源应只返回业主房源')
    assertPublicPartnerRow(dataOf(guestOwnerListings)[0], '匿名业主筛选')
    const guestSecondLandlordListings = await request('GET', '/mini/listings?category=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(dataOf(guestSecondLandlordListings).map((item) => item.id), ['GUEST_PARTNER'], '游客选择二房东房源应只返回二房东房源')
    assertPublicPartnerRow(dataOf(guestSecondLandlordListings)[0], '匿名二房东筛选')

    const secretBlockProbe = await request('GET', `/mini/listings?block=${encodeURIComponent(PUBLIC_FIELD_SECRET_PHONE)}`)
    assert.deepStrictEqual(dataOf(secretBlockProbe), [], '公开列表不得用夹带手机号作为 block 搜索 oracle')
    const secretLayoutProbe = await request('GET', `/mini/listings?layout=${encodeURIComponent(PUBLIC_FIELD_SECRET_ADDRESS)}`)
    assert.deepStrictEqual(dataOf(secretLayoutProbe), [], '公开列表不得用楼栋单元房号作为户型搜索 oracle')
    const labeledRoomProbe = await request('GET', '/mini/listings?block=702')
    assert.deepStrictEqual(dataOf(labeledRoomProbe), [], '公开列表不得用显式房号标签探测合作房源命中')
    const standaloneRoomProbe = await request('GET', '/mini/listings?block=701')
    assert.deepStrictEqual(dataOf(standaloneRoomProbe), [], '公开列表不得用空格分隔的裸房号探测合作房源命中')
    const singleBuildingProbe = await request('GET', '/mini/listings?block=9')
    assert.deepStrictEqual(dataOf(singleBuildingProbe), [], '公开列表不得用单字符楼栋号探测合作房源命中')
    const singleUnitProbe = await request('GET', '/mini/listings?layout=8')
    assert.deepStrictEqual(dataOf(singleUnitProbe), [], '公开列表不得用单字符单元号探测合作房源命中')
    const companyPhoneProbe = await request('GET', `/mini/listings?block=${encodeURIComponent(COMPANY_PRIVATE_MOBILE)}`)
    assert.deepStrictEqual(dataOf(companyPhoneProbe), [], '公开列表不得用公司自由字段夹带私号作为搜索 oracle')
    const companyLandlineProbe = await request('GET', `/mini/listings?layout=${encodeURIComponent(COMPANY_PRIVATE_LANDLINE)}`)
    assert.deepStrictEqual(dataOf(companyLandlineProbe), [], '公开列表不得用公司户型夹带座机作为搜索 oracle')
    const secretMapProbe = await request('GET', `/mini/map/pins?area=${encodeURIComponent(PUBLIC_FIELD_SECRET_PHONE)}`)
    assert.deepStrictEqual(dataOf(secretMapProbe), [], '公开地图不得用夹带手机号探测合作房源命中')
    const secretMapSourceProbe = await request('GET', `/mini/map/pins?sourceType=${encodeURIComponent(PUBLIC_FIELD_SECRET_PHONE)}`)
    assert.deepStrictEqual(dataOf(secretMapSourceProbe), [], '公开地图不得用未知原始来源字段探测合作房源命中')
    const publicPartnerCard = dataOf(guestListings).find((item) => item.id === 'GUEST_PARTNER')
    assert.ok(String(publicPartnerCard.block || '').includes('测试板块'), `清除夹带敏感值时必须保留合法板块，实际：${publicPartnerCard.block || ''}`)
    assert.ok(!JSON.stringify(publicPartnerCard).includes('PRIVATE-EXACT'), '已知完整地址被清除后不得残留可拼接的合成地址前缀')
    assert.ok(String(publicPartnerCard.layout || '').includes('整租两室一厅'), '清除夹带敏感值时必须保留合法户型')
    assert.ok(!/(?:^|\s)9\s+8(?:\s|$)/.test(String(publicPartnerCard.block || '')), '公开板块不得夹带空格分隔的楼栋和单元')
    assert.ok(!/(?:^|\s)9\s+8(?:\s|$)/.test(String(publicPartnerCard.layout || '')), '公开户型不得夹带空格分隔的楼栋和单元')
    assert.ok(!/(?:^|\s)9(?:\s|$)/.test(String(publicPartnerCard.block || '')), '公开板块不得残留单独夹带的一位数楼栋')
    assert.ok(!/(?:^|\s)8(?:\s|$)/.test(String(publicPartnerCard.layout || '')), '公开户型不得残留单独夹带的一位数单元')
    assert.strictEqual(publicPartnerCard.community, '游客合作小区', '备注与小区同值时不得误删合法公开小区')
    assert.ok(String(publicPartnerCard.block || '').includes(PUBLIC_SEMANTIC_DIGITS), `地铁/步行/公交数字语义不得被误当结构化地址清除，实际：${publicPartnerCard.block || ''}`)
    assert.ok(String(publicPartnerCard.block || '').includes(PUBLIC_PHONE_SHAPED_SEMANTICS), '公共语义数字即使拼出手机号形状也不得被误清洗')
    assert.strictEqual(publicPartnerCard.status, '在租', '合作房源公开状态只能来自服务端枚举，不能夹带脏历史值')
    assert.strictEqual(publicPartnerCard.rent, 0, '畸形存量租金不得进入公开 DTO')
    assert.strictEqual(publicPartnerCard.price, '', '畸形存量租金不得拼入公开价格文案')
    ;['GUEST_DIRTY_RENTED', 'GUEST_DIRTY_WITHDRAWN', 'GUEST_DIRTY_PAUSED'].forEach((inactiveId) => {
      assert.ok(!dataOf(guestListings).some((item) => item.id === inactiveId), `脏历史房态 ${inactiveId} 必须 fail-closed 退出公开池`)
    })
    const publicOwnerCard = dataOf(guestListings).find((item) => item.id === 'GUEST_OWNER')
    assert.strictEqual(publicOwnerCard.block, '17号板块', '数字楼栋与公开板块重叠时不得误删合法板块数字')
    assert.strictEqual(publicOwnerCard.community, '101国际城', '数字房号与公开小区重叠时不得误删合法小区数字')
    assert.strictEqual(publicOwnerCard.layout, '17㎡三室一厅 17m²三室 17m2三室 17平方米三室', '数字楼栋与面积单位重叠时不得误删合法户型面积和三室户型')
    assert.ok(JSON.stringify(publicOwnerCard).includes('三室'), '合法户型“三室”不得被当成混淆房号删除')
    const secretAreaMatch = await request('POST', '/mini/listings/match', { area: PUBLIC_FIELD_SECRET_PHONE })
    assert.deepStrictEqual(dataOf(secretAreaMatch).listings, [], '公开匹配不得按夹带手机号给合作房源加分')
    const secretLayoutMatch = await request('POST', '/mini/listings/match', { layout: PUBLIC_FIELD_SECRET_ADDRESS })
    assert.deepStrictEqual(dataOf(secretLayoutMatch).listings, [], '公开匹配不得按精确楼栋房号给合作房源加分')

    const guestHome = await request('GET', '/mini/home/listings')
    assert.strictEqual(guestHome.statusCode, 200, '匿名首页房源接口应返回 200')
    assertAllPublicSources(dataOf(guestHome), '匿名首页房源')

    const publicCommission = await request('GET', '/mini/commission-config')
    assert.strictEqual(publicCommission.statusCode, 200, '游客仍可读取公开分佣比例')
    assert.strictEqual(dataOf(publicCommission).ownerRate, 22, '公开比例必须保留业务配置')
    assert.ok(!Object.prototype.hasOwnProperty.call(dataOf(publicCommission), 'updatedBy'), '游客公开配置不得泄露后台操作人')
    assert.ok(!Object.prototype.hasOwnProperty.call(dataOf(publicCommission), 'updatedAt'), '游客公开配置不得泄露后台审计时间')
    for (let index = 1; index < 30; index += 1) {
      const allowed = await request('GET', '/mini/commission-config')
      assert.strictEqual(allowed.statusCode, 200, `游客公开配置限流窗口内第 ${index + 1} 次仍应允许`)
    }
    const limitedCommission = await request('GET', '/mini/commission-config')
    assert.strictEqual(limitedCommission.statusCode, 429, '游客公开配置第 31 次必须限流，不能成为无界探测接口')

    const sheetSnapshot = await request('GET', '/mini/company-sheet-snapshot')
    assert.strictEqual(sheetSnapshot.statusCode, 200, '匿名飞书快照接口应返回 200')
    const sheetText = JSON.stringify(dataOf(sheetSnapshot))
    const compactSheetText = sheetText.replace(/[+\s\-]/g, '')
    assert.ok(sheetText.includes('1-1-101'), '匿名飞书快照应返回公司房号')
    assert.ok(sheetText.includes('246810#'), '匿名飞书快照应返回看房密码')
    ;['19800007777', '8619800009999', '13900001111', '057112345678'].forEach((privatePhone) => {
      assert.ok(!compactSheetText.includes(privatePhone), `匿名飞书快照不得返回简介或数据行原始私号 ${privatePhone}`)
    })
    ;['private_wx_01', 'raw_wechat_02'].forEach((privateWechat) => {
      assert.ok(!sheetText.includes(privateWechat), `匿名飞书快照不得返回原始微信号 ${privateWechat}`)
    })
    ;['19900000001', '19900000002', '19900000003'].forEach((phone) => {
      assert.ok(sheetText.includes(phone), `匿名飞书快照只应返回服务器统一号码 ${phone}`)
    })
    ;['sheetUrl', 'range', 'cachedAt', 'startRow', 'startCol', 'PRIVATE_SHEET_TOKEN'].forEach((privateMetadata) => {
      assert.ok(!sheetText.includes(privateMetadata), `匿名飞书快照不得返回内部飞书定位元数据 ${privateMetadata}`)
    })

    const guestPins = await request('GET', '/mini/map/pins')
    assert.strictEqual(guestPins.statusCode, 200, '匿名地图接口应返回 200')
    const pins = dataOf(guestPins)
    const pinText = JSON.stringify(pins)
    assert.ok(pinText.includes('GUEST_COMPANY'), '匿名地图必须纳入无视频公司房源点位')
    const companyPin = pins.find((item) => (item.activeListingIds || []).indexOf('GUEST_COMPANY') !== -1)
    assert.ok(companyPin && companyPin.listings && companyPin.listings[0] && companyPin.listings[0].hasVideo === false, '匿名地图无视频公司房源不能显示视频标签')
    assertNoCompanyPrivateContact(companyPin, '匿名地图公司房源')
    assert.ok(pinText.includes('GUEST_PARTNER'), '匿名地图必须包含二房东房源点位')
    assert.ok(pinText.includes('GUEST_OWNER'), '匿名地图必须包含业主房源点位')
    PARTNER_SENSITIVE_VALUES.forEach((value) => assert.ok(!pinText.includes(value), `匿名地图不得包含敏感值 ${value}`))
    const partnerPin = pins.find((item) => (item.activeListingIds || []).includes('GUEST_PARTNER'))
    const ownerPin = pins.find((item) => (item.activeListingIds || []).includes('GUEST_OWNER'))
    assert.ok(partnerPin && partnerPin.latitude !== 30.361234 && partnerPin.longitude !== 120.171234, '匿名地图不得返回二房东逐套精确坐标')
    assert.ok(ownerPin && ownerPin.latitude !== 30.371234 && ownerPin.longitude !== 120.181234, '匿名地图不得返回业主逐套精确坐标')
    ;[partnerPin, ownerPin].forEach((pin) => {
      assert.strictEqual(pin.coordinateVerified, false, '合作房源地图点必须明确标记为非精确坐标')
      assert.strictEqual(pin.coordinateLevel, 'approximate', '合作房源地图点必须使用小区近似级别')
      assert.strictEqual(pin.coordinateAccuracy, 'approximate', '合作房源地图坐标准确度不得伪装为已核验')
      assert.ok(!/admin-verified-coordinate/.test(String(pin.coordinateSource || '')), '合作房源地图不得下发逐套核验坐标来源')
    })

    const guestCompanyPins = await request('GET', '/mini/map/pins?sourceType=%E5%85%AC%E5%8F%B8%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(listingIdsFromPins(dataOf(guestCompanyPins)), ['GUEST_COMPANY'], '游客地图选择公司房源应只返回公司点位')
    const guestCompanyPin = dataOf(guestCompanyPins)[0]
    assert.strictEqual(guestCompanyPin.coordinateSource, 'admin-verified-coordinate', '公司公开坐标来源必须映射到服务端固定枚举')
    assert.strictEqual(guestCompanyPin.coordinateStatus, '已确认小区坐标', '公司公开坐标状态必须由可信级别固定生成')
    assert.strictEqual(guestCompanyPin.coordinateLabel, '已确认小区坐标', '公司公开坐标标签不得使用存量原始文案')
    assert.ok(!JSON.stringify(guestCompanyPin).includes('privateid') && !JSON.stringify(guestCompanyPin).includes(PUBLIC_FIELD_SECRET_PHONE), '公司地图坐标元数据不得夹带联系方式')
    const guestOwnerPins = await request('GET', '/mini/map/pins?sourceType=%E4%B8%9A%E4%B8%BB%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(listingIdsFromPins(dataOf(guestOwnerPins)), ['GUEST_OWNER'], '游客地图选择业主房源应只返回业主点位')
    const guestSecondLandlordPins = await request('GET', '/mini/map/pins?sourceType=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90')
    assert.deepStrictEqual(listingIdsFromPins(dataOf(guestSecondLandlordPins)), ['GUEST_PARTNER'], '游客地图选择二房东房源应只返回二房东点位')

    const companyDetail = await request('GET', '/mini/listings/GUEST_COMPANY')
    assert.strictEqual(companyDetail.statusCode, 200, '匿名公司房源详情应返回 200')
    assert.strictEqual(dataOf(companyDetail).companyListing, true, '匿名详情只能打开公司房源')
    assert.ok(String(dataOf(companyDetail).address || '').includes('19900000001'), '公司精确房号与服务器统一号码相邻时仍须保留完整统一号码')
    assert.ok(!String(dataOf(companyDetail).address || '').includes('18700001111') && !String(dataOf(companyDetail).address || '').includes('18600002222'), '公司统一号码前后的两个私号必须同时删除')
    assert.ok(String(dataOf(companyDetail).address || '').includes(COMPANY_PLACEHOLDER_COLLISION), '公司原始文案碰巧等于内部占位符时不得被改写成统一号码')
    assert.ok(!/YNZYALLOWED|[\uE000-\uF8FF]/u.test(JSON.stringify(dataOf(companyDetail))), '公司公开详情不得残留内部号码保护哨兵或私用区字符')
    assert.deepStrictEqual(
      dataOf(companyDetail).companyContactPhones,
      ['19900000001', '19900000002', '19900000003'],
      '匿名公司房源详情也必须保留三个服务端统一号码'
    )
    assert.strictEqual(dataOf(companyDetail).companyContactPhoneText, '19900000001', '匿名旧客户端兼容字段只使用首号')
    assert.ok(JSON.stringify(dataOf(companyDetail)).includes('246810#'), '匿名公司房源详情应返回公司看房密码')
    assertNoCompanyPrivateContact(dataOf(companyDetail), '匿名公司房源详情')

    const partnerDetail = await request('GET', '/mini/listings/GUEST_PARTNER')
    assert.strictEqual(partnerDetail.statusCode, 200, '匿名请求合作房源详情必须返回脱敏详情')
    assert.ok(String(partnerDetail.headers['cache-control'] || '').includes('no-store'), '含媒体能力地址的匿名详情不得被共享缓存')
    assert.ok(String(dataOf(partnerDetail).videoUrl || '').startsWith(`${baseUrl}/mini/listings/GUEST_PARTNER/media/video?token=`), '匿名合作房源详情必须保留 API 域不透明视频播放地址')
    assert.ok(String(dataOf(partnerDetail).coverUrl || '').startsWith(`${baseUrl}/mini/listings/GUEST_PARTNER/media/cover?token=`), '匿名合作房源详情封面不得暴露 OSS 对象键')
    assert.ok(!JSON.stringify(dataOf(partnerDetail)).includes(PUBLIC_MEDIA_SECRET_KEY), '匿名合作房源详情不得泄露历史视频对象键')
    assertPublicPartnerRow(dataOf(partnerDetail), '匿名合作房源详情')
    assertGuestInternalFieldsAbsent(dataOf(partnerDetail), '匿名合作房源详情')
    assert.ok(dataOf(partnerDetail).nearby && dataOf(partnerDetail).nearby.listings.some((item) => item.id === 'GUEST_COMPANY'), '匿名合作房源详情必须可读取附近公开房源')
    assertNoCompanyPrivateContact(dataOf(partnerDetail).nearby.listings.find((item) => item.id === 'GUEST_COMPANY'), '匿名附近公司房源')
    dataOf(partnerDetail).nearby.listings.filter((item) => !item.companyListing).forEach((item) => {
      assertPublicPartnerRow(item, `匿名附近推荐/${item.id}`)
    })

    const ownerDetail = await request('GET', '/mini/listings/GUEST_OWNER')
    assert.strictEqual(ownerDetail.statusCode, 200, '匿名请求业主房源详情必须返回脱敏详情')
    assertPublicPartnerRow(dataOf(ownerDetail), '匿名业主房源详情')
    assertGuestInternalFieldsAbsent(dataOf(ownerDetail), '匿名业主房源详情')

    const guestMyListings = await request('GET', '/mini/my/listings')
    assert.strictEqual(guestMyListings.statusCode, 401, '游客不得读取本人房源列表')
    const guestMyVerify = await request('POST', '/mini/my/listings/GUEST_PARTNER/verify', { outcome: '未出租' })
    assert.strictEqual(guestMyVerify.statusCode, 401, '游客不得调用本人房态核验接口')

    const sensitive = await request('POST', '/mini/listings/GUEST_COMPANY/sensitive-view', {
      needId: 'N1',
      purpose: '游客越权测试'
    })
    assert.strictEqual(sensitive.statusCode, 401, '匿名不可调用敏感查看')
    const favorite = await request('PUT', '/mini/favorites/GUEST_PARTNER')
    assert.strictEqual(favorite.statusCode, 401, '匿名不可收藏，收藏仍绑定服务端账号')
    const phoneCall = await request('POST', '/mini/listings/GUEST_PARTNER/phone-call-opened', { idempotencyKey: 'CALL-GUEST-001' })
    assert.strictEqual(phoneCall.statusCode, 401, '匿名不可写拨号足迹')
    const showing = await request('POST', '/mini/listings/GUEST_PARTNER/showings', {})
    assert.strictEqual(showing.statusCode, 401, '匿名不可写带看记录')
    const videoShare = await request('POST', '/mini/listings/GUEST_PARTNER/video-share', { channel: 'wechat-video' })
    assert.strictEqual(videoShare.statusCode, 401, '匿名视频发送不得伪造用户或写受保护留痕')

    const guestMatch = await request('POST', '/mini/listings/match', {
      area: '游客',
      layout: '两室',
      budget: 3000
    })
    assert.strictEqual(guestMatch.statusCode, 200, '匿名匹配接口应返回 200')
    assertAllPublicSources(dataOf(guestMatch).listings, '匿名匹配')
    const companySecretMatch = await request('POST', '/mini/listings/match', { area: COMPANY_PRIVATE_MOBILE })
    assert.deepStrictEqual(dataOf(companySecretMatch).listings, [], '公开匹配不得按公司自由字段夹带私号加分')

    const guestLlmMatch = await request('POST', '/mini/llm/match', {
      text: '找拱墅区3000以内房源',
      form: { area: '拱墅区', budget: 3000 }
    })
    assert.strictEqual(guestLlmMatch.statusCode, 200, '匿名 LLM 匹配接口应返回 200')
    assert.ok(JSON.stringify(dataOf(guestLlmMatch)).includes('GUEST_PARTNER'), '匿名 LLM 匹配必须可包含二房东房源')
    assert.ok(JSON.stringify(dataOf(guestLlmMatch)).includes('GUEST_OWNER'), '匿名 LLM 匹配必须可包含业主房源')
    PARTNER_SENSITIVE_VALUES.forEach((value) => assert.ok(!JSON.stringify(dataOf(guestLlmMatch)).includes(value), `匿名 LLM 匹配不得包含敏感值 ${value}`))
    assertNoCompanyPrivateContact(dataOf(guestLlmMatch), '匿名 LLM 匹配')

    const assistant = await request('POST', '/mini/assistant/chat', {
      text: '找拱墅区3000以内房源',
      form: { area: '拱墅区', budget: 3000 }
    })
    assert.strictEqual(assistant.statusCode, 200, '匿名找房助手应返回 200')
    assert.ok(JSON.stringify(dataOf(assistant)).includes('GUEST_PARTNER'), '匿名找房助手候选必须可包含二房东房源')
    assert.ok(JSON.stringify(dataOf(assistant)).includes('GUEST_OWNER'), '匿名找房助手候选必须可包含业主房源')
    PARTNER_SENSITIVE_VALUES.forEach((value) => assert.ok(!JSON.stringify(dataOf(assistant)).includes(value), `匿名找房助手不得包含敏感值 ${value}`))
    assert.strictEqual(dataOf(assistant).feedbackMessageId || '', '', '匿名找房助手不得返回服务端反馈结果 ID')

    const profile = await request('GET', '/mini/profile')
    assert.strictEqual(profile.statusCode, 401, '匿名访问我的必须返回 401')

    const invalidBearer = await request('GET', '/mini/listings/GUEST_PARTNER', null, { Authorization: 'Bearer invalid-guest-token' })
    assert.strictEqual(invalidBearer.statusCode, 401, '无效 Bearer 令牌必须失败，不能静默降级为游客')
    const emptyBearer = await request('GET', '/mini/listings/GUEST_PARTNER', null, { Authorization: 'Bearer ' })
    assert.strictEqual(emptyBearer.statusCode, 401, '空 Bearer 令牌必须失败，不能静默降级为游客')
    const wrongScheme = await request('GET', '/mini/listings/GUEST_PARTNER', null, { Authorization: 'Basic synthetic-invalid-credential' })
    assert.strictEqual(wrongScheme.statusCode, 401, '非 Bearer Authorization 必须失败，不能静默降级为游客')
    const malformedMediaAuth = await request('GET', '/mini/listings/GUEST_PARTNER/media/video?token=invalid-capability', null, {
      Authorization: 'Basic synthetic-invalid-credential'
    })
    assert.strictEqual(malformedMediaAuth.statusCode, 401, '媒体流路由也必须先拒绝畸形 Authorization，不能进入能力令牌或上游读取')

    const invalidLogin = await request('POST', '/mini/auth/login', { phone: '13900000001', password: BROKER_PASSWORD }, {
      Authorization: 'Basic synthetic-invalid-credential'
    })
    assert.strictEqual(invalidLogin.statusCode, 401, '登录接口携带畸形 Authorization 必须拒绝，不能绕过统一鉴权头门')
    const invalidRegistration = await request('POST', '/mini/auth/register', {
      name: '畸形头注册用户',
      phone: '13900000999',
      password: 'synthetic-register-pass'
    }, { Authorization: 'Bearer invalid-register-token' })
    assert.strictEqual(invalidRegistration.statusCode, 401, '注册接口携带无效 Bearer 必须拒绝')
    assert.ok(!JSON.parse(fs.readFileSync(dataFile, 'utf8')).users.some((item) => item.phone === '13900000999'), '被拒注册不得写入用户')

    const login = await request('POST', '/mini/auth/login', { phone: '13900000001', password: BROKER_PASSWORD })
    assert.strictEqual(login.statusCode, 200, '登录应返回 200')
    assert.ok(dataOf(login).token, '登录必须返回小程序 token')
    const authHeaders = { Authorization: `Bearer ${dataOf(login).token}` }
    const ownedBeforeVerify = await request('GET', '/mini/my/listings', null, authHeaders)
    assert.strictEqual(ownedBeforeVerify.statusCode, 200, '本人必须可读取自己的待审核房源')
    const pendingOwnedBeforeVerify = dataOf(ownedBeforeVerify).find((item) => item.id === 'GUEST_PENDING_OWNER')
    assert.ok(pendingOwnedBeforeVerify, '本人房源列表必须包含自己的待审核房源')
    assert.strictEqual(pendingOwnedBeforeVerify.hasVideo, true, '待审核自有房源不得被公共媒体包装误判为无视频')
    assert.ok(String(pendingOwnedBeforeVerify.coverUrl || '').startsWith(`${baseUrl}/mini/listings/GUEST_PENDING_OWNER/media/cover?token=`), '待审核自有房源必须返回非空受控封面 URL')
    assert.strictEqual(new URL(pendingOwnedBeforeVerify.coverUrl).searchParams.get('scope'), 'owner', '待审核自有房源必须使用 owner-scoped 媒体能力 URL')
    assert.ok(!JSON.stringify(pendingOwnedBeforeVerify).includes('pending-owner-review.mp4'), '本人房源卡片也不得泄露视频对象键')
    const pendingOwnerCoverUrl = pendingOwnedBeforeVerify.coverUrl
    const ownerPendingCover = await requestBuffer('GET', pendingOwnerCoverUrl, authHeaders)
    assert.strictEqual(ownerPendingCover.statusCode, 200, '本人拿到的待审核房源受控封面必须实际可读，不能只是非空 URL')
    assert.ok(/^image\//.test(String(ownerPendingCover.headers['content-type'] || '')), '待审核房源封面必须返回图片 Content-Type')
    assert.ok(ownerPendingCover.body.length > 4 && ownerPendingCover.body[0] === 0xff && ownerPendingCover.body[1] === 0xd8, '待审核房源封面必须返回有效 JPEG 内容')
    const anonymousPendingCover = await requestBuffer('GET', pendingOwnerCoverUrl)
    assert.strictEqual(anonymousPendingCover.statusCode, 200, '微信 image/video 无法附带 Authorization，owner 已签发的短时 bearer URL 必须可匿名加载')
    assert.ok(anonymousPendingCover.body.length > 4 && anonymousPendingCover.body[0] === 0xff && anonymousPendingCover.body[1] === 0xd8, '匿名加载 owner bearer URL 仍必须返回有效 JPEG 内容')

    const ownedAfterVerify = await request('POST', '/mini/my/listings/GUEST_PARTNER/verify', { outcome: '未出租' }, authHeaders)
    assert.strictEqual(ownedAfterVerify.statusCode, 200, '本人核验有效合作房源后必须返回更新后的本人列表')
    const pendingOwnedAfterVerify = dataOf(ownedAfterVerify).find((item) => item.id === 'GUEST_PENDING_OWNER')
    assert.ok(pendingOwnedAfterVerify, '核验返回列表不得丢失同账号待审核房源')
    assert.strictEqual(pendingOwnedAfterVerify.hasVideo, true, '核验返回列表也必须保留待审核自有房源视频标记')
    assert.ok(String(pendingOwnedAfterVerify.coverUrl || '').startsWith(`${baseUrl}/mini/listings/GUEST_PENDING_OWNER/media/cover?token=`), '核验返回列表也必须保留待审核自有房源受控封面')
    const ownerPendingCoverAfterVerify = await requestBuffer('GET', pendingOwnedAfterVerify.coverUrl, authHeaders)
    assert.strictEqual(ownerPendingCoverAfterVerify.statusCode, 200, '核验返回的待审核封面 URL 必须仍可由本人实际读取')
    assert.ok(/^image\//.test(String(ownerPendingCoverAfterVerify.headers['content-type'] || '')) && ownerPendingCoverAfterVerify.body[0] === 0xff && ownerPendingCoverAfterVerify.body[1] === 0xd8, '核验后本人仍须得到有效 JPEG 封面')
    const loggedSheetSnapshot = await request('GET', '/mini/company-sheet-snapshot', null, {
      Authorization: `Bearer ${dataOf(login).token}`
    })
    assert.strictEqual(loggedSheetSnapshot.statusCode, 200, '登录飞书快照接口应返回 200')
    assert.deepStrictEqual(dataOf(sheetSnapshot).rows, dataOf(loggedSheetSnapshot).rows, '匿名与登录快照列和数据必须一致')
    assert.ok(JSON.stringify(dataOf(loggedSheetSnapshot)).includes('看房方式密码'), '登录快照应包含看房方式密码列')
    const loggedPartnerDetail = await request('GET', '/mini/listings/GUEST_PARTNER', null, {
      Authorization: `Bearer ${dataOf(login).token}`
    })
    assert.strictEqual(loggedPartnerDetail.statusCode, 200, '登录后可查看合作房源脱敏详情')
    assertPublicPartnerRow(dataOf(loggedPartnerDetail), '登录未确认的合作房源详情')
    assertAuthenticatedPartnerDisplay(dataOf(loggedPartnerDetail), '登录未确认的合作房源详情', { detail: true })
    assert.strictEqual(dataOf(loggedPartnerDetail).status, '在租', '登录未确认详情也不得下发脏历史状态')
    assert.strictEqual(dataOf(loggedPartnerDetail).rent, '0', '登录未确认详情也不得下发畸形租金原文')
    const inactivePartnerDetail = await request('GET', '/mini/listings/GUEST_DIRTY_RENTED', null, {
      Authorization: `Bearer ${dataOf(login).token}`
    })
    const inactivePartnerData = dataOf(inactivePartnerDetail)
    assert.strictEqual(inactivePartnerData.updatedAt, '', '夹带私号的不可用详情时间必须丢弃，不能当普通字符串下发')
    assert.strictEqual(inactivePartnerData.syncedAt, '2026-07-14T10:20:30.000Z', '合法 ISO 同步时间必须保留')
    assert.strictEqual(inactivePartnerData.feishuLastSyncAt, '', '夹带精确地址的飞书同步时间必须丢弃')
    assert.strictEqual(inactivePartnerData.feishuLastSyncAction, 'synthetic-sync', '不可用详情的同步动作必须值级清除联系方式和精确地址')
    assert.strictEqual(inactivePartnerDetail.statusCode, 200, '登录用户读取脏历史下架房源应返回结构化不可用结果')
    assert.strictEqual(dataOf(inactivePartnerDetail).unavailable, true)
    assert.strictEqual(dataOf(inactivePartnerDetail).status, '已下架', '不可用详情也不得原样下发夹带私号的历史状态')
    assert.ok(!JSON.stringify(dataOf(inactivePartnerDetail)).includes(PUBLIC_FIELD_SECRET_PHONE), '不可用详情不得泄露状态中夹带的私号')
    dataOf(loggedPartnerDetail).nearby.listings.filter((item) => !item.companyListing).forEach((item) => {
      assertPublicPartnerRow(item, `登录未确认的附近推荐/${item.id}`)
    })

    // 这里只验证“已登录也走同一 IP 媒体限流”。使用不存在的合成 ID，让每次请求在
    // 限流之后快速 404；若拿超长对抗房源反复构建详情，低速 CI 可能跑过 60 秒窗口，
    // 把正确的滑动限流误判成未生效。
    const mediaLimitProbePath = '/mini/listings/GUEST_MEDIA_LIMIT_MISSING/media/video?token=invalid-capability'
    const mediaLimitProbeHeaders = {
      ...authHeaders,
      // 使用专属代理末跳地址隔离本测试此前真实读取封面产生的同 scope 计数。
      'X-Forwarded-For': '203.0.113.180'
    }
    for (let index = 0; index < 180; index += 1) {
      const mediaProbe = await request('GET', mediaLimitProbePath, null, mediaLimitProbeHeaders)
      assert.strictEqual(mediaProbe.statusCode, 404, `登录账号媒体探测限流窗口内第 ${index + 1} 次仍应由能力令牌门拒绝`)
    }
    const loggedMediaLimited = await request('GET', mediaLimitProbePath, null, mediaLimitProbeHeaders)
    assert.strictEqual(loggedMediaLimited.statusCode, 429, '登录账号不得绕过公开视频带宽限流占满全局媒体并发')
    const loggedCompanyListings = await request('GET', '/mini/listings?category=%E5%85%AC%E5%8F%B8%E6%88%BF%E6%BA%90', null, authHeaders)
    const loggedOwnerListings = await request('GET', '/mini/listings?category=%E4%B8%9A%E4%B8%BB%E6%88%BF%E6%BA%90', null, authHeaders)
    const loggedSecondLandlordListings = await request('GET', '/mini/listings?category=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90', null, authHeaders)
    assert.deepStrictEqual(dataOf(loggedCompanyListings).map((item) => item.id), ['GUEST_COMPANY'], '登录列表公司分类必须互斥')
    assert.deepStrictEqual(dataOf(loggedOwnerListings).map((item) => item.id), ['GUEST_OWNER'], '登录列表业主分类必须互斥')
    assert.deepStrictEqual(dataOf(loggedSecondLandlordListings).map((item) => item.id), ['GUEST_PARTNER'], '登录列表二房东分类必须互斥')
    assertPublicPartnerRow(dataOf(loggedOwnerListings)[0], '登录未确认的业主列表卡片')
    assertPublicPartnerRow(dataOf(loggedSecondLandlordListings)[0], '登录未确认的二房东列表卡片')
    assertAuthenticatedPartnerDisplay(dataOf(loggedSecondLandlordListings)[0], '登录二房东列表卡片')

    const loggedCompanyPins = await request('GET', '/mini/map/pins?sourceType=%E5%85%AC%E5%8F%B8%E6%88%BF%E6%BA%90', null, authHeaders)
    const loggedOwnerPins = await request('GET', '/mini/map/pins?sourceType=%E4%B8%9A%E4%B8%BB%E6%88%BF%E6%BA%90', null, authHeaders)
    const loggedSecondLandlordPins = await request('GET', '/mini/map/pins?sourceType=%E4%BA%8C%E6%88%BF%E4%B8%9C%E6%88%BF%E6%BA%90', null, authHeaders)
    assert.deepStrictEqual(listingIdsFromPins(dataOf(loggedCompanyPins)), ['GUEST_COMPANY'], '登录地图公司分类必须互斥')
    assert.deepStrictEqual(listingIdsFromPins(dataOf(loggedOwnerPins)), ['GUEST_OWNER'], '登录地图业主分类必须互斥')
    assert.deepStrictEqual(listingIdsFromPins(dataOf(loggedSecondLandlordPins)), ['GUEST_PARTNER'], '登录地图二房东分类必须互斥')
    const loggedPartnerPinText = JSON.stringify([dataOf(loggedOwnerPins), dataOf(loggedSecondLandlordPins)])
    PARTNER_SENSITIVE_VALUES.forEach((value) => assert.ok(!loggedPartnerPinText.includes(value), `登录未确认的地图不得包含敏感值 ${value}`))
    const loggedOwnerPin = dataOf(loggedOwnerPins)[0]
    const loggedPartnerPin = dataOf(loggedSecondLandlordPins)[0]
    assert.ok(loggedOwnerPin.latitude !== 30.371234 && loggedOwnerPin.longitude !== 120.181234, '登录未确认的业主地图仍不得下发逐套精确坐标')
    assert.ok(loggedPartnerPin.latitude !== 30.361234 && loggedPartnerPin.longitude !== 120.171234, '登录未确认的二房东地图仍不得下发逐套精确坐标')

    const loggedMatch = await request('POST', '/mini/listings/match', {
      area: '游客',
      layout: '两室',
      budget: 3000
    }, authHeaders)
    dataOf(loggedMatch).listings.filter((item) => !item.companyListing).forEach((item) => assertPublicPartnerRow(item, `登录未确认的匹配/${item.id}`))
    const loggedPartnerMatchCard = dataOf(loggedMatch).listings.find((item) => item.id === 'GUEST_PARTNER')
    assertAuthenticatedPartnerDisplay(loggedPartnerMatchCard, '登录普通匹配二房东卡片')
    const loggedLlmMatch = await request('POST', '/mini/llm/match', {
      text: '找游客模式范围两室3000以内',
      form: { area: '游客', layout: '两室', budget: 3000 }
    }, authHeaders)
    PARTNER_SENSITIVE_VALUES.forEach((value) => assert.ok(!JSON.stringify(dataOf(loggedLlmMatch)).includes(value), `登录未确认的 LLM 匹配不得包含敏感值 ${value}`))

    const companySensitive = await request('POST', '/mini/listings/GUEST_COMPANY/sensitive-view', {
      idempotencyKey: 'company_sensitive_http_0001'
    }, authHeaders)
    assert.strictEqual(companySensitive.statusCode, 200, '登录旧客户端调用公司 sensitive-view 应兼容成功')
    assert.deepStrictEqual(dataOf(companySensitive).sensitive.companyContactPhones, ['19900000001', '19900000002', '19900000003'], '公司 sensitive-view 只能返回服务器统一三号码')
    assert.strictEqual(dataOf(companySensitive).sensitive.landlordPhone, '19900000001', '公司 sensitive-view 兼容电话只能使用服务器统一首号')
    assertNoCompanyPrivateContact(dataOf(companySensitive), '公司 sensitive-view')

    const otherLogin = await request('POST', '/mini/auth/login', { phone: '13900000002', password: BROKER_PASSWORD })
    assert.strictEqual(otherLogin.statusCode, 200, '第二个合成账号必须可登录以锁定本人边界')
    const otherAuthHeaders = { Authorization: `Bearer ${dataOf(otherLogin).token}` }
    const otherOwned = await request('GET', '/mini/my/listings', null, otherAuthHeaders)
    assert.strictEqual(otherOwned.statusCode, 200)
    assert.ok(!dataOf(otherOwned).some((item) => item.id === 'GUEST_PENDING_OWNER'), '其他账号不得读取非本人待审核房源')
    const otherVerify = await request('POST', '/mini/my/listings/GUEST_PARTNER/verify', { outcome: '未出租' }, otherAuthHeaders)
    assert.strictEqual(otherVerify.statusCode, 403, '其他账号不得核验非本人房源')
    const otherPendingCover = await requestBuffer('GET', pendingOwnerCoverUrl, otherAuthHeaders)
    assert.strictEqual(otherPendingCover.statusCode, 200, 'owner 媒体链接是短时 bearer capability，持有已签 URL 即可供微信原生媒体组件加载')
    assert.ok(otherPendingCover.body.length > 4 && otherPendingCover.body[0] === 0xff && otherPendingCover.body[1] === 0xd8, '他号持有已签 bearer URL 时也只能读取对应媒体字节，不能据此签发其他 URL')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('guest-mode-v1-test passed')
}).catch((error) => {
  console.error(`guest-mode-v1-test failed: ${error.message}`)
  process.exit(1)
})
