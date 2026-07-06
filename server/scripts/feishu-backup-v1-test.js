'use strict'

// 飞书云盘异地备份上传的锁定测试。
// 红线：全程用 mock 替代 fetch，绝不请求飞书公网；只用明显的假凭据，不写任何真实 token / folder token。
// 覆盖：BACKUP_FILE 缺失/非 .ygbak/凭据缺失 → 失败；mock 成功 → 成功；mock 失败 → 抛错；
//       multipart/form-data 二进制正确性（不把 .ygbak 读成字符串 JSON）；runBackup 经 remoteCmd 传 BACKUP_FILE。

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const feishu = require('../src/feishu-backup')
const backup = require('../src/backup')

// 明显假的飞书凭据（绝非真实值）。
const FAKE_ENV = {
  FEISHU_BACKUP_APP_ID: 'mock-app-id',
  FEISHU_BACKUP_APP_SECRET: 'mock-app-secret-not-real',
  FEISHU_BACKUP_FOLDER_TOKEN: 'fake-folder-token-XXXX'
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ynzy-feishu-${tag}-`))
}

// 写一个含非 UTF-8 字节的假 .ygbak，用来证明 multipart 发送的是原始二进制而非字符串。
function writeFakeYgbak(dir) {
  const file = path.join(dir, 'db-backup-20260706T120000Z.ygbak')
  const bytes = Buffer.from([0x59, 0x47, 0x42, 0x4b, 0x30, 0x31, 0x00, 0xff, 0xfe, 0x80, 0x01, 0x02, 0xf0])
  fs.writeFileSync(file, bytes)
  return { file, bytes }
}

function mockResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// 生成 mock fetch：记录调用，token/upload 分别返回给定响应；任何其它 URL 直接报错（证明不触公网）。
function makeMockFetch({ token = mockResponse(200, { code: 0, tenant_access_token: 'mock-tenant-token', expire: 7200 }),
  upload = mockResponse(200, { code: 0, data: { file_token: 'mock-file-token-123' } }) } = {}) {
  const calls = { token: null, upload: null, all: [] }
  const impl = async (url, opts) => {
    const u = String(url)
    calls.all.push(u)
    if (u.includes('/auth/v3/tenant_access_token/internal')) { calls.token = { url: u, opts }; return token }
    if (u.includes('/drive/v1/files/upload_all')) { calls.upload = { url: u, opts }; return upload }
    throw new Error('测试触达了非预期 URL（不得请求真实公网）：' + u)
  }
  impl.calls = calls
  return impl
}

async function expectReject(promise, re, msg) {
  let threw = false
  try { await promise } catch (e) { threw = true; if (re) assert.ok(re.test(e.message), `${msg}；实得：${e.message}`) }
  assert.ok(threw, msg)
}

async function run() {
  // 1) BACKUP_FILE 缺失 → 失败（且不发起任何网络请求）。
  {
    const f = makeMockFetch()
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: '', env: FAKE_ENV, fetchImpl: f }),
      /缺少 BACKUP_FILE/, 'BACKUP_FILE 缺失必须失败'
    )
    assert.strictEqual(f.calls.all.length, 0, '文件校验失败时不得发起网络请求')
  }

  // 2) BACKUP_FILE 不是 .ygbak → 失败。
  {
    const dir = tmpdir('ext')
    const bad = path.join(dir, 'db.json')
    fs.writeFileSync(bad, '{}')
    const f = makeMockFetch()
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: bad, env: FAKE_ENV, fetchImpl: f }),
      /扩展名必须是 \.ygbak/, '非 .ygbak 必须失败'
    )
    assert.strictEqual(f.calls.all.length, 0, '扩展名不符时不得发起网络请求')
  }

  // 2.1) BACKUP_FILE 指定了 .ygbak 但文件不存在 → 失败。
  {
    const f = makeMockFetch()
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: path.join(os.tmpdir(), 'no-such-file.ygbak'), env: FAKE_ENV, fetchImpl: f }),
      /不存在或不可读/, '不存在的 .ygbak 必须失败'
    )
  }

  // 3) 飞书凭据缺失 → 失败（逐个必填项）。
  {
    const { file } = writeFakeYgbak(tmpdir('cred'))
    for (const miss of ['FEISHU_BACKUP_APP_ID', 'FEISHU_BACKUP_APP_SECRET', 'FEISHU_BACKUP_FOLDER_TOKEN']) {
      const env = { ...FAKE_ENV }; delete env[miss]
      const f = makeMockFetch()
      await expectReject(
        feishu.uploadBackupToFeishu({ backupFile: file, env, fetchImpl: f }),
        new RegExp(miss), `缺少 ${miss} 必须失败`
      )
      assert.strictEqual(f.calls.all.length, 0, '凭据缺失时不得发起网络请求')
    }
  }

  // 4) mock token + upload 成功 → 返回 file_token；并断言 multipart/form-data 二进制正确性。
  {
    const { file, bytes } = writeFakeYgbak(tmpdir('ok'))
    const f = makeMockFetch()
    const result = await feishu.uploadBackupToFeishu({ backupFile: file, env: FAKE_ENV, fetchImpl: f })
    assert.strictEqual(result.fileToken, 'mock-file-token-123', '应返回飞书 file_token')
    assert.strictEqual(result.size, bytes.length, '返回大小应等于文件字节数')

    // token 请求：JSON body 含假 app_id/app_secret，且用的是内置端点。
    assert.ok(f.calls.token, '应请求 tenant_access_token')
    const tokenBody = JSON.parse(f.calls.token.opts.body)
    assert.strictEqual(tokenBody.app_id, 'mock-app-id', 'token 请求应带 app_id')
    assert.strictEqual(tokenBody.app_secret, 'mock-app-secret-not-real', 'token 请求应带 app_secret')

    // upload 请求：必须是 multipart/form-data（FormData body），不是字符串 JSON。
    const upOpts = f.calls.upload.opts
    assert.ok(upOpts.body instanceof FormData, '上传 body 必须是 FormData（multipart/form-data），不得是字符串 JSON')
    assert.strictEqual(typeof upOpts.body, 'object', '上传 body 不得是字符串')
    assert.strictEqual(upOpts.headers.Authorization, 'Bearer mock-tenant-token', '上传须带 Bearer token')
    assert.ok(!('Content-Type' in upOpts.headers) && !('content-type' in upOpts.headers), '不得手动设 Content-Type，交给 fetch 带 boundary')

    const form = upOpts.body
    assert.strictEqual(form.get('parent_type'), 'explorer', 'parent_type=explorer')
    assert.strictEqual(form.get('parent_node'), 'fake-folder-token-XXXX', 'parent_node=folder_token')
    assert.strictEqual(form.get('file_name'), path.basename(file), 'file_name 为备份文件名')
    assert.strictEqual(form.get('size'), String(bytes.length), 'size 等于实际字节数')

    // file 字段必须是二进制 Blob，且字节与源文件逐字节一致（证明没被读成字符串而损坏二进制）。
    const blob = form.get('file')
    assert.ok(blob instanceof Blob, 'file 字段必须是 Blob（二进制）')
    assert.strictEqual(blob.size, bytes.length, 'Blob 大小应等于源文件字节数')
    const sent = Buffer.from(await blob.arrayBuffer())
    assert.ok(sent.equals(bytes), '上传的字节必须与源 .ygbak 逐字节一致（未被字符串化破坏二进制）')
  }

  // 4.1) 可选前缀 FEISHU_BACKUP_UPLOAD_NAME_PREFIX 生效。
  {
    const { file } = writeFakeYgbak(tmpdir('prefix'))
    const f = makeMockFetch()
    const env = { ...FAKE_ENV, FEISHU_BACKUP_UPLOAD_NAME_PREFIX: 'prod-' }
    const result = await feishu.uploadBackupToFeishu({ backupFile: file, env, fetchImpl: f })
    assert.strictEqual(result.fileName, 'prod-' + path.basename(file), '前缀应拼到上传文件名')
    assert.strictEqual(f.calls.upload.opts.body.get('file_name'), 'prod-' + path.basename(file), 'form 的 file_name 应含前缀')
  }

  // 4.2) folder_token 容错：填整条飞书云盘文件夹 URL 也能自动抽出 token 用作 parent_node。
  {
    assert.strictEqual(feishu.extractFolderToken('https://x.feishu.cn/drive/folder/K8jwABC123?from=space'), 'K8jwABC123', 'URL 应抽出 folder token')
    assert.strictEqual(feishu.extractFolderToken('K8jwABC123'), 'K8jwABC123', '纯 token 应原样返回')
    const { file } = writeFakeYgbak(tmpdir('folderurl'))
    const f = makeMockFetch()
    const env = { ...FAKE_ENV, FEISHU_BACKUP_FOLDER_TOKEN: 'https://x.feishu.cn/drive/folder/FolderTokenFromUrl' }
    await feishu.uploadBackupToFeishu({ backupFile: file, env, fetchImpl: f })
    assert.strictEqual(f.calls.upload.opts.body.get('parent_node'), 'FolderTokenFromUrl', 'parent_node 应是从 URL 抽出的 token，而非整条 URL')
  }

  // 5) mock 飞书接口失败 → 抛错（非零退出）：分别覆盖 token code!=0、HTTP 非 2xx、upload code!=0。
  {
    const { file } = writeFakeYgbak(tmpdir('fail'))
    // 5a) token code != 0
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: file, env: FAKE_ENV,
        fetchImpl: makeMockFetch({ token: mockResponse(200, { code: 99991663, msg: 'app ticket invalid' }) }) }),
      /获取 tenant_access_token失败：code=99991663/, 'token code!=0 必须失败'
    )
    // 5b) token HTTP 500
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: file, env: FAKE_ENV,
        fetchImpl: makeMockFetch({ token: mockResponse(500, { msg: 'server error' }) }) }),
      /HTTP 500/, 'token HTTP 非 2xx 必须失败'
    )
    // 5c) upload code != 0
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: file, env: FAKE_ENV,
        fetchImpl: makeMockFetch({ upload: mockResponse(200, { code: 1061045, msg: 'forbidden' }) }) }),
      /上传文件到云盘失败：code=1061045/, 'upload code!=0 必须失败'
    )
    // 5d) upload 成功但缺 file_token
    await expectReject(
      feishu.uploadBackupToFeishu({ backupFile: file, env: FAKE_ENV,
        fetchImpl: makeMockFetch({ upload: mockResponse(200, { code: 0, data: {} }) }) }),
      /缺少 file_token/, 'upload 缺 file_token 必须失败'
    )
  }

  // 6) runBackup 配置 remoteCmd 时，会调用该脚本并把 BACKUP_FILE 传进去（注入 exec，不真正起进程）。
  {
    const dir = tmpdir('runbackup')
    const dataFile = path.join(dir, 'db.json')
    fs.writeFileSync(dataFile, JSON.stringify({ listings: [{ id: 'L1' }], footprints: [] }))
    let captured = null
    const rb = backup.runBackup({
      dataFile,
      stageDir: path.join(dir, 'backups'),
      passphrase: 'pw-feishu-test',
      now: Date.UTC(2026, 6, 6, 12, 0, 0),
      quiet: true,
      alertSink: () => {},
      remoteCmd: 'node scripts/upload-backup-to-feishu.js',
      exec: (cmd, env) => { captured = { cmd, env } }
    })
    assert.ok(rb.ok, '配置飞书上传命令且上传成功时备份应成功')
    assert.ok(captured, 'runBackup 应调用异地上传命令')
    assert.strictEqual(captured.cmd, 'node scripts/upload-backup-to-feishu.js', '应调用飞书上传脚本命令')
    assert.strictEqual(captured.env.BACKUP_FILE, rb.file, '应通过 BACKUP_FILE 环境变量把 .ygbak 路径传给上传脚本')
    assert.ok(/\.ygbak$/.test(captured.env.BACKUP_FILE), '传给上传脚本的应是 .ygbak 路径')
  }

  console.log('feishu-backup-v1-test passed')
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
