'use strict'

// 版本追溯 version.js 的锁定测试。覆盖：三来源优先级（env > version.json > package.json）、
// 缺文件 / 坏 JSON / 非对象兜底、shortCommit 边界、getVersion 真实读取不抛且缓存生效。

const assert = require('assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const ver = require('../src/version')

// 1) env 优先级最高。
{
  const r = ver.computeVersion({
    env: { APP_VERSION: '9.9.9', APP_COMMIT: 'abcdef1234567890fedcba', APP_BRANCH: 'release', APP_BUILT_AT: '2026-01-01T00:00:00Z' },
    versionJson: { version: '2.0.0', commit: 'ffffffff', branch: 'x' },
    pkg: { version: '0.1.0' }
  })
  assert.strictEqual(r.version, '9.9.9', 'env version 优先')
  assert.strictEqual(r.commit, 'abcdef1234567890fedcba', 'env commit 优先')
  assert.strictEqual(r.shortCommit, 'abcdef123456', 'shortCommit 取前 12 位')
  assert.strictEqual(r.branch, 'release', 'env branch 优先')
  assert.strictEqual(r.builtAt, '2026-01-01T00:00:00Z', 'env builtAt 优先')
  assert.strictEqual(r.source, 'env', 'source=env')
}

// 2) version.json 次优先（无 env）。
{
  const r = ver.computeVersion({
    env: {},
    versionJson: { version: '2.3.4', commit: '1234567890abcdef', branch: 'v1-broker', builtAt: 'b', committedAt: 'c' },
    pkg: { version: '0.1.0' }
  })
  assert.strictEqual(r.version, '2.3.4', 'version.json version')
  assert.strictEqual(r.commit, '1234567890abcdef', 'version.json commit')
  assert.strictEqual(r.shortCommit, '1234567890ab', 'shortCommit 12 位')
  assert.strictEqual(r.branch, 'v1-broker', 'version.json branch')
  assert.strictEqual(r.committedAt, 'c', 'version.json committedAt')
  assert.strictEqual(r.source, 'version.json', 'source=version.json')
}

// 3) 兜底 package.json（无 env、无 version.json）。
{
  const r = ver.computeVersion({ env: {}, versionJson: null, pkg: { version: '0.1.0' } })
  assert.strictEqual(r.version, '0.1.0', '兜底 package.json version')
  assert.strictEqual(r.commit, 'unknown', '无来源 commit=unknown')
  assert.strictEqual(r.shortCommit, 'unknown', 'shortCommit=unknown')
  assert.strictEqual(r.source, 'package.json', 'source=package.json')
}

// 4) 全空也不抛，给出安全默认。
{
  const r = ver.computeVersion({})
  assert.strictEqual(r.version, '0.0.0', '全空 version=0.0.0')
  assert.strictEqual(r.commit, 'unknown', '全空 commit=unknown')
  assert.strictEqual(r.source, 'package.json', '全空 source=package.json')
}

// 5) readJsonSafe：缺文件 / 坏 JSON / 空 / 非对象一律返回 null 不抛。
{
  assert.strictEqual(ver.readJsonSafe(path.join(os.tmpdir(), 'ynzy-no-such-' + process.pid + '.json')), null, '缺文件返回 null')
  const tmp = path.join(os.tmpdir(), 'ynzy-ver-bad-' + process.pid + '.json')
  fs.writeFileSync(tmp, '{ not json ')
  assert.strictEqual(ver.readJsonSafe(tmp), null, '坏 JSON 返回 null')
  fs.writeFileSync(tmp, '   ')
  assert.strictEqual(ver.readJsonSafe(tmp), null, '空白返回 null')
  fs.writeFileSync(tmp, '"just a string"')
  assert.strictEqual(ver.readJsonSafe(tmp), null, '非对象返回 null')
  fs.writeFileSync(tmp, '{"version":"1.2.3"}')
  assert.deepStrictEqual(ver.readJsonSafe(tmp), { version: '1.2.3' }, '合法对象正常解析')
  fs.unlinkSync(tmp)
}

// 6) shortOf 边界。
{
  assert.strictEqual(ver.shortOf(''), 'unknown', '空 → unknown')
  assert.strictEqual(ver.shortOf(null), 'unknown', 'null → unknown')
  assert.strictEqual(ver.shortOf('unknown'), 'unknown', 'unknown → unknown')
  assert.strictEqual(ver.shortOf('abcdef1234567890abcdef'), 'abcdef123456', '长 SHA 截 12 位')
  assert.strictEqual(ver.shortOf('abc'), 'abc', '短于 12 位原样')
}

// 7) getVersion 真实读取：不抛、含全部字段、缓存返回同一对象。
{
  delete process.env.APP_VERSION
  delete process.env.APP_COMMIT
  delete process.env.APP_BRANCH
  delete process.env.APP_BUILT_AT
  ver.resetCacheForTest()
  const v = ver.getVersion()
  for (const k of ['version', 'commit', 'shortCommit', 'branch', 'builtAt', 'committedAt', 'source']) {
    assert.ok(k in v, 'getVersion 应含字段 ' + k)
  }
  assert.ok(/^\d+\.\d+\.\d+/.test(v.version), 'version 形如 x.y.z，实际=' + v.version)
  assert.strictEqual(ver.getVersion(), v, '缓存生效：二次调用返回同一对象')
}

console.log('version-v1-test passed')
