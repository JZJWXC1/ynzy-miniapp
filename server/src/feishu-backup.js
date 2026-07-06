'use strict'

// 飞书云盘异地备份上传：把 .ygbak 加密备份上传到指定云盘文件夹。
// 设计要点：
//  - 零外部依赖：用 Node 18+ 内置 fetch / FormData / Blob 以 multipart/form-data 上传二进制文件，
//    .ygbak 以 Buffer 原样发送，绝不 toString 成字符串 JSON（那样会破坏二进制、也不是文件上传语义）。
//  - 所有飞书凭据（app_id/app_secret/folder_token）只从传入 env 读取，本库不含任何常量凭据。
//  - fetchImpl 可注入，测试用 mock 完全替代网络，绝不触达飞书公网。
//  - 飞书云盘只放加密备份文件；BACKUP_ENCRYPTION_KEY 绝不经此上传（本库根本不接触密钥）。

const fs = require('fs')
const path = require('path')
const backup = require('./backup') // 复用 parseBackupTimeMs 选最新 .ygbak（backup.js 不反向依赖本文件，无环）

const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis'

function readEnv(env, name) {
  const v = (env || {})[name]
  return v === undefined || v === null ? '' : String(v).trim()
}

// folder_token 容错：允许直接粘贴飞书云盘文件夹 URL（.../drive/folder/<token>[?参数]），
// 自动抽出末段 token；若本就是纯 token 则原样返回。避免运维把整条 URL 当 token 导致上传失败。
function extractFolderToken(value) {
  const text = String(value || '').trim()
  const matched = text.match(/\/folder\/([A-Za-z0-9]+)/)
  return matched ? matched[1] : text
}

// 读取并校验飞书备份凭据（只从传入 env 读）。缺任一必填即抛错。
function readFeishuCredentials(env) {
  const appId = readEnv(env, 'FEISHU_BACKUP_APP_ID')
  const appSecret = readEnv(env, 'FEISHU_BACKUP_APP_SECRET')
  const folderToken = readEnv(env, 'FEISHU_BACKUP_FOLDER_TOKEN')
  const missing = []
  if (!appId) missing.push('FEISHU_BACKUP_APP_ID')
  if (!appSecret) missing.push('FEISHU_BACKUP_APP_SECRET')
  if (!folderToken) missing.push('FEISHU_BACKUP_FOLDER_TOKEN')
  if (missing.length) throw new Error(`缺少飞书备份凭据环境变量：${missing.join('、')}`)
  return {
    appId,
    appSecret,
    folderToken: extractFolderToken(folderToken), // 允许填 URL，自动抽 token
    baseUrl: readEnv(env, 'FEISHU_BACKUP_API_BASE_URL') || DEFAULT_BASE_URL,
    namePrefix: readEnv(env, 'FEISHU_BACKUP_UPLOAD_NAME_PREFIX')
  }
}

// 校验 BACKUP_FILE：非空、扩展名 .ygbak、存在且为普通文件。返回字节大小。
function validateBackupFile(backupFile) {
  if (!backupFile) throw new Error('缺少 BACKUP_FILE：未指定要上传的备份文件路径')
  if (path.extname(backupFile).toLowerCase() !== '.ygbak') {
    throw new Error(`拒绝上传：BACKUP_FILE 扩展名必须是 .ygbak，实得 ${path.basename(backupFile)}`)
  }
  let stat
  try {
    stat = fs.statSync(backupFile)
  } catch (error) {
    throw new Error(`BACKUP_FILE 不存在或不可读：${backupFile}`)
  }
  if (!stat.isFile()) throw new Error(`BACKUP_FILE 不是普通文件：${backupFile}`)
  return stat.size
}

async function parseFeishuJson(response, step) {
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`飞书${step}响应非 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`飞书${step}失败：HTTP ${response.status} ${(body && body.msg) || ''}`)
  if (body.code !== 0) throw new Error(`飞书${step}失败：code=${body.code} msg=${body.msg || ''}`)
  return body
}

// 获取 tenant_access_token（应用级）。
async function getTenantAccessToken({ appId, appSecret, baseUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch
  const response = await doFetch(`${baseUrl || DEFAULT_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  })
  const body = await parseFeishuJson(response, '获取 tenant_access_token')
  if (!body.tenant_access_token) throw new Error('飞书返回缺少 tenant_access_token')
  return body.tenant_access_token
}

