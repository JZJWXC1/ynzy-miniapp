'use strict'

// 从飞书自动下载最新 .ygbak 再演练（完整闭环）的锁定测试。
// 红线：全程 mock 替代 fetch，绝不请求飞书公网；只用明显假凭据，不写真实 token / folder token。
// 覆盖：列文件夹→选最新 .ygbak→下载二进制→往返演练全通过；findLatestYgbak 选最新；
//       缺凭据/空文件夹/列举失败/下载失败/下载二进制逐字节一致 各分支。

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const feishu = require('../src/feishu-backup')
const backup = require('../src/backup')

const PW = 'feishu-drill-passphrase-兔子'
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0)
const FAKE_ENV = {
  FEISHU_BACKUP_APP_ID: 'mock-app-id',
  FEISHU_BACKUP_APP_SECRET: 'mock-app-secret-not-real',
  FEISHU_BACKUP_FOLDER_TOKEN: 'fake-folder-token-XXXX'
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ynzy-feishudrill-${tag}-`))
}

function sampleDb(nListings) {
  return {
    listings: Array.from({ length: nListings }, (_, i) => ({ id: 'L' + i })),
    users: [{ id: 'U1' }],
    clientReports: [],
    dealRecords: [{ id: 'D1' }],
    commissionRecords: [],
    footprints: [{ id: 'F1' }, { id: 'F2' }],
    favorites: [
      { id: 'FV1', userId: 'U1', listingId: 'L0' },
      { id: 'FV2', userId: 'U1', listingId: 'L1' }
    ]
  }
}

// 用 backup.createBackup 造一份真实加密 .ygbak，返回其文件名/字节/源计数。
function makeRealYgbak(dir, db, ms) {
  const dataFile = path.join(dir, 'src.json')
  fs.writeFileSync(dataFile, JSON.stringify(db))
  const r = backup.createBackup({ dataFile, stageDir: path.join(dir, 'stage'), passphrase: PW, now: ms })
  return { name: r.fileName, bytes: fs.readFileSync(r.file), counts: r.meta.counts }
}

function jsonResp(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body }
}
function binResp(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (/content-type/i.test(h) ? 'application/octet-stream' : '') },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer
  }
}

function makeMockFetch(opts = {}) {
  const {
    files = [],
    bytesByToken = {},
    token = jsonResp(200, { code: 0, tenant_access_token: 'mock-token', expire: 7200 }),
    list = jsonResp(200, { code: 0, data: { files, has_more: false } }),
    downloadOverride = null
  } = opts
  const calls = { all: [] }
  const impl = async (url) => {
    const u = String(url)
    calls.all.push(u)
    if (u.includes('/auth/v3/tenant_access_token/internal')) return token
    const dm = u.match(/\/drive\/v1\/files\/([^/?]+)\/download/)
    if (dm) {
      if (downloadOverride) return downloadOverride
      return binResp(bytesByToken[decodeURIComponent(dm[1])])
    }
    if (u.includes('/drive/v1/files') && u.includes('folder_token')) return list
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
  // 1) 完整闭环：文件夹里两份不同时间戳，下载最新那份并往返演练通过、计数吻合。
  {
    const dir = tmpdir('loop')
    const older = makeRealYgbak(dir, sampleDb(3), NOW - 6 * 3600000)
    const newer = makeRealYgbak(dir, sampleDb(5), NOW)
    const files = [{ token: 'tok-older', name: older.name }, { token: 'tok-newer', name: newer.name }]
    const f = makeMockFetch({ files, bytesByToken: { 'tok-older': older.bytes, 'tok-newer': newer.bytes } })
    const dest = path.join(dir, 'dl.ygbak')
    const dl = await feishu.downloadLatestBackup({ env: FAKE_ENV, fetchImpl: f, destPath: dest })
    assert.strictEqual(dl.name, newer.name, '应下载时间戳最新的 .ygbak')
    assert.ok(fs.existsSync(dest) && fs.readFileSync(dest).equals(newer.bytes), '下载落盘应与源字节一致')

    const drill = backup.restoreDrill({ backupFile: dest, passphrase: PW })
    assert.ok(drill.ok, '从飞书拉回的备份应能通过往返演练')
    assert.deepStrictEqual(drill.counts, newer.counts, '恢复计数应等于最新那份的源计数')
    assert.deepStrictEqual(
      drill.counts,
      { listings: 5, users: 1, reports: 0, deals: 1, commissionRecords: 0, footprints: 2, favorites: 2 },
      '七项计数逐项正确，飞书下载与解密恢复不得漏掉收藏'
    )
  }

  // 2) findLatestYgbak：忽略非 .ygbak 与越界文件名，选出最新。
  {
    const latest = feishu.findLatestYgbak([
      { token: 'a', name: backup.backupFileName(NOW - 86400000) },
      { token: 'b', name: backup.backupFileName(NOW) },
      { token: 'c', name: 'not-a-backup.txt' },
      { token: 'd', name: 'db-backup-20261306T000000Z.ygbak' } // 月13越界 → parseBackupTimeMs=null，忽略
    ])
    assert.ok(latest && latest.fileToken === 'b', 'findLatestYgbak 应选出时间戳最新的合法 .ygbak')
  }

  // 3) 缺飞书凭据 → 失败（不触网络）。
  {
    const f = makeMockFetch()
    await expectReject(
      feishu.downloadLatestBackup({ env: {}, fetchImpl: f, destPath: path.join(tmpdir('nocred'), 'x.ygbak') }),
      /缺少飞书备份凭据/, '缺凭据必须失败'
    )
    assert.strictEqual(f.calls.all.length, 0, '缺凭据时不得发起网络请求')
  }

  // 4) 文件夹里没有 .ygbak → 失败。
  {
    const f = makeMockFetch({ files: [{ token: 't', name: '别的文件.txt' }] })
    await expectReject(
      feishu.downloadLatestBackup({ env: FAKE_ENV, fetchImpl: f, destPath: path.join(tmpdir('empty'), 'x.ygbak') }),
      /没有可识别的 \.ygbak/, '无 .ygbak 必须失败'
    )
  }

  // 5) 列文件夹接口失败（code!=0）→ 失败。
  {
    const f = makeMockFetch({ list: jsonResp(200, { code: 1254005, msg: 'no permission' }) })
    await expectReject(
      feishu.downloadLatestBackup({ env: FAKE_ENV, fetchImpl: f, destPath: path.join(tmpdir('listfail'), 'x.ygbak') }),
      /列出云盘文件夹失败：code=1254005/, '列举失败必须抛错'
    )
  }

  // 6) 下载接口失败（返回 JSON 错误）→ 失败。
  {
    const dir = tmpdir('dlfail')
    const b = makeRealYgbak(dir, sampleDb(2), NOW)
    const f = makeMockFetch({ files: [{ token: 'tok', name: b.name }], downloadOverride: jsonResp(403, { code: 1061045, msg: 'forbidden' }) })
    await expectReject(
      feishu.downloadLatestBackup({ env: FAKE_ENV, fetchImpl: f, destPath: path.join(dir, 'x.ygbak') }),
      /下载云盘文件失败/, '下载失败必须抛错'
    )
  }

  // 7) downloadFile 二进制逐字节一致（含非 UTF-8 字节）。
  {
    const bytes = Buffer.from([0x59, 0x47, 0x42, 0x4b, 0x00, 0xff, 0xfe, 0x80])
    const f = makeMockFetch({ bytesByToken: { x: bytes } })
    const got = await feishu.downloadFile({ fileToken: 'x', token: 't', fetchImpl: f })
    assert.ok(Buffer.isBuffer(got) && got.equals(bytes), '下载的字节必须与源逐字节一致（二进制不被破坏）')
  }

  console.log('feishu-restore-drill-v1-test passed')
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
