'use strict'

// 发布记录 record-release.js / show-releases.js 的锁定测试。覆盖：默认取 version.json commit、
// --commit 覆盖、scope 归一、缺 version 兜底 unknown、多条累积、坏行跳过、无敏感字段。

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const rr = require('./record-release')
const sr = require('./show-releases')

// 1) buildRecord：默认取 version.json commit、字段齐全、scope=targeted、files 拆分、时间可注入。
{
  const rec = rr.buildRecord(
    { scope: 'targeted', files: 'server/src/index.js, admin-web/index.html', verify: 'ok', note: '后台5项', by: 'claude' },
    { version: { commit: 'abcdef0123456789abcdef0123456789abcdef01', branch: 'v1-broker', version: '0.1.0' }, now: '2026-07-08T00:00:00.000Z', host: 'test-host' }
  )
  assert.strictEqual(rec.commit, 'abcdef0123456789abcdef0123456789abcdef01', 'commit 取 version.json')
  assert.strictEqual(rec.shortCommit, 'abcdef012345', 'shortCommit 前 12 位')
  assert.strictEqual(rec.scope, 'targeted', 'scope=targeted')
  assert.deepStrictEqual(rec.files, ['server/src/index.js', 'admin-web/index.html'], 'files 逗号拆分去空格')
  assert.strictEqual(rec.verify, 'ok', 'verify')
  assert.strictEqual(rec.t, '2026-07-08T00:00:00.000Z', '时间可注入')
  assert.strictEqual(rec.branch, 'v1-broker', 'branch 取 version.json')
  assert.strictEqual(rec.host, 'test-host', 'host 可注入')
  assert.strictEqual(rec.by, 'claude', 'by')
}

// 2) --commit 覆盖 version.json；scope=full。
{
  const rec = rr.buildRecord({ commit: 'HEADSHA1234567890', scope: 'full' }, { version: { commit: 'other' }, now: 't', host: 'h' })
  assert.strictEqual(rec.commit, 'HEADSHA1234567890', '--commit 覆盖')
  assert.strictEqual(rec.scope, 'full', 'scope=full')
}

// 3) 缺 version + 无 commit → unknown，不抛。
{
  const rec = rr.buildRecord({}, { version: {}, now: 't', host: 'h' })
  assert.strictEqual(rec.commit, 'unknown', '无来源 commit=unknown')
  assert.strictEqual(rec.shortCommit, 'unknown', 'shortCommit=unknown')
  assert.strictEqual(rec.scope, 'unknown', '无 scope=unknown')
}

// 4) appendRelease 累积多条 + readReleases 读回；中间坏行跳过不崩。
{
  const tmp = path.join(os.tmpdir(), 'ynzy-releases-' + process.pid + '.jsonl')
  try { fs.unlinkSync(tmp) } catch (error) { /* 忽略 */ }
  rr.appendRelease({ t: 't1', commit: 'c1', scope: 'full' }, tmp)
  rr.appendRelease({ t: 't2', commit: 'c2', scope: 'targeted' }, tmp)
  fs.appendFileSync(tmp, 'THIS IS A CORRUPT LINE\n')
  rr.appendRelease({ t: 't3', commit: 'c3', scope: 'full' }, tmp)
  const recs = sr.readReleases(tmp)
  assert.strictEqual(recs.length, 3, '坏行跳过，读回 3 条')
  assert.strictEqual(recs[0].commit, 'c1', '第 1 条')
  assert.strictEqual(recs[2].commit, 'c3', '第 3 条（坏行之后仍读到）')
  assert.ok(/scope=full/.test(sr.formatRelease(recs[0])), 'formatRelease 含 scope')
  fs.unlinkSync(tmp)
}

// 5) readReleases 对缺文件返回空数组、不抛。
{
  assert.deepStrictEqual(sr.readReleases(path.join(os.tmpdir(), 'ynzy-no-such-' + process.pid + '.jsonl')), [], '缺文件返回空数组')
}

// 6) 无敏感字段：记录键里不出现 key/secret/token/password 类。
{
  const rec = rr.buildRecord({ scope: 'full', note: 'x' }, { version: { commit: 'c' }, now: 't', host: 'h' })
  const bad = Object.keys(rec).filter((key) => /key|secret|token|password|pwd/i.test(key))
  assert.strictEqual(bad.length, 0, '发布记录不得含密钥类字段')
}

console.log('record-release-v1-test passed')
