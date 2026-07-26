const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const defaultOssHomeUrl = 'https://bj33856.apps.aliyunfile.com/disk/admin/home'

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return

  const content = fs.readFileSync(filePath, 'utf8')
  content.split(/\r?\n/).forEach((line) => {
    const text = line.trim()
    if (!text || text.startsWith('#')) return

    const match = text.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (!match) return

    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (!process.env[key]) {
      process.env[key] = value
    }
  })
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function boolFromEnv(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on|是)$/i.test(String(value).trim())
}

function enumFromEnv(name, allowedValues, fallback = '') {
  const value = process.env[name]
  const normalized = value === undefined || value === '' ? fallback : String(value).trim()
  if (allowedValues.includes(normalized)) return normalized
  throw new Error(`${name} 只允许为空或 ${allowedValues.filter(Boolean).join('、')}`)
}

function listFromEnv(name, fallback = []) {
  const value = process.env[name]
  const source = value === undefined || value === ''
    ? fallback
    : String(value).split(/[,\s/|，、]+/)
  return source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function fieldBindingsFromEnv(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return {}

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} 必须是合法 JSON 对象`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} 必须是字段语义到 field_id 的 JSON 对象`)
  }

  return Object.keys(parsed).reduce((bindings, semantic) => {
    const rawBinding = parsed[semantic]
    const binding = typeof rawBinding === 'string' ? { fieldId: rawBinding } : rawBinding
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error(`${name} 的 ${semantic || '空语义名'} 绑定必须是 field_id 字符串或对象`)
    }
    const fieldId = String(binding.fieldId || binding.field_id || '').trim()
    const hasType = Object.prototype.hasOwnProperty.call(binding, 'type')
    const types = hasType ? (Array.isArray(binding.type) ? binding.type : [binding.type]) : []
    const normalizedTypes = types
      .map((type) => (typeof type === 'number' && Number.isFinite(type)) ? type : String(type || '').trim())
      .filter((type) => type !== '')
    if (!semantic.trim() || !fieldId || (hasType && normalizedTypes.length === 0)) {
      throw new Error(`${name} 的 ${semantic || '空语义名'} 绑定缺少 fieldId 或 type 无效`)
    }
    const hasRequired = Object.prototype.hasOwnProperty.call(binding, 'required')
    if (hasRequired && typeof binding.required !== 'boolean') {
      throw new Error(`${name} 的 ${semantic} required 必须是 JSON 布尔值`)
    }
    bindings[semantic.trim()] = { fieldId }
    if (normalizedTypes.length) bindings[semantic.trim()].type = normalizedTypes.length === 1 ? normalizedTypes[0] : normalizedTypes
    if (hasRequired) bindings[semantic.trim()].required = binding.required
    return bindings
  }, {})
}

function jsonValue(filePath, key) {
  if (!fs.existsSync(filePath)) return ''
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
    return data && data[key] ? String(data[key]) : ''
  } catch (error) {
    return ''
  }
}

function extractSheetToken(value) {
  const text = String(value || '').trim()
  const matched = text.match(/\/sheets\/([A-Za-z0-9]+)/)
  return matched ? matched[1] : text
}

loadEnvFile(path.join(rootDir, '.env'))

const dataFile = path.isAbsolute(process.env.DATA_FILE || '')
  ? process.env.DATA_FILE
  : path.join(rootDir, process.env.DATA_FILE || 'data/db.json')

const feishuFolderTokenFile = path.resolve(rootDir, '..', 'lark-folder-params.json')
const feishuSheetTokenFile = path.resolve(rootDir, '..', 'lark-sheet-params.json')
const configuredSheetUrl = process.env.FEISHU_SHEET_URL || jsonValue(feishuSheetTokenFile, 'sheet_url')
const configuredSheetToken = process.env.FEISHU_SHEET_TOKEN || jsonValue(feishuSheetTokenFile, 'spreadsheet_token') || extractSheetToken(configuredSheetUrl)
const legacyBitableAppToken = String(process.env.FEISHU_BITABLE_APP_TOKEN || '').trim()
const explicitSourceBitableAppToken = String(process.env.FEISHU_SOURCE_BITABLE_APP_TOKEN || '').trim()
const explicitTargetBitableAppToken = String(process.env.FEISHU_TARGET_BITABLE_APP_TOKEN || '').trim()
const crossBaseTokenPartial = Boolean(explicitSourceBitableAppToken) !== Boolean(explicitTargetBitableAppToken)
const sourceBitableAppToken = crossBaseTokenPartial
  ? explicitSourceBitableAppToken
  : (explicitSourceBitableAppToken || legacyBitableAppToken)
