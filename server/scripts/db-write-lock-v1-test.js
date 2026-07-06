'use strict'

// P0-2 跨进程写锁 的锁定测试。
// 只用临时目录，不碰真实 db.json。核心：多进程并发 updateDb 时，锁开启不丢写（精确计数）。
// 另覆盖：进程内可重入、陈旧锁回收、获取超时（不死锁）、关闭开关退回旧行为、锁文件用完即清。

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const DB_PATH = path.resolve(__dirname, '..', 'src', 'db.js')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynzy-dblock-'))

// 进程内测试用固定数据文件（必须在 require db.js 前设好）。
process.env.DATA_FILE = path.join(tempRoot, 'inproc.json')
const db = require(DB_PATH)
const INPROC_LOCK = process.env.DATA_FILE + '.lock'

function writeWorker(k) {
  const wp = path.join(tempRoot, 'worker.js')
  fs.writeFileSync(wp, [
    'const db = require(' + JSON.stringify(DB_PATH) + ')',
    'const K = ' + k,
    'for (let i = 0; i < K; i++) {',
    '  try { db.updateDb(function (d) { d.counter = (d.counter || 0) + 1 }) }',
    '  catch (e) { process.stderr.write("WERR " + (e.code || "") + " " + e.message + "\\n"); process.exit(1) }',
    '}'
  ].join('\n'))
  return wp
}

function runConcurrent(dataFile, workerScript, nWorkers, extraEnv) {
  const kids = []
  for (let w = 0; w < nWorkers; w++) {
    kids.push(cp.spawn(process.execPath, [workerScript], {
      env: Object.assign({}, process.env, extraEnv, { DATA_FILE: dataFile }),
      stdio: ['ignore', 'ignore', 'pipe']
    }))
  }
  return Promise.all(kids.map((c) => new Promise((res) => {
    let err = ''
    if (c.stderr) c.stderr.on('data', (d) => { err += d })
    c.on('exit', (code) => res({ code, err: err.trim() }))
    c.on('error', (e) => res({ code: -1, err: String(e && e.message) }))
  })))
}

function readCounter(dataFile) {
  try { return (JSON.parse(fs.readFileSync(dataFile, 'utf8') || '{}').counter) || 0 } catch (e) { return -1 }
}

function resetLockEnv() {
  delete process.env.DB_WRITE_LOCK
  delete process.env.DB_LOCK_TIMEOUT_MS
  delete process.env.DB_LOCK_STALE_MS
}

