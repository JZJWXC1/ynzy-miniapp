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

module.exports = {
  rootDir,
  port: numberFromEnv('PORT', 3000),
  dataFile,
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
  miniProgram: {
    requestDomain: process.env.MINI_REQUEST_DOMAIN || 'https://zf-api.ynzyqbot.cn/',
    uploadDomain: process.env.MINI_UPLOAD_DOMAIN || 'https://ynzy-house-videos-bj.oss-cn-beijing.aliyuncs.com',
    downloadDomain: process.env.MINI_DOWNLOAD_DOMAIN || 'https://ynzy-house-videos-bj.oss-cn-beijing.aliyuncs.com'
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
    syncIntervalMinutes: numberFromEnv('FEISHU_SYNC_INTERVAL_MINUTES', 1440)
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