const targetBitableAppToken = crossBaseTokenPartial
  ? explicitTargetBitableAppToken
  : (explicitTargetBitableAppToken || legacyBitableAppToken)
const districtBlocks = {
  '拱墅区': ['万达', '北部软件园', '城北万象城', '石桥', '华丰', '永佳', '半山', '东新园', '杭氧', '新天地'],
  '上城区': ['闸弄口', '新塘', '元宝塘', '东站'],
  '余杭区': []
}
const blockDistrictMap = Object.keys(districtBlocks).reduce((map, district) => {
  districtBlocks[district].forEach((block) => {
    map[block] = district
  })
  return map
}, {})
const communityLocationOverrides = {
  '小洋坝家园一区': { district: '余杭区', block: '城北万象城' },
  '小洋坝家园二区': { district: '余杭区', block: '城北万象城' },
  '小洋坝家园三区': { district: '余杭区', block: '城北万象城' },
  '大华海派风景': { district: '余杭区', block: '城北万象城' },
  '风雅乐府': { district: '余杭区', block: '城北万象城' },
  '瑷颐湾': { district: '余杭区', block: '城北万象城' }
}
const communityDistrictOverrides = Object.keys(communityLocationOverrides).reduce((map, community) => {
  map[community] = communityLocationOverrides[community].district
  return map
}, {})
const communityBlockOverrides = Object.keys(communityLocationOverrides).reduce((map, community) => {
  map[community] = communityLocationOverrides[community].block
  return map
}, {})
const blockCenters = {
  '万达': { latitude: 30.333, longitude: 120.128 },
  '北部软件园': { latitude: 30.335, longitude: 120.121 },
  '城北万象城': { latitude: 30.324, longitude: 120.127 },
  '石桥': { latitude: 30.333, longitude: 120.191 },
  '华丰': { latitude: 30.338, longitude: 120.2 },
  '永佳': { latitude: 30.344, longitude: 120.189 },
  '半山': { latitude: 30.358, longitude: 120.195 },
  '东新园': { latitude: 30.303, longitude: 120.168 },
  '杭氧': { latitude: 30.303, longitude: 120.171 },
  '新天地': { latitude: 30.309, longitude: 120.181 },
  '闸弄口': { latitude: 30.293, longitude: 120.196 },
  '新塘': { latitude: 30.285, longitude: 120.206 },
  '元宝塘': { latitude: 30.281, longitude: 120.217 },
  '东站': { latitude: 30.29, longitude: 120.212 },
  '祥符': { latitude: 30.342, longitude: 120.116 }
}

