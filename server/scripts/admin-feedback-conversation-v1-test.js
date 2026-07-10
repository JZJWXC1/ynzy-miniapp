const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

// 需求3：客服反馈展示完整对话。对话由既有 trace log（db.assistantTraceLogs）按 threadId 重建，
// 落库时已脱敏、listing.id 原样保留。此测试固化：重建顺序、轮次、id 保留、权限门、滚动清理降级。

const serverDir = path.resolve(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-feedback-conv-'))
const dataFile = path.join(tempDir, 'db.json')
const port = 43000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

function seedDb() {
  const db = {
    users: [{ id: 'U1', name: '超管员工', phone: '13900000001', isAdmin: true }],
    listings: [],
    footprints: [],
    // 按落库顺序（新→旧，unshift 语义）排列同一 threadId 的多轮
    assistantTraceLogs: [
      { id: 'ATLMATCHRESULTOWN01', createdAt: '2026-07-07T11:01:00Z', userId: 'U1', threadId: 'T-SHARED', intent: 'rental_match', sourceText: '本人的结构化反馈结果', reply: '本人结果', listings: [] },
      { id: 'ATLMATCHRESULTOTHER', createdAt: '2026-07-07T11:00:00Z', userId: 'U2', threadId: 'T-SHARED', intent: 'rental_match', sourceText: '其他用户同线程内容', reply: '其他用户结果', listings: [] },
      { id: 'ATL3', createdAt: '2026-07-07T10:02:00Z', threadId: 'T1', intent: 'rental_match', sourceText: '那有没有两室的', reply: '为你找到两室房源', nextQuestion: '', replyMode: 'match', need: {}, listings: [{ id: 'L1783427664217530', title: '阳光小区两室', community: '阳光小区', rent: 3000 }] },
      { id: 'ATL2', createdAt: '2026-07-07T10:01:00Z', threadId: 'T1', intent: 'rental_match', sourceText: '预算3000', reply: '好的，预算3000', nextQuestion: '那你要几室？', replyMode: 'ask', need: {}, listings: [] },
      { id: 'ATL1', createdAt: '2026-07-07T10:00:00Z', threadId: 'T1', intent: 'rental_match', sourceText: '拱墅区找房', reply: '好的，拱墅区', nextQuestion: '预算多少？', replyMode: 'ask', need: {}, listings: [] },
      { id: 'ATLX', createdAt: '2026-07-07T09:00:00Z', threadId: 'T-OTHER', intent: 'rental_match', sourceText: '别的会话', reply: '别的回复', listings: [] }
    ],
    assistantFeedbacks: [
      { id: 'F1', createdAt: '2026-07-07T10:03:00Z', status: 'open', threadId: 'T1', feedbackType: 'bad_recommendation', sourceText: '那有没有两室的', reply: '为你找到两室房源' },
      { id: 'F2', createdAt: '2026-07-07T10:04:00Z', status: 'open', threadId: '', feedbackType: 'other', sourceText: '无会话反馈', reply: '' },
      { id: 'F3', createdAt: '2026-07-07T10:05:00Z', status: 'open', threadId: 'T-GONE', feedbackType: 'other', sourceText: '会话已清理', reply: '' },
      { id: 'F4', createdAt: '2026-07-07T11:02:00Z', status: 'open', feedbackVersion: 'match-result-v1', messageId: 'ATLMATCHRESULTOWN01', userId: 'U1', needId: 'N1', feedbackType: 'helpful', reasonCode: 'price', reason: '价格合适' },
      { id: 'F5', createdAt: '2026-07-07T11:03:00Z', status: 'open', feedbackVersion: 'match-result-v1', messageId: 'ATLMATCHRESULTGONE1', userId: 'U1', needId: 'N1', feedbackType: 'bad_recommendation', reasonCode: 'too_few', reason: '结果太少' }
    ],
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
        resolve({ statusCode: res.statusCode, body: parsed })
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
  seedDb()
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN_SECRET: 'feedback-conv-secret', AUTH_TOKEN_SECRET: 'feedback-conv-mini', V1_DISABLE_LEGACY_ROUTES: '1' },
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
    const restRes = await request('GET', '/admin/assistant/feedbacks/F1/conversation', null, restAuth)
    assert.strictEqual(restRes.statusCode, 403, '区域查看权限不得查看客服对话')

    // 超管：按 threadId 重建，按时间正序（旧→新）
    const res = await request('GET', '/admin/assistant/feedbacks/F1/conversation', null, superAuth)
    assert.strictEqual(res.statusCode, 200, `重建对话应 200：${JSON.stringify(res.body)}`)
    const data = res.body.data
    assert.strictEqual(data.threadId, 'T1', 'threadId 应回显')
    assert.strictEqual(data.turnCount, 3, `应重建 3 轮，实为 ${data.turnCount}`)
    assert.strictEqual(data.turns[0].userInput, '拱墅区找房', '首轮应为最早一轮')
    assert.strictEqual(data.turns[2].userInput, '那有没有两室的', '末轮应为最新一轮')
    assert.strictEqual(data.turns[0].assistantReply, '好的，拱墅区', '应带助手回复')
    // 只取本会话，不串到别的 threadId
    assert.ok(data.turns.every((t) => t.userInput !== '别的会话'), '不得混入别的会话')
    // listing.id 原样保留（不被误脱敏）
    assert.strictEqual(data.turns[2].listings[0].id, 'L1783427664217530', 'listing.id 必须原样保留')

    // 严格反馈不保存 threadId：必须按服务端结果 ID 反查；同 threadId 的其他用户轮次不得混入。
    const strict = await request('GET', '/admin/assistant/feedbacks/F4/conversation', null, superAuth)
    assert.strictEqual(strict.statusCode, 200, '严格反馈结果 ID 反查对话应 200')
    assert.strictEqual(strict.body.data.threadId, 'T-SHARED', '严格反馈应由结果 trace 解析 threadId')
    assert.strictEqual(strict.body.data.turnCount, 1, '严格反馈对话只能包含所属用户轮次')
    assert.strictEqual(strict.body.data.turns[0].userInput, '本人的结构化反馈结果', '严格反馈取错所属用户 trace')
    assert.strictEqual(strict.body.data.truncated, false, '结果 trace 存在时不应标记截断')

    const strictGone = await request('GET', '/admin/assistant/feedbacks/F5/conversation', null, superAuth)
    assert.strictEqual(strictGone.statusCode, 200, '严格反馈结果 trace 已清理仍应 200 降级')
    assert.strictEqual(strictGone.body.data.turnCount, 0, '严格反馈结果 trace 已清理应为 0 轮')
    assert.strictEqual(strictGone.body.data.truncated, true, '严格反馈结果 trace 已清理必须标记 truncated')

    // 有 threadId 但 trace 已被滚动清理 → 优雅降级：turnCount 0 且 truncated
    const gone = await request('GET', '/admin/assistant/feedbacks/F3/conversation', null, superAuth)
    assert.strictEqual(gone.statusCode, 200, '会话已清理仍应 200 降级')
    assert.strictEqual(gone.body.data.turnCount, 0, '无 trace 应 0 轮')
    assert.strictEqual(gone.body.data.truncated, true, '有 threadId 无 trace 应标记 truncated')

    // 无 threadId 的反馈 → 0 轮、不标记 truncated
    const noThread = await request('GET', '/admin/assistant/feedbacks/F2/conversation', null, superAuth)
    assert.strictEqual(noThread.statusCode, 200, '无 threadId 反馈应 200')
    assert.strictEqual(noThread.body.data.turnCount, 0, '无 threadId 应 0 轮')
    assert.strictEqual(noThread.body.data.truncated, false, '无 threadId 不标记 truncated')

    // 不存在的反馈 → 404
    const notFound = await request('GET', '/admin/assistant/feedbacks/NOPE/conversation', null, superAuth)
    assert.strictEqual(notFound.statusCode, 404, '不存在反馈应 404')
  } finally {
    server.kill()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('admin-feedback-conversation-v1-test passed')
}).catch((error) => {
  console.error(`admin-feedback-conversation-v1-test failed: ${error.message}`)
  process.exit(1)
})
