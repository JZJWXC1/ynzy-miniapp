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

function listFromEnv(name, fallback = []) {
  const value = process.env[name]
  const source = value === undefined || value === ''
    ? fallback
    : String(value).split(/[,\s/|，、]+/)
  return source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
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
  '小洋坝家园一区': { district: '余杭区', block: '万达' },
  '小洋坝家园二区': { district: '余杭区', block: '万达' },
  '小洋坝家园三区': { district: '余杭区', block: '万达' },
  '大华海派风景': { district: '余杭区', block: '万达' },
  '风雅乐府': { district: '余杭区', block: '万达' },
  '瑷颐湾': { district: '余杭区', block: '万达' }
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
  // 第一版历史接口下线开关：默认开启（积分充值、房源群等历史路由统一 404）
  // 如需临时恢复历史功能，显式设置 V1_DISABLE_LEGACY_ROUTES=0
  disableLegacyRoutes: boolFromEnv('V1_DISABLE_LEGACY_ROUTES', true),
  miniProgram: {
    requestDomain: process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/',
    uploadDomain: process.env.MINI_UPLOAD_DOMAIN || 'https://ynzy-house-videos-bj.oss-cn-beijing.aliyuncs.com',
    socketDomain: process.env.MINI_SOCKET_DOMAIN || process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/',
    downloadDomain: process.env.MINI_DOWNLOAD_DOMAIN || 'https://ynzy-house-videos-bj.oss-cn-beijing.aliyuncs.com'
  },
  company: {
    contactPhones: listFromEnv('COMPANY_CONTACT_PHONES', [])
  },
  qqMap: {
    webserviceKey: process.env.QQ_MAP_WEBSERVICE_KEY || process.env.QQ_MAP_KEY || ''
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
    bitableAppToken: process.env.FEISHU_BITABLE_APP_TOKEN || '',
    bitableTableId: process.env.FEISHU_BITABLE_TABLE_ID || '',
    sheetUrl: configuredSheetUrl,
    sheetToken: extractSheetToken(configuredSheetToken),
    sheetId: process.env.FEISHU_SHEET_ID || jsonValue(feishuSheetTokenFile, 'sheet_id'),
    sheetRange: process.env.FEISHU_SHEET_RANGE || jsonValue(feishuSheetTokenFile, 'range') || 'A1:ZZ1000',
    folderToken: process.env.FEISHU_MATERIAL_FOLDER_TOKEN || jsonValue(feishuFolderTokenFile, 'folder_token'),
    pageSize: numberFromEnv('FEISHU_PAGE_SIZE', 50),
    maxFolderDepth: numberFromEnv('FEISHU_MAX_FOLDER_DEPTH', 8),
    recordsFile: process.env.FEISHU_RECORDS_FILE || '',
    materialsFile: process.env.FEISHU_MATERIALS_FILE || '',
    uploadToOss: boolFromEnv('FEISHU_UPLOAD_TO_OSS', true),
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