module.exports = {
  rootDir,
  port: numberFromEnv('PORT', 3000),
  // 监听地址：默认只绑 127.0.0.1，强制流量经生产 nginx（其 proxy_pass 指向 127.0.0.1）进入，
  // 不把应用端口直接暴露到公网、绕过 nginx。确需对外直连或跨主机健康检查时显式设 HOST=0.0.0.0。
  host: process.env.HOST || '127.0.0.1',
  dataFile,
  // db.json 默认紧凑序列化以降低整库重写的磁盘写放大；DB_JSON_PRETTY=1 恢复缩进便于人读。
  dbPrettyJson: boolFromEnv('DB_JSON_PRETTY', false),
  // 是否信任 X-Forwarded-For（部署于 nginx 等可信反向代理之后时为真，默认真）；
  // 直连暴露应设 TRUST_PROXY=0，否则客户端可伪造 XFF 绕过游客限流。
  trustProxy: boolFromEnv('TRUST_PROXY', true),
  adminWebDir: path.resolve(rootDir, '..', 'admin-web'),
  oss: {
    homeUrl: process.env.ALI_OSS_HOME_URL || defaultOssHomeUrl,
    publicBaseUrl: process.env.ALI_OSS_PUBLIC_BASE_URL || '',
    bucket: process.env.ALI_OSS_BUCKET || '',
    region: process.env.ALI_OSS_REGION || 'oss-cn-beijing',
    accessKeyId: process.env.ALI_OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALI_OSS_ACCESS_KEY_SECRET || '',
    securityToken: process.env.ALI_OSS_SECURITY_TOKEN || '',
    uploadDir: process.env.ALI_OSS_UPLOAD_DIR || 'house-videos',
    maxVideoSize: numberFromEnv('ALI_OSS_MAX_VIDEO_MB', 300) * 1024 * 1024,
    policyExpireSeconds: numberFromEnv('ALI_OSS_POLICY_EXPIRE_SECONDS', 900),
    readUrlExpireSeconds: numberFromEnv('ALI_OSS_READ_URL_EXPIRE_SECONDS', 900)
  },
  rechargePaymentMode: process.env.RECHARGE_PAYMENT_MODE || 'manual',
  features: {
    // 报备/签单第一版暂停：仅允许服务器环境显式恢复，客户端正文与查询参数不能改变该开关。
    reportDealWritesEnabled: boolFromEnv('REPORT_DEAL_WRITES_ENABLED', false)
  },
  // 第一版历史接口下线开关：默认开启（积分充值、房源群等历史路由统一 404）
  // 如需临时恢复历史功能，显式设置 V1_DISABLE_LEGACY_ROUTES=0
  disableLegacyRoutes: boolFromEnv('V1_DISABLE_LEGACY_ROUTES', true),
  miniProgram: {
    requestDomain: process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/',
    uploadDomain: process.env.MINI_UPLOAD_DOMAIN || 'https://ynzy-house-videos-bj.oss-cn-beijing.aliyuncs.com',
    socketDomain: process.env.MINI_SOCKET_DOMAIN || process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/',
    // 公共视频改走 API 域不透明代理；wx.downloadFile 合法域名必须包含同一 API 域。
    downloadDomain: process.env.MINI_DOWNLOAD_DOMAIN || process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/'
  },
  company: {
    contactPhones: listFromEnv('COMPANY_CONTACT_PHONES', [])
  },
  qqMap: {
    webserviceKey: process.env.QQ_MAP_WEBSERVICE_KEY || process.env.QQ_MAP_KEY || '',
    // 地图 JS API(GL) 专用 key，供管理后台坐标点选地图加载。建议与 webserviceKey 分开、按域名白名单限制，
    // 不要复用 webservice key（前端暴露会被抓地理编码配额）。未配置时后台坐标修正退回手填经纬度。
    jsApiKey: process.env.QQ_MAP_JS_API_KEY || process.env.QQ_MAP_JS_KEY || '',
    // 后台坐标点选地图默认初始中心：拱墅区 5号线东新园地铁口（geocode 结果）。
    defaultMapCenter: {
      latitude: Number(process.env.ADMIN_MAP_DEFAULT_LAT || 30.306628),
      longitude: Number(process.env.ADMIN_MAP_DEFAULT_LNG || 120.173407),
      label: process.env.ADMIN_MAP_DEFAULT_LABEL || '拱墅区5号线东新园地铁口'
    }
  },
  location: {
    districtBlocks,
    blockDistrictMap,
    communityLocationOverrides,
    communityDistrictOverrides,
    communityBlockOverrides,
    blockCenters
  },
  feishu: {
    baseUrl: process.env.FEISHU_API_BASE_URL || 'https://open.feishu.cn/open-apis',
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    bitableAppToken: legacyBitableAppToken,
    // 两个新变量必须成对配置；只配一个时缺失侧不回退旧 token，避免半迁移误写旧 Base。
    sourceBitableAppToken,
    targetBitableAppToken,
    crossBaseTokenPartial,
    bitableTableId: String(process.env.FEISHU_BITABLE_TABLE_ID || '').trim(),
    // 镜像模式显式开启后，员工源表只读；源 record_id 是专用副本唯一幂等键。
    // 旧 FEISHU_BITABLE_TABLE_ID 保留原义，并作为新源表配置的兼容回退。
    sourceTableId: String(process.env.FEISHU_SOURCE_TABLE_ID || process.env.FEISHU_BITABLE_TABLE_ID || '').trim(),
    miniTableId: String(process.env.FEISHU_MINI_TABLE_ID || '').trim(),
    locationTableId: String(process.env.FEISHU_LOCATION_TABLE_ID || '').trim(),
    rentedTableId: String(process.env.FEISHU_RENTED_TABLE_ID || '').trim(),
    historyTableId: String(process.env.FEISHU_HISTORY_TABLE_ID || '').trim(),
    sourceFieldBindings: fieldBindingsFromEnv('FEISHU_SOURCE_FIELD_BINDINGS'),
    miniFieldBindings: fieldBindingsFromEnv('FEISHU_MINI_FIELD_BINDINGS'),
    locationFieldBindings: fieldBindingsFromEnv('FEISHU_LOCATION_FIELD_BINDINGS'),
    rentedFieldBindings: fieldBindingsFromEnv('FEISHU_RENTED_FIELD_BINDINGS'),
    historyFieldBindings: fieldBindingsFromEnv('FEISHU_HISTORY_FIELD_BINDINGS'),
    sourceCompatibilityProfile: enumFromEnv(
      'FEISHU_SOURCE_COMPATIBILITY_PROFILE',
      ['', 'employee-current-stock-v1', 'employee-ai-foundation-v1']
    ),
    mirrorSyncEnabled: boolFromEnv('FEISHU_MIRROR_SYNC_ENABLED', false),
    syncEnabled: boolFromEnv('FEISHU_SYNC_ENABLED', true),
    autoSyncEnabled: boolFromEnv('FEISHU_AUTO_SYNC_ENABLED', true),
    sheetUrl: configuredSheetUrl,
    sheetToken: extractSheetToken(configuredSheetToken),
    sheetId: process.env.FEISHU_SHEET_ID || jsonValue(feishuSheetTokenFile, 'sheet_id'),
    sheetRange: process.env.FEISHU_SHEET_RANGE || jsonValue(feishuSheetTokenFile, 'range') || 'A1:ZZ1000',
    folderToken: process.env.FEISHU_MATERIAL_FOLDER_TOKEN || jsonValue(feishuFolderTokenFile, 'folder_token'),
    // 员工源表“房源笔记”只读绑定使用稳定 field_id；显示列名变化不会改变读取目标。
    // 新链路会写飞书云盘、OSS 与私有素材清单，必须在首次 dry-run 和目标目录核验后显式开启。
    noteMaterialSyncEnabled: boolFromEnv('FEISHU_NOTE_MATERIAL_SYNC_ENABLED', false),
    noteMaterialFieldId: String(process.env.FEISHU_NOTE_MATERIAL_FIELD_ID || 'fldyeAGJHV').trim(),
    noteMaterialAllowedHosts: listFromEnv('FEISHU_NOTE_MATERIAL_ALLOWED_HOSTS', ['ccn9urs7d60k.feishu.cn']),
    noteMaterialTargetRootFolderToken: String(
      process.env.FEISHU_NOTE_MATERIAL_TARGET_ROOT_FOLDER_TOKEN || ''
    ).trim(),
    noteMaterialMaxDepth: numberFromEnv('FEISHU_NOTE_MATERIAL_MAX_DEPTH', 8),
    noteMaterialMaxItems: numberFromEnv('FEISHU_NOTE_MATERIAL_MAX_ITEMS', 5000),
    pageSize: numberFromEnv('FEISHU_PAGE_SIZE', 50),
    requestTimeoutMs: numberFromEnv('FEISHU_REQUEST_TIMEOUT_MS', 30000),
    requestMaxRetries: numberFromEnv('FEISHU_REQUEST_MAX_RETRIES', 2),
    requestRetryDelayMs: numberFromEnv('FEISHU_REQUEST_RETRY_DELAY_MS', 200),
    mirrorMaxDeactivateCount: numberFromEnv('FEISHU_MIRROR_MAX_DEACTIVATE_COUNT', 10),
    mirrorMaxDeactivateRatio: numberFromEnv('FEISHU_MIRROR_MAX_DEACTIVATE_RATIO', 0.35),
    mirrorAllowMassDeactivate: boolFromEnv('FEISHU_MIRROR_ALLOW_MASS_DEACTIVATE', false),
    maxFolderDepth: numberFromEnv('FEISHU_MAX_FOLDER_DEPTH', 8),
    recordsFile: process.env.FEISHU_RECORDS_FILE || '',
    materialsFile: process.env.FEISHU_MATERIALS_FILE || '',
    uploadToOss: boolFromEnv('FEISHU_UPLOAD_TO_OSS', true),
    materialTransferTimeoutMs: numberFromEnv('FEISHU_MATERIAL_TRANSFER_TIMEOUT_MS', 120000),
    materialTransferRetryCount: numberFromEnv('FEISHU_MATERIAL_TRANSFER_RETRY_COUNT', 2),
    materialTransferRetryDelayMs: numberFromEnv('FEISHU_MATERIAL_TRANSFER_RETRY_DELAY_MS', 800),
    syncIntervalMinutes: numberFromEnv('FEISHU_SYNC_INTERVAL_MINUTES', 60)
  },
  wechatPay: {
    enabled: process.env.RECHARGE_PAYMENT_MODE === 'wechat',
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
    mchId: process.env.WECHAT_PAY_MCH_ID || '',
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
    certSerialNo: process.env.WECHAT_PAY_CERT_SERIAL_NO || '',
    privateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || '',
    platformCertPath: process.env.WECHAT_PAY_PLATFORM_CERT_PATH || '',
    platformCertSerialNo: process.env.WECHAT_PAY_PLATFORM_CERT_SERIAL_NO || '',
    publicKeyPath: process.env.WECHAT_PAY_PUBLIC_KEY_PATH || '',
    publicKeyId: process.env.WECHAT_PAY_PUBLIC_KEY_ID || '',
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || '',
    testOpenid: process.env.WECHAT_PAY_TEST_OPENID || ''
  }
}