// 用 multipart/form-data 上传单个文件（drive upload_all，单文件 ≤20MB；.ygbak 备份远小于此）。
// 传入 bytes 为 Buffer（二进制），size 取 bytes.length 以保证与实际文件字段一致。
async function uploadFileToDrive({ bytes, fileName, folderToken, token, baseUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch
  const form = new FormData()
  form.append('file_name', fileName)
  form.append('parent_type', 'explorer') // 云盘文件夹
  form.append('parent_node', folderToken)
  form.append('size', String(bytes.length))
  // 二进制文件字段：用 Blob 包裹 Buffer，保持原样字节；不设 Content-Type，交给 fetch 自动带 boundary。
  form.append('file', new Blob([bytes]), fileName)
  const response = await doFetch(`${baseUrl || DEFAULT_BASE_URL}/drive/v1/files/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  const body = await parseFeishuJson(response, '上传文件到云盘')
  const fileToken = body.data && body.data.file_token
  if (!fileToken) throw new Error('飞书上传成功但返回缺少 file_token')
  return fileToken
}

function buildUploadName({ backupFile, namePrefix }) {
  const base = path.basename(backupFile)
  return namePrefix ? `${namePrefix}${base}` : base
}

// 编排：校验文件 → 读凭据 → 取 token → 上传。任一步失败抛错（CLI 转非零退出）。
async function uploadBackupToFeishu({ backupFile, env, fetchImpl }) {
  validateBackupFile(backupFile)
  const cred = readFeishuCredentials(env || process.env)
  const bytes = fs.readFileSync(backupFile) // Buffer（二进制），一次读入，绝不 toString
  const token = await getTenantAccessToken({
    appId: cred.appId, appSecret: cred.appSecret, baseUrl: cred.baseUrl, fetchImpl
  })
  const fileName = buildUploadName({ backupFile, namePrefix: cred.namePrefix })
  const fileToken = await uploadFileToDrive({
    bytes, fileName, folderToken: cred.folderToken, token, baseUrl: cred.baseUrl, fetchImpl
  })
  return { fileName, size: bytes.length, fileToken }
}

// ---------- 从飞书云盘拉回（列举 + 下载，用于自动闭环演练） ----------

// 列出云盘文件夹下的文件（分页汇总）。folderToken 已抽为纯 token。
async function listFolderFiles({ folderToken, token, baseUrl, fetchImpl, maxPages = 40 }) {
  const doFetch = fetchImpl || fetch
  const base = baseUrl || DEFAULT_BASE_URL
  const files = []
  let pageToken = ''
  for (let i = 0; i < maxPages; i++) {
    const url = `${base}/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=50` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '')
    const response = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    const body = await parseFeishuJson(response, '列出云盘文件夹')
    const data = body.data || {}
    for (const f of (data.files || [])) files.push(f)
    if (!data.has_more || !data.next_page_token) break
    pageToken = data.next_page_token
  }
  return files
}

// 从文件列表挑出最新的 .ygbak（按文件名内嵌 UTC 时间戳；无法解析的忽略）。
function findLatestYgbak(files) {
  let latest = null
  for (const f of (files || [])) {
    const name = f && f.name
    if (!name || !/\.ygbak$/i.test(name)) continue
    const timeMs = backup.parseBackupTimeMs(name)
    if (timeMs == null) continue
    if (!latest || timeMs > latest.timeMs) latest = { name, fileToken: f.token, timeMs }
  }
  return latest
}

// 下载单个文件为 Buffer（二进制）。下载端点成功直接回文件字节；失败回 JSON 错误。
async function downloadFile({ fileToken, token, baseUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch
  const base = baseUrl || DEFAULT_BASE_URL
  const response = await doFetch(`${base}/drive/v1/files/${encodeURIComponent(fileToken)}/download`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  })
  const ct = (response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : '') || ''
  // 失败时飞书返回 JSON（application/json）；成功返回二进制流。
  if (!response.ok || /application\/json/i.test(ct)) {
    await parseFeishuJson(response, '下载云盘文件') // code!=0 或 HTTP 非 2xx 会抛错
    throw new Error('下载返回的是 JSON 而非文件内容') // 万一 code=0 又是 JSON
  }
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length === 0) throw new Error('下载到的文件为空')
  return buf
}

// 编排：读凭据 → 取 token → 列文件夹 → 选最新 .ygbak → 下载 → 写到 destPath（二进制）。
async function downloadLatestBackup({ env, fetchImpl, destPath }) {
  const cred = readFeishuCredentials(env || process.env)
  const token = await getTenantAccessToken({
    appId: cred.appId, appSecret: cred.appSecret, baseUrl: cred.baseUrl, fetchImpl
  })
  const files = await listFolderFiles({ folderToken: cred.folderToken, token, baseUrl: cred.baseUrl, fetchImpl })
  const latest = findLatestYgbak(files)
  if (!latest) throw new Error('飞书文件夹里没有可识别的 .ygbak 备份')
  const bytes = await downloadFile({ fileToken: latest.fileToken, token, baseUrl: cred.baseUrl, fetchImpl })
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, bytes) // 写的是加密 .ygbak（非明文）
  return { name: latest.name, fileToken: latest.fileToken, size: bytes.length, path: destPath }
}

module.exports = {
  DEFAULT_BASE_URL,
  readEnv,
  extractFolderToken,
  readFeishuCredentials,
  validateBackupFile,
  getTenantAccessToken,
  uploadFileToDrive,
  buildUploadName,
  uploadBackupToFeishu,
  listFolderFiles,
  findLatestYgbak,
  downloadFile,
  downloadLatestBackup
}