async function run() {
  const N = 6
  const K = 100
  const EXPECT = N * K // 600

  // 1) 锁开启：多进程并发 updateDb 不丢写 → 精确等于 N*K。
  {
    const dataFile = path.join(tempRoot, 'lockon.json')
    fs.writeFileSync(dataFile, '{}')
    const worker = writeWorker(K)
    const results = await runConcurrent(dataFile, worker, N, { DB_WRITE_LOCK: '1' })
    assert.ok(results.every((r) => r.code === 0), 'worker 应全部正常退出，实得 ' + JSON.stringify(results))
    const got = readCounter(dataFile)
    assert.strictEqual(got, EXPECT, `锁开启时多进程并发写不得丢：期望 ${EXPECT} 实得 ${got}`)
    assert.ok(!fs.existsSync(dataFile + '.lock'), '结束后锁文件应被清理')
  }

  // 2) 对照——锁关闭：同样负载大概率丢写（演示缺口，不硬断言必丢以免偶发）。
  {
    const dataFile = path.join(tempRoot, 'lockoff.json')
    fs.writeFileSync(dataFile, '{}')
    const worker = writeWorker(K)
    await runConcurrent(dataFile, worker, N, { DB_WRITE_LOCK: '0' })
    const got = readCounter(dataFile)
    assert.ok(got <= EXPECT, '计数不应超过期望')
    console.log(`  [对照] 锁关闭多进程并发 → ${got}/${EXPECT}` + (got < EXPECT ? `（确认丢写 ${EXPECT - got} 次，印证缺口）` : '（本次恰好未丢）'))
  }

  // 3) 进程内可重入：mutator 里再调 updateDb 不自死锁。
  {
    process.env.DB_LOCK_TIMEOUT_MS = '1000' // 若重入失效，1s 超时抛错而非无限等
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    let inner = false
    db.updateDb((d) => {
      d.outer = 1
      db.updateDb((d2) => { d2.inner = 1; inner = true })
    })
    assert.ok(inner, '重入的内层 updateDb 应执行')
    assert.ok(!fs.existsSync(INPROC_LOCK), '重入结束后锁文件应清理')
    resetLockEnv()
  }

  // 4) 陈旧锁回收（liveness）：锁文件里的持有者 pid 已死 → 应回收后成功；另测内容缺失时的 age 兜底。
  {
    // 4a) 已死 pid（999999 几乎不可能存活）→ 按 liveness 回收，无需等 age。
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    fs.writeFileSync(INPROC_LOCK, '999999:0:x')
    db.updateDb((d) => { d.reclaimed = true })
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')).reclaimed, true, '已死 pid 的锁应按 liveness 回收')
    assert.ok(!fs.existsSync(INPROC_LOCK), '回收+释放后锁文件应清理')

    // 4b) 内容无 pid + 很旧 mtime → 走 age 兜底回收。
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    fs.writeFileSync(INPROC_LOCK, 'garbage-no-pid')
    const past = (Date.now() - 120000) / 1000
    fs.utimesSync(INPROC_LOCK, past, past)
    db.updateDb((d) => { d.reclaimed2 = true })
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')).reclaimed2, true, '无 pid 的陈旧锁应按 age 回收')
  }

  // 5) 获取超时：锁被另一个【存活】进程持有（liveness 绝不回收活锁）→ updateDb 超时抛错、不无限等。
  {
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    const sleeper = cp.spawn(process.execPath, ['-e', 'setTimeout(function(){}, 10000)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 150)) // 等子进程起来
    fs.writeFileSync(INPROC_LOCK, sleeper.pid + ':' + Date.now() + ':held') // 存活的“别的持有者”
    process.env.DB_LOCK_TIMEOUT_MS = '250'
    process.env.DB_LOCK_STALE_MS = '60000'
    const t0 = Date.now()
    let threw = false
    try {
      db.updateDb((d) => { d.shouldNotWrite = true })
    } catch (error) {
      threw = true
      assert.ok(/超时/.test(error.message), '应报获取写锁超时，实得：' + error.message)
    }
    const waited = Date.now() - t0
    assert.ok(threw, '锁被存活进程持有时必须超时抛错，不能无限等，也不能误删活锁')
    assert.ok(waited >= 200 && waited < 5000, `应约等待超时时长(250ms)后抛错，实等 ${waited}ms`)
    assert.ok(!('shouldNotWrite' in JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'))), '超时未拿到锁时不得写入')
    try { sleeper.kill() } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(INPROC_LOCK) } catch (e) { /* 清理手造锁 */ }
    resetLockEnv()
  }

  // 5.1) 锁内强制 fresh 读：本进程缓存了 X，磁盘被外部改成 Y，updateDb 必须读到 Y 不复用陈旧缓存。
  {
    db.writeDb({ marker: 'X', n: 1 }) // 本进程 parseCache=(K, {marker:X})
    fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ marker: 'Y', n: 2 })) // 外部改盘，绕过本进程缓存
    let seen = null
    db.updateDb((d) => { seen = d.marker })
    assert.strictEqual(seen, 'Y', 'updateDb 锁内必须读磁盘最新(Y)、不得复用本进程陈旧缓存(X)——防缓存键别名化丢写')
    resetLockEnv()
  }

  // 5.2) 真权限错误不死循环：openSync 对锁文件恒抛 EACCES（模拟目录只读），updateDb 必须超时抛错、
  //      绝不无 sleep 无超时自旋冻死单线程服务。
  {
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    process.env.DB_LOCK_TIMEOUT_MS = '300'
    const origOpen = fs.openSync
    fs.openSync = function (p) {
      if (String(p).endsWith('.lock')) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
      return origOpen.apply(fs, arguments)
    }
    const t0 = Date.now()
    let threw = false
    try {
      db.updateDb((d) => { d.x = 1 })
    } catch (error) {
      threw = true
      assert.ok(/超时/.test(error.message), '真权限错误应超时抛错，实得：' + error.message)
    } finally {
      fs.openSync = origOpen
    }
    const waited = Date.now() - t0
    assert.ok(threw, '真权限错误(openSync 恒 EACCES)必须超时抛错，绝不无限自旋冻死服务')
    assert.ok(waited >= 250 && waited < 5000, `应在超时(300ms)附近抛错、每轮 sleep 不自旋，实等 ${waited}ms`)
    try { fs.unlinkSync(INPROC_LOCK) } catch (e) { /* 忽略 */ }
    resetLockEnv()
  }

  // 6) 关闭开关：DB_WRITE_LOCK=0 → 正常写入、不创建锁文件（退回旧行为）。
  {
    fs.writeFileSync(process.env.DATA_FILE, '{}')
    process.env.DB_WRITE_LOCK = '0'
    db.updateDb((d) => { d.nolock = 1 })
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')).nolock, 1, '关闭锁时仍应正常写入')
    assert.ok(!fs.existsSync(INPROC_LOCK), '关闭锁开关时不应创建锁文件')
    resetLockEnv()
  }

  console.log('db-write-lock-v1-test passed')
}

run().then(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
}).catch((error) => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
