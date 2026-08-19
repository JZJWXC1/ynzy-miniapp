const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求1：数据备份页展示同步状态。GET /admin/backup/status 只读非敏感元数据（时间/文件名/新鲜度/
// 配置布尔/演练结果）。安全红线：绝不返回 BACKUP_ENCRYPTION_KEY / FEISHU_BACKUP_* / 任何 token。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-backup-status-'))
const dataFile = path.join(tempDir, 'db.json')
const stageDir = path.join(tempDir, 'backups')
const port = 45000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

const SECRETS = ['TOPSECRETKEY123', 'FEISHUSECRET999', 'fldTokenXYZ', 'SHOULD_NOT_LEAK', 'NEVER']

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}
function ygbak(ms) {
  return `db-backup-${stamp(ms)}.ygbak`
}

const now = Date.now()
const recentName = ygbak(now - 3600000) // 1 小时前 → 新鲜
const oldName = ygbak(now - 100 * 3600000) // 100 小时前

function seedFiles() {
  fs.mkdirSync(stageDir, { recursive: true })
  fs.writeFileSync(path.join(stageDir, recentName), 'ENCRYPTED-PLACEHOLDER')
  fs.writeFileSync(path.join(stageDir, oldName), 'ENCRYPTED-PLACEHOLDER')
  // 状态文件故意混入敏感键，验证端点按白名单只透出安全字段。
  fs.writeFileSync(path.join(stageDir, 'restore-drill-status.json'), JSON.stringify({
    ok: true, atMs: now - 3600000, kind: 'local', fileName: recentName, countsMatch: true, note: '',
    secret: 'SHOULD_NOT_LEAK', BACKUP_ENCRYPTION_KEY: 'NEVER'
  }))
  fs.writeFileSync(path.join(stageDir, 'feishu-drill-status.json'), JSON.stringify({
    ok: true, atMs: now - 7200000, kind: 'feishu', fileName: recentName, countsMatch: true
  }))
  const db = {
    users: [{ id: 'U1', name: '超管', phone: '13900000001', isAdmin: true }],
    listings: [],
    footprints: [],
    adminAccounts: [
      { id: 'A-SUPER', account: 'superadmin', password: 'superpass123', name: '超管', userId: 'U1', permission: '全部后台权限', status: '启用' },
      { id: 'A-REST', account: 'restadmin', password: 'restpass123', name: '区域', userId: 'U1', permission: '区域查看权限', status: '启用' }
    ]
  }
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8')
}

function request(method, targetPath, body, headers = {}) {
  const url = new URL(targetPath, baseUrl)
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch (error) { parsed = { raw } }
        resolve({ statusCode: res.statusCode, body: parsed, raw })
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

async function login(account, password) {
  const res = await request('POST', '/admin/auth/login', { account, password })
  assert.strictEqual(res.statusCode, 200, `${account} 登录失败：${JSON.stringify(res.body)}`)
  return { Authorization: `Bearer ${res.body.data.token}` }
}

async function run() {
  seedFiles()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      ADMIN_TOKEN_SECRET: 'backup-status-secret',
      AUTH_TOKEN_SECRET: 'backup-status-mini',
      V1_DISABLE_LEGACY_ROUTES: '1',
      BACKUP_STAGE_DIR: stageDir,
      BACKUP_MAX_AGE_HOURS: '24',
      BACKUP_RETENTION_DAYS: '30',
      BACKUP_ENCRYPTION_KEY: 'TOPSECRETKEY123',
      BACKUP_REMOTE_CMD: 'echo remote',
      FEISHU_BACKUP_APP_ID: 'cli_app',
      FEISHU_BACKUP_APP_SECRET: 'FEISHUSECRET999',
      FEISHU_BACKUP_FOLDER_TOKEN: 'fldTokenXYZ'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  server.stdout.on('data', (c) => { output += c.toString() })
  server.stderr.on('data', (c) => { output += c.toString() })

  try {
    assert.ok(await waitForServer(), `服务未启动：${output}`)
    const superAuth = await login('superadmin', 'superpass123')
    const restAuth = await login('restadmin', 'restpass123')

    // 普通管理员不得访问
    const restRes = await request('GET', '/admin/backup/status', null, restAuth)
    assert.strictEqual(restRes.statusCode, 403, '区域查看权限不得访问备份状态')

    const res = await request('GET', '/admin/backup/status', null, superAuth)
    assert.strictEqual(res.statusCode, 200, `备份状态应 200：${JSON.stringify(res.body)}`)
    const data = res.body.data

    // 异地备份新鲜度
    assert.strictEqual(data.offsite.latestFile, recentName, '应取最新一份备份')
    assert.strictEqual(data.offsite.backupCount, 2, '应统计到 2 份备份')
    assert.strictEqual(data.offsite.fresh, true, '1 小时前的备份应判为新鲜')
    assert.strictEqual(data.offsite.maxAgeHours, 24, '新鲜度阈值应回显 24')
    assert.strictEqual(data.offsite.retentionDays, 30, '保留天数应回显 30')

    // 配置布尔（只报是否配置，不回显值）
    assert.strictEqual(data.offsite.encryptionConfigured, true, '加密应显示已配置')
    assert.strictEqual(data.offsite.remoteConfigured, true, '异地命令应显示已配置')
    assert.strictEqual(data.feishu.configured, true, '飞书应显示已配置')

    // 演练结果（来自状态文件）
    assert.ok(data.localDrill && data.localDrill.ok === true, '本地演练结果应为成功')
    assert.strictEqual(data.localDrill.countsMatch, true, '本地演练计数应匹配')
    assert.ok(data.feishu.lastDrill && data.feishu.lastDrill.ok === true, '飞书演练结果应为成功')
    assert.strictEqual(data.feishu.lastDrill.fileName, recentName, '飞书演练应回显最近备份文件名')

    // 白名单：状态文件里混入的敏感键不得透出
    assert.strictEqual(data.localDrill.secret, undefined, '状态文件的 secret 键不得透出')
    assert.strictEqual(data.localDrill.BACKUP_ENCRYPTION_KEY, undefined, '状态文件的密钥键不得透出')

    // 安全红线：整个响应不得出现任何凭据明文
    const dump = res.raw
    for (const secret of SECRETS) {
      assert.strictEqual(dump.indexOf(secret), -1, `响应中不得出现敏感串：${secret}`)
    }
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-backup-status-v1-test passed')
}).catch((error) => {
  console.error(`admin-backup-status-v1-test failed: ${error.message}`)
  process.exit(1)
})
